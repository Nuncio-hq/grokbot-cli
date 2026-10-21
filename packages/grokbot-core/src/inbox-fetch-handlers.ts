import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { type BoxFile, type BoxSnapshot, cleanCloudPath } from "./box-store.js";
import type { FetchedFile, InboxOutputs } from "./command-outputs-inbox.js";
import type { RunnerContext } from "./command-runner-context.js";
import { GrokBotError } from "./contracts.js";
import { INBOX_ROOT } from "./inbox-types.js";
import { type FoundItem, findInboxItem } from "./inbox-view-handlers.js";
import { mapBounded } from "./map-bounded.js";

/** A folder fetch stops here: a repository checkout holds far more than anyone reads. */
const MAX_FILES = 200;
const MAX_BYTES = 50 * 1024 * 1024;
const PARALLEL_SAVES = 4;
const ROOTS = ["/workspace", "/home"];

interface Target {
  readonly file: BoxFile;
  /** Path below the output folder. */
  readonly name: string;
  /** What the item says the content hashes to, for an item's own files. */
  readonly sha256?: string;
}

const plainName = (name: string) =>
  name !== "" && name !== "." && name !== ".." && !/[/\\\0]/.test(name);

const underRoot = (path: string) =>
  ROOTS.some((root) => path === root || path.startsWith(`${root}/`));

/** The files of a cloud path: itself when a file, else every file below it. */
function pathTargets(snapshot: BoxSnapshot, given: string): readonly Target[] {
  const path = cleanCloudPath(given);
  if (path === undefined || !underRoot(path)) {
    throw new GrokBotError(
      "safety",
      `--path must be an absolute path under ${ROOTS.join(" or ")}, with no "." or ".." in it.`,
    );
  }
  const entry = snapshot.get(path);
  if (entry?.kind === "symlink") {
    throw new GrokBotError(
      "safety",
      `${path} is a symbolic link to ${entry.target}; fetch the file it points to.`,
    );
  }
  if (entry?.kind === "file") {
    return [{ file: entry, name: basename(path) }];
  }
  const below = snapshot
    .list(path)
    .filter((e): e is BoxFile => e.kind === "file");
  if (below.length === 0) {
    throw new GrokBotError(
      "not-found",
      `The box store lists nothing at ${path}. The cloud computer syncs about once a minute: a file written just now may not be there yet.`,
    );
  }
  const total = below.reduce((sum, f) => sum + f.size, 0);
  if (below.length > MAX_FILES || total > MAX_BYTES) {
    throw new GrokBotError(
      "safety",
      `${path} holds ${below.length} files (${total} bytes); a folder fetch stops at ${MAX_FILES} files or ${MAX_BYTES} bytes. Name one file or a smaller folder.`,
    );
  }
  const parent = path.slice(0, path.lastIndexOf("/"));
  return below.map((file) => ({
    file,
    name: file.path.slice(parent.length + 1),
  }));
}

function itemTargets(
  snapshot: BoxSnapshot,
  found: FoundItem,
  only: string | undefined,
): readonly Target[] {
  const { ref, read } = found;
  if (read.state !== "ok") {
    throw new GrokBotError(
      "protocol",
      `Inbox item ${ref.id} needs a newer grokbot to read its files: npm install -g grokbotagent-cli.`,
    );
  }
  const files = read.item.files ?? [];
  if (files.length === 0 && only === undefined) {
    throw new GrokBotError(
      "not-found",
      `Inbox item ${ref.id} has no files. Use --path to fetch a file or folder of the cloud computer.`,
    );
  }
  const chosen =
    only === undefined ? files : files.filter((f) => f.name === only);
  if (chosen.length === 0) {
    throw new GrokBotError(
      "not-found",
      `Inbox item ${ref.id} has no file "${only}". Its files: ${files.map((f) => f.name).join(", ") || "none"}.`,
    );
  }
  return chosen.map((file) => {
    // The item is a bot's own file: its names and paths are checked, never trusted.
    const cloud = `${INBOX_ROOT}/${ref.slug}/${file.path}`;
    if (
      !plainName(file.name) ||
      file.path !== `files/${ref.id}/${file.name}` ||
      cleanCloudPath(cloud) !== cloud
    ) {
      throw new GrokBotError(
        "protocol",
        `Inbox item ${ref.id} lists a file with a path grokbot will not follow: ${JSON.stringify(file.name)}.`,
      );
    }
    const entry = snapshot.get(cloud);
    if (entry?.kind !== "file") {
      throw new GrokBotError(
        "not-found",
        `${file.name} is not in the box store yet. The cloud computer syncs about once a minute: try again shortly.`,
      );
    }
    return { file: entry, name: file.name, sha256: file.sha256 };
  });
}

export async function fetchInbox(
  ctx: RunnerContext,
  input: {
    readonly id: string;
    readonly file?: string;
    readonly path?: string;
    readonly out?: string;
  },
  signal?: AbortSignal,
): Promise<InboxOutputs["inbox-fetch"]> {
  if (input.file !== undefined && input.path !== undefined) {
    throw new GrokBotError(
      "ambiguous",
      "--file and --path name different things: pass one of them.",
    );
  }
  const found = await findInboxItem(ctx, input.id, signal);
  const snapshot = await ctx.boxStore.snapshot(signal);
  const targets =
    input.path === undefined
      ? itemTargets(snapshot, found, input.file)
      : pathTargets(snapshot, input.path);
  const out = resolve(
    input.out ?? join(homedir(), ".grokbot", "inbox-files", found.ref.id),
  );
  const saved = await mapBounded(
    targets,
    PARALLEL_SAVES,
    async ({ file, name, sha256 }): Promise<FetchedFile> => {
      const destination = resolve(out, name);
      if (!destination.startsWith(`${out}${sep}`)) {
        throw new GrokBotError(
          "safety",
          `${name} would be saved outside ${out}.`,
        );
      }
      await ctx.boxStore.saveTo(file, destination, { signal });
      if (sha256 !== undefined) {
        const actual = createHash("sha256")
          .update(await readFile(destination))
          .digest("hex");
        if (actual !== sha256) {
          await rm(destination, { force: true });
          throw new GrokBotError(
            "protocol",
            `${name} does not match the sha256 its item lists, so grokbot did not keep it.`,
          );
        }
      }
      return {
        name,
        path: destination,
        cloudPath: file.path,
        sizeBytes: file.size,
      };
    },
  );
  return { id: found.ref.id, out, saved };
}
