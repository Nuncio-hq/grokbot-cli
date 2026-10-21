import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "./fixtures/fake-box.js";
import {
  type InboxWorld,
  inboxItem,
  inboxWorld,
} from "./fixtures/inbox-world.js";
import { INBOX_ROOT, type InboxItem } from "./inbox-schema.js";

let world: InboxWorld | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

const ID = "ffff6666";
const FOLDER = `${INBOX_ROOT}/acme-web/files/${ID}`;
const TRACE = "line 1\nline 2\n";
const SHOT = "not really a png";

const file = (name: string, text: string, overrides = {}) => ({
  name,
  path: `files/${ID}/${name}`,
  sizeBytes: text.length,
  contentType: "text/plain",
  sha256: sha256(text),
  ...overrides,
});

async function start(item: Partial<InboxItem> = {}) {
  world = await inboxWorld({
    items: [
      inboxItem(ID, {
        files: [file("trace.txt", TRACE), file("shot.png", SHOT)],
        ...item,
      }),
    ],
  });
  world.files[`${FOLDER}/trace.txt`] = TRACE;
  world.files[`${FOLDER}/shot.png`] = SHOT;
  world.files["/workspace/acme/notes/todo.md"] = "- fix it\n";
  world.files["/workspace/acme/notes/deep/more.md"] = "more\n";
  world.files["/home/bot/secret-looking.txt"] = "plain";
  world.sync();
  return world;
}

const fetchIt = (w: InboxWorld, input: { file?: string; path?: string } = {}) =>
  w.runner.run("inbox-fetch", {
    id: ID,
    json: false,
    out: join(w.dir, "out"),
    ...input,
  });

describe("inbox-fetch", () => {
  it("saves every file of the item, 0600, and says where", async () => {
    const w = await start();
    const out = await fetchIt(w);
    expect(out.saved.map((f) => f.name).sort()).toEqual([
      "shot.png",
      "trace.txt",
    ]);
    expect(await readFile(join(w.dir, "out", "trace.txt"), "utf8")).toBe(TRACE);
    expect((await stat(join(w.dir, "out", "shot.png"))).mode & 0o777).toBe(
      0o600,
    );
    expect(out.saved.find((f) => f.name === "trace.txt")).toMatchObject({
      path: join(w.dir, "out", "trace.txt"),
      cloudPath: `${FOLDER}/trace.txt`,
      sizeBytes: TRACE.length,
    });
  });

  it("saves into ~/.grokbot/inbox-files/<id>/ by default", async () => {
    const w = await start();
    const out = await w.runner.run("inbox-fetch", { id: ID, json: false });
    expect(out.out).toBe(
      join(process.env.HOME ?? "", ".grokbot", "inbox-files", ID),
    );
    expect(await readdir(out.out)).toContain("trace.txt");
  });

  it("saves one named file, and refuses a name the item does not list", async () => {
    const w = await start();
    expect((await fetchIt(w, { file: "trace.txt" })).saved).toHaveLength(1);
    await expect(fetchIt(w, { file: "other.txt" })).rejects.toMatchObject({
      code: "not-found",
      message: expect.stringContaining("trace.txt"),
    });
  });

  it("saves any file under /workspace or /home through the manifest", async () => {
    const w = await start();
    const out = await fetchIt(w, { path: "/workspace/acme/notes/todo.md" });
    expect(out.saved).toMatchObject([{ name: "todo.md" }]);
    expect(await readFile(join(w.dir, "out", "todo.md"), "utf8")).toBe(
      "- fix it\n",
    );
    await fetchIt(w, { path: "/home/bot/secret-looking.txt" });
  });

  it("saves a folder with its structure", async () => {
    const w = await start();
    const out = await fetchIt(w, { path: "/workspace/acme/notes" });
    expect(out.saved.map((f) => f.name).sort()).toEqual([
      "notes/deep/more.md",
      "notes/todo.md",
    ]);
    expect(
      await readFile(join(w.dir, "out", "notes", "deep", "more.md"), "utf8"),
    ).toBe("more\n");
  });

  it.each([
    ["outside /workspace and /home", "/etc/passwd"],
    ["a traversal", "/workspace/../etc/passwd"],
    ["a relative path", "workspace/acme/notes/todo.md"],
    ["a symbolic link", "/workspace/link"],
  ])("refuses %s", async (_name, path) => {
    const w = await start();
    await expect(fetchIt(w, { path })).rejects.toMatchObject({
      code: "safety",
    });
  });

  it("says a path is not synced yet when the store lists nothing there", async () => {
    await expect(
      fetchIt(await start(), { path: "/workspace/acme/missing.txt" }),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("refuses a folder with more files than a fetch takes", async () => {
    const w = await start();
    for (let i = 0; i < 201; i++) w.files[`/workspace/big/f${i}.txt`] = `${i}`;
    w.sync();
    await expect(fetchIt(w, { path: "/workspace/big" })).rejects.toMatchObject({
      code: "safety",
    });
  });

  it("refuses --file together with --path", async () => {
    await expect(
      fetchIt(await start(), {
        file: "trace.txt",
        path: "/workspace/acme/notes/todo.md",
      }),
    ).rejects.toMatchObject({ code: "ambiguous" });
  });

  it("drops a file whose content is not the sha256 its item lists", async () => {
    const w = await start({
      files: [file("trace.txt", TRACE, { sha256: sha256("something else") })],
    });
    await expect(fetchIt(w)).rejects.toMatchObject({ code: "protocol" });
    await expect(
      readFile(join(w.dir, "out", "trace.txt")),
    ).rejects.toBeDefined();
  });

  it.each([
    ["a name with a folder in it", "../escape.txt"],
    ["a path that is not the item's own", "x/../y.txt"],
  ])("refuses an item that lists %s", async (_name, name) => {
    const w = await start({
      files: [file(name, TRACE, { path: name })],
    });
    await expect(fetchIt(w)).rejects.toMatchObject({ code: "protocol" });
  });

  it("says a listed file is not in the store yet", async () => {
    const w = await start();
    delete w.files[`${FOLDER}/trace.txt`];
    w.sync();
    await expect(fetchIt(w, { file: "trace.txt" })).rejects.toMatchObject({
      code: "not-found",
    });
  });
});
