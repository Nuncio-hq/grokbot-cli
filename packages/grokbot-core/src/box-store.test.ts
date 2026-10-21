import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BoxFile, boxStore, cleanCloudPath } from "./box-store.js";
import { GrokBotError } from "./contracts.js";
import { type FakeBox, fakeBox, sha256 } from "./fixtures/fake-box.js";
import { fakeServer } from "./fixtures/fake-server.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "grokbot-box-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const store = (box: FakeBox) =>
  boxStore({
    server: box.server,
    fetch: box.fetch,
    cacheDir: join(dir, "cache"),
  });

describe("manifest", () => {
  it("lists the files below a folder from the manifest, skipping nothing it can read", async () => {
    const box = fakeBox({
      "/workspace/a/b.json": "{}",
      "/workspace/a/c.json": "{}",
      "/workspace/other.txt": "x",
    });
    const snapshot = await store(box).snapshot();
    expect(snapshot.list("/workspace/a").map((e) => e.path)).toEqual([
      "/workspace/a/b.json",
      "/workspace/a/c.json",
    ]);
    expect(snapshot.list("/workspace/ab")).toEqual([]);
    expect(snapshot.get("/workspace/other.txt")).toMatchObject({
      kind: "file",
      size: 1,
    });
    expect(snapshot.updatedAtMs).toBe(1_790_000_000_000);
  });

  it("downloads the manifest only when its etag changed, also across processes", async () => {
    const box = fakeBox({ "/workspace/a.txt": "one" });
    const first = store(box);
    await first.snapshot();
    await first.snapshot();
    // A second process starts with an empty memory and the same cache folder.
    await store(box).snapshot();
    expect(box.gets).toHaveLength(1);
    expect(
      box.log.filter((c) => c.method === "StatSandBoxStoreObject"),
    ).toHaveLength(3);

    box.state.files["/workspace/b.txt"] = "two";
    box.state.etag = "etag-2";
    const next = await first.snapshot();
    expect(next.get("/workspace/b.txt")).toBeDefined();
    expect(box.gets).toHaveLength(2);
    expect(
      box.presigned.every((paths) => paths.join() === "manifest.json"),
    ).toBe(true);
  });

  it("fetches the manifest again when the cached copy is damaged", async () => {
    const box = fakeBox({ "/workspace/a.txt": "one" });
    await store(box).snapshot();
    await rm(join(dir, "cache", "manifest.json"));
    await store(box).snapshot();
    expect(box.gets).toHaveLength(2);
  });

  it.each([
    ["a stat that is not an object", { StatSandBoxStoreObject: ["nope"] }],
    [
      "a stat with an etag that is not text",
      { StatSandBoxStoreObject: [{ exists: true, etag: 5 }] },
    ],
    ["a presign with no instructions", { PresignSandBoxStoreReads: [{}] }],
    [
      "a presign for another path",
      {
        PresignSandBoxStoreReads: [
          { instructions: [{ relPath: "x", url: "https://s.example/x" }] },
        ],
      },
    ],
  ])("fails clearly on %s", async (_name, replacement) => {
    const box = fakeBox({});
    const { server } = fakeServer({
      calls: {
        StatSandBoxStoreObject: [{ exists: true, etag: "e" }],
        PresignSandBoxStoreReads: [{ instructions: [] }],
        ...replacement,
      },
    });
    const error = await boxStore({
      server,
      fetch: box.fetch,
      cacheDir: join(dir, "cache"),
    })
      .snapshot()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrokBotError);
    expect((error as GrokBotError).code).toBe("protocol");
  });

  it("fails clearly when the manifest has an unknown shape", async () => {
    const box = fakeBox({});
    const broken = boxStore({
      server: box.server,
      fetch: async () =>
        new Response(
          JSON.stringify({
            entries: { "a/b": { kind: "file", sha: "short" } },
          }),
        ),
      cacheDir: join(dir, "cache"),
    });
    await expect(broken.snapshot()).rejects.toMatchObject({ code: "protocol" });
  });

  it("says the cloud computer has not synced when the store has no manifest", async () => {
    const { server } = fakeServer({ calls: { StatSandBoxStoreObject: [{}] } });
    await expect(
      boxStore({ server, cacheDir: join(dir, "cache") }).snapshot(),
    ).rejects.toMatchObject({ code: "not-found" });
  });
});

describe("blobs", () => {
  const filesOf = async (box: FakeBox, paths: string[]) => {
    const snapshot = await store(box).snapshot();
    return paths.map((p) => snapshot.get(p) as BoxFile);
  };

  it("reads each blob once, then from the permanent cache", async () => {
    const box = fakeBox({
      "/workspace/a.txt": "alpha",
      "/workspace/b.txt": "beta",
    });
    const files = await filesOf(box, ["/workspace/a.txt", "/workspace/b.txt"]);
    const reader = store(box);
    expect(await reader.readTexts(files, { maxBytes: 100 })).toEqual([
      "alpha",
      "beta",
    ]);
    const getsAfterFirst = box.gets.length;
    expect(await reader.readTexts(files, { maxBytes: 100 })).toEqual([
      "alpha",
      "beta",
    ]);
    // A fresh process also finds them on disk, even after the manifest changed.
    box.state.etag = "etag-9";
    expect(await store(box).readTexts(files, { maxBytes: 100 })).toEqual([
      "alpha",
      "beta",
    ]);
    expect(box.gets).toHaveLength(getsAfterFirst);
  });

  it("downloads at most 8 at once", async () => {
    const many = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [
        `/workspace/f${i}.txt`,
        `body ${i}`,
      ]),
    );
    const box = fakeBox(many);
    const files = await filesOf(box, Object.keys(many));
    const gate = box.hold(8);
    const reading = store(box).readTexts(files, { maxBytes: 100 });
    await gate.saturated;
    // Eight downloads wait on the gate, and a ninth does not start while they do.
    await Promise.resolve();
    expect(box.inFlight()).toBe(8);
    gate.release();
    expect(await reading).toEqual(Object.values(many));
    expect(box.maxInFlight()).toBe(8);
  });

  it("answers undefined for a blob the store does not hold yet", async () => {
    const box = fakeBox({
      "/workspace/a.txt": "alpha",
      "/workspace/b.txt": "beta",
    });
    const files = await filesOf(box, ["/workspace/a.txt", "/workspace/b.txt"]);
    box.state.withheld.add(`blobs/${sha256("beta")}`);
    expect(await store(box).readTexts(files, { maxBytes: 100 })).toEqual([
      "alpha",
      undefined,
    ]);
  });

  it("refuses to read a file past the size limit as text", async () => {
    const box = fakeBox({ "/workspace/big.txt": "x".repeat(50) });
    const files = await filesOf(box, ["/workspace/big.txt"]);
    await expect(
      store(box).readTexts(files, { maxBytes: 10 }),
    ).rejects.toMatchObject({
      code: "safety",
    });
  });

  it("saves a file to a destination in a 0600 file, and says so when the content is missing", async () => {
    const box = fakeBox({
      "/workspace/a.txt": "alpha",
      "/workspace/b.txt": "beta",
    });
    const [a, b] = await filesOf(box, ["/workspace/a.txt", "/workspace/b.txt"]);
    const target = join(dir, "out", "deep", "a.txt");
    await store(box).saveTo(a as BoxFile, target);
    expect(await readFile(target, "utf8")).toBe("alpha");
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    box.state.withheld.add(`blobs/${sha256("beta")}`);
    await expect(
      store(box).saveTo(b as BoxFile, join(dir, "out", "b.txt")),
    ).rejects.toMatchObject({
      code: "not-found",
    });
  });

  it("never puts a presigned URL in an error", async () => {
    const box = fakeBox({ "/workspace/a.txt": "alpha" });
    const files = await filesOf(box, ["/workspace/a.txt"]);
    const failing = boxStore({
      server: box.server,
      cacheDir: join(dir, "cache2"),
      fetch: async (url) => {
        throw new Error(`connect failed for ${url}`);
      },
    });
    const error = await failing
      .readTexts(files, { maxBytes: 100 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrokBotError);
    expect(String((error as Error).message)).not.toContain("bearer-secret");
    expect(String((error as Error).message)).not.toContain("store.example");
    const refused = boxStore({
      server: box.server,
      cacheDir: join(dir, "cache3"),
      fetch: async () => new Response("no", { status: 403 }),
    });
    const second = await refused
      .readTexts(files, { maxBytes: 100 })
      .catch((e: unknown) => e);
    expect(String((second as Error).message)).not.toContain("bearer-secret");
  });
});

describe("cleanCloudPath", () => {
  it.each([
    ["/workspace/a/b", "/workspace/a/b"],
    ["/workspace/a/", "/workspace/a"],
    ["/", "/"],
    ["workspace/a", undefined],
    ["/workspace/../etc", undefined],
    ["/workspace//a", undefined],
    ["/workspace/./a", undefined],
  ])("%s -> %s", (input, expected) => {
    expect(cleanCloudPath(input)).toBe(expected);
  });
});
