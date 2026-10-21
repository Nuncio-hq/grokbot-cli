import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { credentialKind } from "./inbox-secrets.js";
import { INBOX_LIMITS, type InboxFile } from "./inbox-types.js";
import type { InboxIssue } from "./inbox-validate.js";

/** An attachment read and checked, ready to be written into `files/<id>/`. */
export interface StagedFile extends Omit<InboxFile, "path"> {
  readonly data: Buffer;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".json": "application/json",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".html": "text/html",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".diff": "text/x-diff",
  ".patch": "text/x-diff",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
};

const MAX_NAME = 100;

/** The content type for a file name by its extension; `application/octet-stream` when unknown. */
export function inboxContentType(name: string): string {
  return (
    CONTENT_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream"
  );
}

/** A safe file name: its base name with letters, digits, `.`, `_` and `-` only, never hidden, at most 100 characters. */
export function inboxFileLabel(path: string): string {
  const clean = basename(path)
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^\.+/, "");
  if (clean === "") return "file";
  if (clean.length <= MAX_NAME) return clean;
  const ext = extname(clean).slice(0, 16);
  return `${clean.slice(0, MAX_NAME - ext.length)}${ext}`;
}

/** `name`, or `name-2`, `name-3` before the extension when `taken` has it. */
function unique(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 2; ; n++) {
    const next = `${stem}-${n}${ext}`;
    if (!taken.has(next)) return next;
  }
}

const looksLikeText = (data: Buffer) => !data.subarray(0, 8192).includes(0);

/**
 * Reads each path, checking it is a regular file, within the size limits and free of
 * credentials. Every problem is reported against `files[i]`; nothing is written.
 */
export async function stageInboxFiles(
  paths: readonly string[],
): Promise<
  | { readonly ok: true; readonly files: readonly StagedFile[] }
  | { readonly ok: false; readonly errors: readonly InboxIssue[] }
> {
  const errors: InboxIssue[] = [];
  if (paths.length > INBOX_LIMITS.files)
    return {
      ok: false,
      errors: [
        {
          path: "files",
          message: `${paths.length} files; at most ${INBOX_LIMITS.files} are allowed`,
        },
      ],
    };
  const files: StagedFile[] = [];
  const names = new Set<string>();
  let total = 0;
  for (const [i, path] of paths.entries()) {
    const where = `files[${i}]`;
    let size: number;
    try {
      const info = await stat(resolve(path));
      if (!info.isFile()) {
        errors.push({ path: where, message: "is not a regular file" });
        continue;
      }
      size = info.size;
    } catch {
      errors.push({ path: where, message: "cannot be read (does it exist?)" });
      continue;
    }
    total += size;
    if (total > INBOX_LIMITS.fileBytes) {
      errors.push({
        path: where,
        message: `the files together exceed ${INBOX_LIMITS.fileBytes} bytes`,
      });
      continue;
    }
    let data: Buffer;
    try {
      data = await readFile(resolve(path));
    } catch {
      errors.push({ path: where, message: "cannot be read" });
      continue;
    }
    const credential = looksLikeText(data)
      ? credentialKind(data.toString("utf8"))
      : undefined;
    if (credential !== undefined) {
      errors.push({
        path: where,
        message: `contains what looks like a credential (${credential}); never attach secrets`,
      });
      continue;
    }
    const name = unique(inboxFileLabel(path), names);
    names.add(name);
    files.push({
      name,
      sizeBytes: data.length,
      contentType: inboxContentType(name),
      sha256: createHash("sha256").update(data).digest("hex"),
      data,
    });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, files };
}
