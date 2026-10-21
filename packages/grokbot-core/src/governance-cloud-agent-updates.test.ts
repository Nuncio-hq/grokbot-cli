import { describe, expect, it } from "vitest";
import {
  BC_A,
  BC_B,
  composerRow,
  eventFrame,
  heartbeatFrame,
  snapshotFrame,
  WORKFLOW,
} from "./fixtures/cloud-agent-kit.js";
import {
  applyChange,
  type CloudAgentWatch,
  judgeWatch,
  needsYouReason,
  parseUpdateFrame,
} from "./governance-cloud-agent-updates.js";

const UPDATE = "BACKGROUND_COMPOSER_UPDATE_KIND_";
const APPROVAL = "BACKGROUND_COMPOSER_APPROVAL_";

const watching = (over: Partial<CloudAgentWatch> = {}): CloudAgentWatch => ({
  status: "running",
  needsYou: false,
  ...over,
});

describe("parseUpdateFrame", () => {
  it("reads the cursor of every kind of frame", () => {
    expect([
      parseUpdateFrame(snapshotFrame([], {}, "s1"), BC_A).cursor,
      parseUpdateFrame(eventFrame(BC_A, {}, "e1"), BC_A).cursor,
      parseUpdateFrame(heartbeatFrame("h1"), BC_A).cursor,
      parseUpdateFrame({}, BC_A).cursor,
      parseUpdateFrame("not a frame", BC_A).cursor,
    ]).toEqual(["s1", "e1", "h1", undefined, undefined]);
  });

  it("says nothing about the agent for a heartbeat, a snapshot without its row, or another agent's event", () => {
    expect([
      parseUpdateFrame(heartbeatFrame(), BC_A).change,
      parseUpdateFrame(snapshotFrame([composerRow(BC_B)]), BC_A).change,
      parseUpdateFrame(eventFrame(BC_B, { hasPendingInteraction: true }), BC_A)
        .change,
    ]).toEqual([undefined, undefined, undefined]);
  });

  it("reads status and the flag from the snapshot row of the agent", () => {
    const row = composerRow(BC_A, {
      workflowStatus: `${WORKFLOW}RUNNING`,
      hasPendingInteraction: true,
    });
    expect(parseUpdateFrame(snapshotFrame([row]), BC_A).change).toMatchObject({
      status: "running",
      needsYou: true,
    });
  });

  it("reads a missing flag as false, since the server leaves false values out", () => {
    expect(parseUpdateFrame(eventFrame(BC_A, {}), BC_A).change).toMatchObject({
      needsYou: false,
    });
  });

  it("takes no status from an approval change, nor from an event without an update time", () => {
    const approvalChange = eventFrame(BC_A, {
      kind: `${UPDATE}APPROVAL_CHANGED`,
      workflowStatus: `${WORKFLOW}ERROR`,
    });
    const untimed = eventFrame(BC_A, {
      workflowStatus: `${WORKFLOW}ERROR`,
      updatedAtMs: undefined,
    });
    expect([
      parseUpdateFrame(approvalChange, BC_A).change?.status,
      parseUpdateFrame(untimed, BC_A).change?.status,
    ]).toEqual([undefined, undefined]);
  });
});

describe("applyChange", () => {
  const pending = parseUpdateFrame(
    eventFrame(BC_A, {
      kind: `${UPDATE}APPROVAL_CHANGED`,
      approval: {
        approvalId: "ap-1",
        state: `${APPROVAL}STATE_PENDING`,
        kind: `${APPROVAL}KIND_MCP_TOOL`,
        headline: "Allow it",
      },
    }),
    BC_A,
  ).change;

  it("tracks a pending approval, and drops it when an approval change settles it", () => {
    const waiting = applyChange(watching(), pending ?? {});
    expect(waiting.approval).toMatchObject({ id: "ap-1", kind: "mcp_tool" });
    const settled = parseUpdateFrame(
      eventFrame(BC_A, {
        kind: `${UPDATE}APPROVAL_CHANGED`,
        approval: {
          approvalId: "ap-1",
          state: `${APPROVAL}STATE_DENIED`,
        },
      }),
      BC_A,
    ).change;
    expect(applyChange(waiting, settled ?? {})).toEqual({
      status: "running",
      needsYou: false,
    });
  });

  it("keeps the approval over an event that carries none while something is still pending", () => {
    const waiting = applyChange(watching(), pending ?? {});
    const other = parseUpdateFrame(
      eventFrame(BC_A, { hasPendingInteraction: true }),
      BC_A,
    ).change;
    expect(applyChange(waiting, other ?? {}).approval).toBeDefined();
  });

  it("keeps what it knew for what the change leaves unsaid", () => {
    expect(
      applyChange(watching({ status: "running", needsYou: true }), {}),
    ).toEqual({ status: "running", needsYou: true });
  });
});

describe("judgeWatch", () => {
  it.each([
    ["running", undefined],
    ["creating", undefined],
    ["finished", { status: "done" }],
    ["unknown", { status: "done" }],
  ] as const)("judges a plain %s agent as %j", (status, outcome) => {
    expect(judgeWatch(watching({ status }))).toEqual(outcome);
  });

  it("puts a wait on the user before a stop, but an error or expiry before the wait", () => {
    const flagged = { needsYou: true } as const;
    expect([
      judgeWatch(watching({ ...flagged, status: "running" }))?.status,
      judgeWatch(watching({ ...flagged, status: "finished" }))?.status,
      judgeWatch(watching({ ...flagged, status: "error" }))?.status,
      judgeWatch(watching({ ...flagged, status: "expired" }))?.status,
    ]).toEqual(["needs-you", "needs-you", "done", "done"]);
  });

  it("counts an approval alone as a wait on the user", () => {
    const approval = {
      id: "ap-1",
      kind: "mcp_tool",
      headline: "Allow it",
      operation: "",
      target: "",
      expiresAtMs: null,
    };
    expect(judgeWatch(watching({ approval }))).toMatchObject({
      status: "needs-you",
      approval,
    });
  });
});

describe("needsYouReason", () => {
  const approval = {
    id: "ap-1",
    kind: "",
    headline: "",
    operation: "",
    target: "",
    expiresAtMs: null,
  };

  it("says what the approval is for, on one line and bounded", () => {
    const long = `Allow\n${"x".repeat(500)}`;
    const reason = needsYouReason({ ...approval, headline: long });
    expect(reason).not.toContain("\n");
    expect(reason.length).toBeLessThan(300);
  });

  it("still says something when the approval has no words, and when there is no approval", () => {
    expect(needsYouReason(approval).length).toBeGreaterThan(0);
    expect(needsYouReason().length).toBeGreaterThan(0);
  });
});
