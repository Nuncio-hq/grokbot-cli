import { describe, expect, it } from "vitest";
import {
  fetchLatestBuild,
  PLACEHOLDER_MACHINE_ID,
  parseUpdateResponse,
  releaseZipUrl,
  updateFeedUrl,
} from "./app-update-feed.js";

const body = (name: string, url: string): string =>
  JSON.stringify({ name, url });

describe("parseUpdateResponse", () => {
  it("reads the version and download of a 200 answer", () => {
    expect(
      parseUpdateResponse(200, body("0.73.0", releaseZipUrl("0.73.0"))),
    ).toEqual({ version: "0.73.0", url: releaseZipUrl("0.73.0") });
  });

  it("reports nothing newer for a 204 answer", () => {
    expect(parseUpdateResponse(204, "")).toBeUndefined();
  });

  it("rejects other statuses", () => {
    expect(() => parseUpdateResponse(500, "")).toThrow(/500/);
  });

  it("rejects a body that is not JSON", () => {
    expect(() => parseUpdateResponse(200, "<html>")).toThrow(/not JSON/);
  });

  it("rejects an answer without a version name or url", () => {
    expect(() => parseUpdateResponse(200, "{}")).toThrow();
    expect(() => parseUpdateResponse(200, "null")).toThrow();
    expect(() =>
      parseUpdateResponse(200, body("latest", releaseZipUrl("0.73.0"))),
    ).toThrow(/version/);
    expect(() =>
      parseUpdateResponse(200, JSON.stringify({ name: "0.73.0" })),
    ).toThrow(/url/);
  });

  it("rejects a download url that is not https", () => {
    expect(() =>
      parseUpdateResponse(
        200,
        body("0.73.0", releaseZipUrl("0.73.0").replace("https:", "http:")),
      ),
    ).toThrow(/https/);
    expect(() => parseUpdateResponse(200, body("0.73.0", "not a url"))).toThrow(
      /not a URL/,
    );
  });

  it("rejects a name that differs from the version in the url", () => {
    expect(() =>
      parseUpdateResponse(200, body("0.73.0", releaseZipUrl("0.72.1"))),
    ).toThrow(/0\.73\.0/);
    expect(() =>
      parseUpdateResponse(
        200,
        body("0.73.0", "https://downloads.example.test/0.73.0/other.zip"),
      ),
    ).toThrow(/0\.73\.0/);
  });
});

describe("fetchLatestBuild", () => {
  it("asks the feed from the given version with the placeholder machine id", async () => {
    const asked: string[] = [];
    const fetchFeed: typeof fetch = async (input) => {
      asked.push(String(input));
      return new Response(null, { status: 204 });
    };
    expect(await fetchLatestBuild("0.72.1", fetchFeed)).toBeUndefined();
    expect(asked).toEqual([updateFeedUrl("0.72.1")]);
    expect(asked[0]).toContain(`/0.72.1/${PLACEHOLDER_MACHINE_ID}/stable`);
    expect(PLACEHOLDER_MACHINE_ID).toMatch(/^0{8}(-0{4}){3}-0{12}$/);
  });

  it("returns the build of a 200 answer", async () => {
    const fetchFeed: typeof fetch = async () =>
      new Response(body("0.73.0", releaseZipUrl("0.73.0")), { status: 200 });
    expect(await fetchLatestBuild("0.72.1", fetchFeed)).toEqual({
      version: "0.73.0",
      url: releaseZipUrl("0.73.0"),
    });
  });
});
