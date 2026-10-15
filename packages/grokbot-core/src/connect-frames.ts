import { GrokBotError } from "./contracts.js";

const HEADER_BYTES = 5;
const FLAG_COMPRESSED = 0x01;
const FLAG_END_STREAM = 0x02;

export interface ConnectEndError {
  readonly code: string;
  readonly message?: string;
}

export type ConnectFrame =
  | { readonly kind: "message"; readonly json: unknown }
  | { readonly kind: "end"; readonly error?: ConnectEndError };

export interface ConnectFrameDecoder {
  /** Feeds one chunk of the response body; returns every frame it completes. */
  push(chunk: Uint8Array): ConnectFrame[];
  /** Throws if the body ended in the middle of a frame. */
  finish(): void;
}

export function encodeConnectEnvelope(json: unknown): Uint8Array<ArrayBuffer> {
  const payload = new TextEncoder().encode(JSON.stringify(json));
  const envelope = new Uint8Array(HEADER_BYTES + payload.length);
  new DataView(envelope.buffer).setUint32(1, payload.length, false);
  envelope.set(payload, HEADER_BYTES);
  return envelope;
}

export function createConnectFrameDecoder(): ConnectFrameDecoder {
  let pending = new Uint8Array(0);
  const utf8 = new TextDecoder("utf-8", { fatal: true });

  return {
    push(chunk) {
      const joined = new Uint8Array(pending.length + chunk.length);
      joined.set(pending);
      joined.set(chunk, pending.length);

      const frames: ConnectFrame[] = [];
      let offset = 0;
      while (joined.length - offset >= HEADER_BYTES) {
        const view = new DataView(joined.buffer, offset, HEADER_BYTES);
        const flags = view.getUint8(0);
        const length = view.getUint32(1, false);
        const end = offset + HEADER_BYTES + length;
        if (end > joined.length) break;
        if (flags & FLAG_COMPRESSED) {
          throw new GrokBotError(
            "protocol",
            "Compressed Connect frames are not supported.",
          );
        }
        const json = parseJson(
          utf8,
          joined.subarray(offset + HEADER_BYTES, end),
        );
        frames.push(
          flags & FLAG_END_STREAM ? endFrame(json) : { kind: "message", json },
        );
        offset = end;
      }
      pending = joined.slice(offset);
      return frames;
    },
    finish() {
      if (pending.length > 0) {
        throw new GrokBotError(
          "protocol",
          "Connect stream ended in the middle of a frame.",
        );
      }
    },
  };
}

function parseJson(utf8: TextDecoder, bytes: Uint8Array): unknown {
  try {
    return JSON.parse(utf8.decode(bytes));
  } catch {
    throw new GrokBotError("protocol", "Connect frame is not valid JSON.");
  }
}

function endFrame(trailer: unknown): ConnectFrame {
  const error = isRecord(trailer) ? trailer.error : undefined;
  if (!isRecord(error)) return { kind: "end" };
  const code = typeof error.code === "string" ? error.code : "unknown";
  return typeof error.message === "string"
    ? { kind: "end", error: { code, message: error.message } }
    : { kind: "end", error: { code } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
