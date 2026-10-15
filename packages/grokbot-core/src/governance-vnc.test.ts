import { describe, expect, it } from "vitest";
import { GrokBotError } from "./contracts.js";
import { governanceRunner } from "./fixtures/governance-test-kit.js";

describe("vnc", () => {
  const ensure = {
    vncUrl: "https://box.example/vnc.html?resume_lower_s=900&path=websockify",
    networkToken: "NT-123",
  };

  it("opens the window by default and never returns the URL", async () => {
    const { run, log, events } = governanceRunner({
      EnsureSandBoxWindow: [ensure],
    });
    const out = await run("vnc", {
      window: 3,
      "print-url": false,
      json: false,
    });
    expect([out, events, log]).toEqual([
      { window: 3, opened: true, url: undefined },
      ["open-url"],
      [
        {
          via: "server",
          method: "EnsureSandBoxWindow",
          body: { windowIndex: 3 },
          confirmed: false,
        },
      ],
    ]);
  });

  it("returns the credential URL with the network token under --print-url", async () => {
    const { run, events } = governanceRunner({
      EnsureSandBoxWindow: [ensure],
    });
    const out = await run("vnc", { window: 3, "print-url": true, json: false });
    expect([out, events]).toEqual([
      {
        window: 3,
        opened: false,
        url: "https://box.example/vnc.html?resume_lower_s=900&path=websockify%3Fnetwork_token%3DNT-123&network_token=NT-123",
      },
      [],
    ]);
  });

  it("names no URL and chains no cause when the opener fails", async () => {
    const { run } = governanceRunner(
      { EnsureSandBoxWindow: [ensure] },
      {},
      {
        // What execFile rejects with when `open` fails: the full argv, URL included.
        openUrl: async (url) => {
          throw new Error(`Command failed: open ${url}\nLSOpenURLs failed`);
        },
      },
    );
    const error = await run("vnc", {
      window: 3,
      "print-url": false,
      json: false,
    }).catch((e: unknown) => e);
    expect(
      error instanceof GrokBotError
        ? [error.code, error.message, "cause" in error]
        : error,
    ).toEqual([
      "protocol",
      "Could not open the VNC viewer (open failed). Re-run with --print-url in a terminal.",
      false,
    ]);
  });
});
