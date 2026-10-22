import { describe, expect, it } from "vitest";
import { GrokBotError } from "./contracts.js";
import { parseConversationSearch } from "./conversation-search.js";
import {
  PRIMARY,
  realGovernanceRunner,
} from "./fixtures/governance-test-kit.js";

const hit = (seq: number, role = "assistant") => ({
  entryId: `t${seq}`,
  seq,
  role,
  timestampMs: 1792556842913,
  snippet: `…hit ${seq}`,
});

const failure = async (promise: Promise<unknown>) => {
  const error = await promise.catch((e: unknown) => e);
  return error instanceof GrokBotError ? [error.code, error.message] : error;
};

describe("parseConversationSearch", () => {
  it("reads a gateway reply as it comes, newest first", () => {
    expect(
      parseConversationSearch(
        { matches: [hit(425), hit(424, "user")], isComplete: true },
        20,
      ),
    ).toEqual({
      matches: [
        {
          entryId: "t425",
          seq: 425,
          role: "assistant",
          timestampMs: 1792556842913,
          snippet: "…hit 425",
        },
        {
          entryId: "t424",
          seq: 424,
          role: "user",
          timestampMs: 1792556842913,
          snippet: "…hit 424",
        },
      ],
      isComplete: true,
    });
  });

  it("keeps a match without a time or snippet", () => {
    expect(
      parseConversationSearch(
        { matches: [{ entryId: "t1", seq: 1, role: "user" }] },
        20,
      ).matches,
    ).toEqual([
      {
        entryId: "t1",
        seq: 1,
        role: "user",
        timestampMs: undefined,
        snippet: "",
      },
    ]);
  });

  it("returns an empty page without a next page", () => {
    expect(
      parseConversationSearch({ matches: [], isComplete: true }, 20),
    ).toEqual({ matches: [], isComplete: true });
  });

  describe("next page", () => {
    // Live, on a bot with five or more PONG messages: limit 1 returned one match with
    // isComplete true, and beforeSeq of its seq returned the next older one. So a full page,
    // not isComplete, is what says older matches may follow.
    it.each([
      ["a full page", [hit(425), hit(424), hit(420)], true, 3, 420],
      ["a page longer than the limit", [hit(9), hit(7)], true, 1, 7],
      ["a full page of one", [hit(425)], true, 1, 425],
      [
        "a short page the gateway calls incomplete",
        [hit(30), hit(12)],
        false,
        20,
        12,
      ],
    ])("is the lowest seq on %s", (_label, matches, isComplete, limit, seq) => {
      expect(
        parseConversationSearch({ matches, isComplete }, limit).nextBeforeSeq,
      ).toBe(seq);
    });

    it.each([
      ["a short page", [hit(425), hit(424)], true, 20],
      ["an empty page the gateway calls incomplete", [], false, 20],
    ])("is absent on %s", (_label, matches, isComplete, limit) => {
      expect(
        parseConversationSearch({ matches, isComplete }, limit),
      ).not.toHaveProperty("nextBeforeSeq");
    });

    it("takes the lowest seq whatever the order of the page", () => {
      expect(
        parseConversationSearch(
          { matches: [hit(3), hit(9), hit(5)], isComplete: true },
          3,
        ).nextBeforeSeq,
      ).toBe(3);
    });
  });

  it.each([
    ["a reply that is not an object", "nope"],
    ["a reply without matches", { isComplete: true }],
  ])("reports %s as a protocol break", (_label, reply) => {
    expect(() => parseConversationSearch(reply, 20)).toThrow(
      new GrokBotError(
        "protocol",
        "searchConversation: the reply has no matches list.",
      ),
    );
  });

  it.each([
    ["a match without an entryId", { seq: 1, role: "user" }],
    ["a match without a seq", { entryId: "t1", role: "user" }],
    ["a match with a fractional seq", { entryId: "t1", seq: 1.5 }],
    ["a match that is not an object", "t1"],
  ])("reports %s as a protocol break", (_label, match) => {
    expect(() =>
      parseConversationSearch({ matches: [match], isComplete: true }, 20),
    ).toThrow(
      new GrokBotError(
        "protocol",
        "searchConversation: a match has no entryId and seq.",
      ),
    );
  });
});

describe("search", () => {
  const input = {
    query: "PONG",
    limit: 20,
    before: undefined,
    agent: "Primary Test",
    json: false,
  } as const;

  it("asks the gateway for the bot's matches, unconfirmed, without a cursor by default", async () => {
    const { runner, log } = realGovernanceRunner(
      {},
      { searchConversation: [{ matches: [hit(425)], isComplete: true }] },
    );
    const out = await runner.run("search", input);
    expect(out).toEqual({
      agent: expect.objectContaining({
        agentId: PRIMARY,
        name: "Primary Test",
      }),
      query: "PONG",
      matches: [expect.objectContaining({ entryId: "t425", seq: 425 })],
      isComplete: true,
    });
    expect(log.filter((call) => call.via === "gateway")).toEqual([
      {
        via: "gateway",
        method: "searchConversation",
        body: { agentId: PRIMARY, query: "PONG", limit: 20 },
        confirmed: false,
      },
    ]);
  });

  it("sends the limit and the before cursor it was given", async () => {
    const { runner, log } = realGovernanceRunner(
      {},
      { searchConversation: [{ matches: [], isComplete: true }] },
    );
    const out = await runner.run("search", { ...input, limit: 1, before: 425 });
    expect(out).toMatchObject({ matches: [], isComplete: true });
    expect(log.find((call) => call.via === "gateway")?.body).toEqual({
      agentId: PRIMARY,
      query: "PONG",
      limit: 1,
      beforeSeq: 425,
    });
  });

  it("hands back the cursor that reads the next page", async () => {
    const { runner, log } = realGovernanceRunner(
      {},
      {
        searchConversation: (body) => ({
          matches:
            body.beforeSeq === undefined ? [hit(425)] : [hit(424, "user")],
          isComplete: true,
        }),
      },
    );
    const first = await runner.run("search", { ...input, limit: 1 });
    expect(first.nextBeforeSeq).toBe(425);
    const second = await runner.run("search", {
      ...input,
      limit: 1,
      before: first.nextBeforeSeq,
    });
    expect(second.matches.map((m) => m.seq)).toEqual([424]);
    expect(
      log
        .filter((call) => call.via === "gateway")
        .map((call) => call.body.beforeSeq),
    ).toEqual([undefined, 425]);
  });

  it("says nothing more follows a short page", async () => {
    const { runner } = realGovernanceRunner(
      {},
      { searchConversation: [{ matches: [hit(425)], isComplete: true }] },
    );
    expect(await runner.run("search", input)).not.toHaveProperty(
      "nextBeforeSeq",
    );
  });

  it("reports a reply without matches as a protocol break", async () => {
    const { runner } = realGovernanceRunner(
      {},
      { searchConversation: [{ ok: true }] },
    );
    expect(await failure(runner.run("search", input))).toEqual([
      "protocol",
      "searchConversation: the reply has no matches list.",
    ]);
  });
});
