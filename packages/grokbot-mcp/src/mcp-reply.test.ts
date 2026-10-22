import { describe, expect, it } from "vitest";
import { exchange, fakeRunner, PRIMARY_TEST } from "./fixtures/mcp-session.js";

const reply = {
  jobId: "job-2",
  agent: PRIMARY_TEST,
  replyToId: "t5s2",
  outcome: { status: "done", finalReply: "Got it.", replies: [] },
};

const call = (name: string, args: object) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name, arguments: args },
});

describe("grokbot_reply over MCP", () => {
  it("is listed as a write tool with the CLI's inputs and a 45 s default wait", async () => {
    const [response] = await exchange(
      fakeRunner(() => Promise.resolve(reply)).runner,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
    );
    expect(response).toMatchObject({
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({
            name: "grokbot_reply",
            annotations: { readOnlyHint: false, destructiveHint: false },
            inputSchema: expect.objectContaining({
              required: ["text"],
              additionalProperties: false,
              properties: {
                job: { type: "string", description: expect.any(String) },
                text: { type: "string", description: expect.any(String) },
                to: { type: "string", description: expect.any(String) },
                timeout: {
                  type: "integer",
                  description: expect.any(String),
                  default: 45,
                  minimum: 1,
                },
                now: {
                  type: "boolean",
                  description: expect.any(String),
                  default: false,
                },
                agent: { type: "string", description: expect.any(String) },
              },
            }),
          }),
        ]),
      },
    });
  });

  it("runs reply with job and text, and summarises the bot's answer", async () => {
    const { runner, calls } = fakeRunner(() => Promise.resolve(reply));
    const messages = await exchange(
      runner,
      call("grokbot_reply", { job: "job-1", text: "Yes, the second one" }),
    );
    expect(calls.map(({ name, input }) => ({ name, input }))).toEqual([
      {
        name: "reply",
        input: {
          job: "job-1",
          text: "Yes, the second one",
          timeout: 45,
          now: false,
          json: false,
        },
      },
    ]);
    expect(messages).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [{ type: "text", text: "Primary Test replied:\nGot it." }],
          structuredContent: reply,
        },
      },
    ]);
  });

  it("passes to and agent through when there is no job", async () => {
    const { runner, calls } = fakeRunner(() => Promise.resolve(reply));
    await exchange(
      runner,
      call("grokbot_reply", {
        text: "Looks good",
        to: "t4s1",
        agent: "Primary Test",
      }),
    );
    expect(calls[0]?.input).toEqual({
      text: "Looks good",
      to: "t4s1",
      agent: "Primary Test",
      timeout: 45,
      now: false,
      json: false,
    });
  });

  it("refuses a call without text before the runner runs", async () => {
    const { runner, calls } = fakeRunner(() => Promise.resolve(reply));
    const [response] = await exchange(
      runner,
      call("grokbot_reply", { job: "job-1" }),
    );
    expect([calls, response]).toMatchObject([
      [],
      { result: { isError: true } },
    ]);
  });

  it("shows each tail row's entryId so a client can pass it as to", async () => {
    const entries = [
      {
        seq: "7",
        updatedSeq: "7",
        entryId: "t4s1",
        entryKind: "send-message",
        requestId: undefined,
        timestampMs: undefined,
        kind: "reply",
        reply: { type: "text", content: "Question?" },
      },
    ];
    const [response] = await exchange(
      fakeRunner(() => Promise.resolve({ agent: PRIMARY_TEST, entries }))
        .runner,
      call("grokbot_tail", {}),
    );
    expect(response).toMatchObject({
      result: { content: [{ text: expect.stringContaining("t4s1") }] },
    });
  });
});
