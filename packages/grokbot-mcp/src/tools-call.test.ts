import { GrokBotError } from "grokbot-core";
import { describe, expect, it } from "vitest";
import {
  exchange,
  fakeRunner,
  PRIMARY_TEST,
  startSession,
  unusedRunner,
} from "./fixtures/mcp-session.js";

const call = (id: number, name: string, args?: unknown) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: args === undefined ? { name } : { name, arguments: args },
});

describe("grokbot-mcp tools/call", () => {
  it("runs the command and returns a summary plus the typed output", async () => {
    const output = {
      jobId: "job-1",
      agent: PRIMARY_TEST,
      outcome: { status: "done", finalReply: "PONG", replies: [] },
    };
    const { runner, calls } = fakeRunner(() => Promise.resolve(output));
    const messages = await exchange(
      runner,
      call(1, "grokbot_ask", { text: "ping", agent: "Primary Test" }),
    );
    expect(calls.map(({ name, input }) => ({ name, input }))).toEqual([
      {
        name: "ask",
        input: {
          text: "ping",
          timeout: 45,
          agent: "Primary Test",
          json: false,
        },
      },
    ]);
    expect(messages).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [{ type: "text", text: "Primary Test replied:\nPONG" }],
          structuredContent: output,
        },
      },
    ]);
  });

  it("keeps a timeout the client passes, and the CLI default for wait", async () => {
    const { runner, calls } = fakeRunner(() => Promise.reject(new Error("x")));
    await exchange(
      runner,
      call(1, "grokbot_ask", { text: "ping", timeout: 600 }),
      call(2, "grokbot_ask", { text: "ping", timeout: "" }),
      call(3, "grokbot_wait", { job: "job-1" }),
    );
    expect(calls.map((c) => [c.name, c.input])).toEqual([
      ["ask", { text: "ping", timeout: 600, json: false }],
      ["ask", { text: "ping", timeout: 45, json: false }],
      ["wait", { job: "job-1", timeout: 600, json: false }],
    ]);
  });

  it("reports pending and awaiting-approval asks as results with the job id", async () => {
    const outcomes = [
      { status: "pending", reason: "timed out after 600s" },
      { status: "awaiting-approval", reason: "secret-request", cards: [] },
    ];
    const { runner } = fakeRunner(() =>
      Promise.resolve({
        jobId: `job-${outcomes.length}`,
        agent: PRIMARY_TEST,
        outcome: outcomes.shift(),
      }),
    );
    const session = startSession(runner);
    session.send(call(1, "grokbot_ask", { text: "deploy" }));
    session.send(call(2, "grokbot_ask", { text: "deploy" }));
    const texts = (await session.close()).map(
      (m) =>
        (m as { result: { content: { text: string }[]; isError?: boolean } })
          .result,
    );
    expect(texts.map((r) => [r.content[0]?.text, r.isError])).toEqual([
      [
        'Primary Test is still working (timed out after 600s). Job job-2 is saved; call grokbot_wait with {"job":"job-2"} to keep waiting.',
        undefined,
      ],
      [
        'Primary Test is waiting for owner approval (secret-request). Approve it in the Grok Bot app, then call grokbot_wait with {"job":"job-1"}.',
        undefined,
      ],
    ]);
  });

  it("turns input validation errors into an error result without running", async () => {
    const { runner, calls } = fakeRunner(() => Promise.resolve({}));
    const messages = await exchange(
      runner,
      call(2, "grokbot_ask", { timeout: 0 }),
    );
    expect(calls).toEqual([]);
    expect(messages).toEqual([
      {
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [
            {
              type: "text",
              text: 'ask: missing required parameter "text"\nask: parameter "timeout" must be at least 1, got 0',
            },
          ],
          isError: true,
        },
      },
    ]);
  });

  it("maps a GrokBotError from the runner to an error result", async () => {
    const { runner } = fakeRunner(() =>
      Promise.reject(
        new GrokBotError("not-found", 'No agent matches "nobody"'),
      ),
    );
    const messages = await exchange(
      runner,
      call(3, "grokbot_tail", { agent: "nobody" }),
    );
    expect(messages).toEqual([
      {
        jsonrpc: "2.0",
        id: 3,
        result: {
          content: [{ type: "text", text: 'No agent matches "nobody"' }],
          isError: true,
        },
      },
    ]);
  });

  it("rejects unknown tools and malformed params as protocol errors", async () => {
    const messages = await exchange(
      unusedRunner,
      call(4, "grokbot_delete", {}),
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: {} },
      call(6, "grokbot_agents", ["positional"]),
    );
    expect(messages).toEqual([
      {
        jsonrpc: "2.0",
        id: 4,
        error: { code: -32602, message: "Unknown tool: grokbot_delete" },
      },
      {
        jsonrpc: "2.0",
        id: 5,
        error: {
          code: -32602,
          message: "Invalid params: name must be a string",
        },
      },
      {
        jsonrpc: "2.0",
        id: 6,
        error: {
          code: -32602,
          message: "Invalid params: arguments must be an object",
        },
      },
    ]);
  });

  it("answers an unexpected runner failure with -32603 and logs it to stderr", async () => {
    const { runner } = fakeRunner(() => Promise.reject(new TypeError("boom")));
    const session = startSession(runner);
    session.send(call(9, "grokbot_agents"));
    expect(await session.close()).toEqual([
      {
        jsonrpc: "2.0",
        id: 9,
        error: { code: -32603, message: "Internal error" },
      },
    ]);
    expect(session.logs).toEqual(["tools/call 9 failed: TypeError: boom"]);
  });
});
