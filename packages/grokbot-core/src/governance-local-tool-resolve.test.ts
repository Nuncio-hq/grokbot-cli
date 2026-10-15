import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GrokBotError } from "./contracts.js";
import { governanceRunner, STAFF } from "./fixtures/governance-test-kit.js";
import { sendMessageRow } from "./fixtures/wire-entries.js";

const localToolRow = sendMessageRow(8, {
  type: "local-tool-permission",
  ask: {
    requestId: "lt-1",
    action: "run-command",
    target: "ls",
    status: "pending",
  },
});
const transcript = [{ entries: [localToolRow] }];
const kept = {
  id: "old",
  action: "read-file",
  target: "/x",
  resourcePath: "/Users/owner/x",
};

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "grokbot-gov-"));
  path = join(dir, "local-tool-approvals.json");
  await writeFile(path, JSON.stringify({ approvals: [kept] }));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const onDisk = () => readFile(path, "utf8").then(JSON.parse);
const approvals = () => ({
  path,
  readActiveAccountScope: async () => "scope-1",
});

describe("approve and deny a local-tool card", () => {
  it("writes the Mac approvals file before allowing, keeps other entries whole, and never writes on deny", async () => {
    const seenAtResolve: unknown[] = [];
    const { run, log } = governanceRunner(
      {
        ListGrokBotTranscriptEntries: transcript,
        ResolveGrokBotLocalToolPermission: async () => {
          seenAtResolve.push(await onDisk());
          return { dispatched: true };
        },
      },
      {},
      { approvals: approvals() },
    );
    const denied = await run("deny", { agent: STAFF, yes: true, json: false });
    const allowed = await run("approve", {
      agent: STAFF,
      always: false,
      yes: true,
      json: false,
    });
    expect([
      denied.wroteLocalApproval,
      allowed.wroteLocalApproval,
      seenAtResolve,
      log
        .filter((c) => c.method.startsWith("Resolve"))
        .map((c) => [c.body.resolution, c.confirmed]),
    ]).toEqual([
      false,
      true,
      [
        { approvals: [kept] },
        {
          approvals: [
            kept,
            {
              id: "lt-1",
              action: "run-command",
              target: "ls",
              accountScope: "scope-1",
            },
          ],
        },
      ],
      [
        [2, true],
        [1, true],
      ],
    ]);
  });

  it("takes back the entry it added when the server does not dispatch the allow", async () => {
    const { run } = governanceRunner(
      {
        ListGrokBotTranscriptEntries: transcript,
        ResolveGrokBotLocalToolPermission: [
          { dispatched: false, refusal: { message: "Expired" } },
        ],
      },
      {},
      { approvals: approvals() },
    );
    const error = await run("approve", {
      agent: STAFF,
      always: false,
      yes: true,
      json: false,
    }).catch((e: unknown) => e);
    expect([
      error instanceof GrokBotError ? [error.code, error.message] : error,
      await onDisk(),
    ]).toEqual([
      [
        "protocol",
        "ResolveGrokBotLocalToolPermission did not resolve card entry-8: Expired",
      ],
      { approvals: [kept] },
    ]);
  });
});
