import { describe, expect, it } from "vitest";
import { IDLE_STATUS, type LiveStatus } from "./agent-status.js";
import { summary, verdict } from "./fixtures/done-rule-summary.js";
import {
  sendMessageRow,
  textReplyRow,
  userRow,
} from "./fixtures/wire-entries.js";

const RUNNING: LiveStatus = { ...IDLE_STATUS, isRunning: true };
const echo = userRow(10, "draw it", { clientNonce: "m-1" });
const visual = (seq: number, title: string, extra = {}) =>
  sendMessageRow(seq, {
    type: "visualization",
    title,
    documentSha256: "a".repeat(64),
    heightPx: 320,
    ...extra,
  });
const file = (seq: number, fileName?: string) =>
  sendMessageRow(seq, {
    type: "attachment",
    url: "https://files.example/f?sig=secret",
    ...(fileName !== undefined && { file_name: fileName }),
  });

describe("Done Rule on a turn whose only output is a visual or a file", () => {
  it("ends on a visual with a marker that names its title", () => {
    expect(summary([echo, visual(11, "Sales by region")], IDLE_STATUS)).toBe(
      "done:[visual: Sales by region]",
    );
  });

  it("ends on an attachment with a marker that names its file, never its link", () => {
    const v = verdict([echo, file(11, "report.pdf")], IDLE_STATUS);
    expect(v.status === "done" && v.finalReply).toBe("[file: report.pdf]");
    expect(JSON.stringify(v.status === "done" && v.finalReply)).not.toContain(
      "secret",
    );
  });

  it("falls back to a bare marker when the title or file name is empty", () => {
    expect(summary([echo, visual(11, "  ")], IDLE_STATUS)).toBe(
      "done:[visual]",
    );
    expect(summary([echo, file(11)], IDLE_STATUS)).toBe("done:[file]");
  });

  it("takes the last finished one when several follow", () => {
    expect(
      summary([echo, visual(11, "First"), file(12, "b.png")], IDLE_STATUS),
    ).toBe("done:[file: b.png]");
    expect(
      summary([echo, file(11, "a.png"), visual(12, "Second")], IDLE_STATUS),
    ).toBe("done:[visual: Second]");
  });

  it("keeps the visual among the replies of the verdict", () => {
    const v = verdict([echo, visual(11, "Chart")], IDLE_STATUS);
    expect(v.status === "done" && v.replies.map((r) => r.reply)).toEqual([
      { type: "visualization", title: "Chart", documentSha256: "a".repeat(64) },
    ]);
  });

  it("does not end while the bot is still running", () => {
    expect(summary([echo, visual(11, "Chart")], RUNNING)).toBe(
      "running:target-active",
    );
    expect(summary([echo, file(11, "a.png")], RUNNING)).toBe(
      "running:target-active",
    );
  });

  it("does not end on a visual the bot is still writing", () => {
    const streaming = visual(11, "Chart", {});
    const row = {
      ...streaming,
      body: Buffer.from(
        JSON.stringify({
          ...JSON.parse(Buffer.from(streaming.body ?? "", "base64").toString()),
          isStreaming: true,
        }),
      ).toString("base64"),
    };
    expect(summary([echo, row], IDLE_STATUS)).toBe(
      "running:awaiting-final-reply",
    );
  });

  it("still waits when the turn has no output at all", () => {
    expect(summary([echo], IDLE_STATUS)).toBe("running:awaiting-final-reply");
  });
});

describe("Done Rule when text and media share a turn", () => {
  it("lets text after a visual win", () => {
    expect(
      summary(
        [echo, visual(11, "Chart"), textReplyRow(12, "Here is the chart")],
        IDLE_STATUS,
      ),
    ).toBe("done:Here is the chart");
  });

  it("lets text before a visual win too", () => {
    expect(
      summary(
        [echo, textReplyRow(11, "Here is the chart"), visual(12, "Chart")],
        IDLE_STATUS,
      ),
    ).toBe("done:Here is the chart");
  });

  it("leaves a visual out of a shared turn's reply text when text answered it", () => {
    const rows = [echo, textReplyRow(11, "Working on it"), visual(12, "Chart")];
    const busyWhenSent = new Map([["m-1", true]]);
    const v = verdict(rows, IDLE_STATUS, "m-1", busyWhenSent);
    expect(v.status === "ambiguous" && v.replyText).toBe("Working on it");
  });

  it("ends a shared turn that holds only a visual with its marker as the reply text", () => {
    const busyWhenSent = new Map([["m-1", true]]);
    const v = verdict(
      [echo, visual(11, "Chart")],
      IDLE_STATUS,
      "m-1",
      busyWhenSent,
    );
    expect(v.status === "ambiguous" && v.replyText).toBe("[visual: Chart]");
  });
});
