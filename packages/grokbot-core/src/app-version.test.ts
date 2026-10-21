import { describe, expect, it } from "vitest";
import {
  compareVersions,
  isNewerVersion,
  isVersion,
  parseBundleVersion,
  parseCatalogAppVersion,
  readBundleVersion,
  readInstalledAppVersion,
} from "./app-version.js";

const plist = (version: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>CFBundleShortVersion</key>
    <string>decoy</string>
    <key>CFBundleShortVersionString</key>
    <string>${version}</string>
    <key>CFBundleVersion</key>
    <string>9999</string>
  </dict>
</plist>`;

describe("compareVersions", () => {
  it.each([
    ["0.72.0", "0.71.2", 1],
    ["0.71.2", "0.72.0", -1],
    ["0.72.0", "0.72.0", 0],
    ["0.9.0", "0.10.0", -1],
    ["1.0.0", "0.99.99", 1],
    ["0.72.10", "0.72.9", 1],
    ["12345678901234567890.0.0", "12345678901234567889.0.0", 1],
    ["0.72.0+build.1", "0.72.0+build.2", 0],
  ] as const)("%s vs %s is %i", (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });

  it.each([
    ["1.0.0-rc.1", "1.0.0", -1],
    ["1.0.0", "1.0.0-rc.1", 1],
    ["1.0.0-rc.2", "1.0.0-rc.10", -1],
    ["1.0.0-alpha", "1.0.0-alpha.1", -1],
    ["1.0.0-1", "1.0.0-alpha", -1],
    ["1.0.0-beta", "1.0.0-alpha", 1],
  ] as const)(
    "orders prereleases by semver: %s vs %s is %i",
    (a, b, expected) => {
      expect(compareVersions(a, b)).toBe(expected);
    },
  );

  it.each(["", "0.72", "v0.72.0", "0.72.0.1", "latest", "0.72.x"])(
    "is undefined, never a guess, for %j",
    (bad) => {
      expect(compareVersions(bad, "0.72.0")).toBeUndefined();
      expect(compareVersions("0.72.0", bad)).toBeUndefined();
    },
  );
});

describe("isNewerVersion", () => {
  it("is true only when strictly newer", () => {
    expect(isNewerVersion("0.72.1", "0.72.0")).toBe(true);
    expect(isNewerVersion("0.72.0", "0.72.0")).toBe(false);
    expect(isNewerVersion("0.71.9", "0.72.0")).toBe(false);
  });

  it("is false when either side is not a version", () => {
    expect(isNewerVersion("beta", "0.72.0")).toBe(false);
    expect(isNewerVersion("0.72.0", "beta")).toBe(false);
  });
});

describe("isVersion", () => {
  it("accepts x.y.z with optional prerelease and build", () => {
    expect(isVersion("0.72.0")).toBe(true);
    expect(isVersion("1.2.3-rc.1+abc")).toBe(true);
    expect(isVersion("1.2")).toBe(false);
  });
});

describe("parseBundleVersion", () => {
  it("reads CFBundleShortVersionString, not a similarly named key", () => {
    expect(parseBundleVersion(plist("0.72.0"))).toBe("0.72.0");
  });

  it("tolerates whitespace around the value", () => {
    expect(
      parseBundleVersion(
        "<key>CFBundleShortVersionString</key>\n\t<string> 0.72.0 </string>",
      ),
    ).toBe("0.72.0");
  });

  it("is undefined when the key or its value is missing", () => {
    expect(parseBundleVersion("<plist><dict></dict></plist>")).toBeUndefined();
    expect(parseBundleVersion(plist(""))).toBeUndefined();
    expect(parseBundleVersion("")).toBeUndefined();
  });
});

describe("readBundleVersion", () => {
  it("reads Contents/Info.plist under the app folder", async () => {
    const paths: string[] = [];
    const version = await readBundleVersion(
      "/Apps/Example.app",
      async (path) => {
        paths.push(path);
        return plist("1.2.3");
      },
    );
    expect(version).toBe("1.2.3");
    expect(paths).toStrictEqual(["/Apps/Example.app/Contents/Info.plist"]);
  });

  it("is undefined, not an error, when the file cannot be read", async () => {
    const version = await readBundleVersion("/Apps/Missing.app", async () => {
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    });
    expect(version).toBeUndefined();
  });
});

describe("readInstalledAppVersion", () => {
  const read = async () => plist("0.72.0");

  it("reads the app on macOS", async () => {
    expect(await readInstalledAppVersion({ platform: "darwin", read })).toBe(
      "0.72.0",
    );
  });

  it("is unknown on any other platform, without reading anything", async () => {
    let reads = 0;
    const version = await readInstalledAppVersion({
      platform: "linux",
      read: async () => {
        reads++;
        return plist("0.72.0");
      },
    });
    expect(version).toBeUndefined();
    expect(reads).toBe(0);
  });

  it("is unknown when the app is absent", async () => {
    const version = await readInstalledAppVersion({
      platform: "darwin",
      read: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(version).toBeUndefined();
  });
});

describe("parseCatalogAppVersion", () => {
  it("returns the catalog's app_version", () => {
    expect(parseCatalogAppVersion({ app_version: "0.72.0" })).toBe("0.72.0");
  });

  it.each([{}, { app_version: 72 }, { app_version: "latest" }, null, "0.72.0"])(
    "throws for %j",
    (catalog) => {
      expect(() => parseCatalogAppVersion(catalog)).toThrow(
        "The catalog has no valid app_version.",
      );
    },
  );
});
