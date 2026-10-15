import { describe, expect, it } from "vitest";
import {
  createConnectFrameDecoder,
  encodeConnectEnvelope,
} from "./connect-frames.js";
import { GrokBotError } from "./contracts.js";

const ascii = (text: string): number[] =>
  Array.from(text, (char) => char.charCodeAt(0));

const MESSAGE_A = [0x00, 0x00, 0x00, 0x00, 0x07, ...ascii('{"a":1}')];
const MESSAGE_B = [0x00, 0x00, 0x00, 0x00, 0x0c, ...ascii('{"type":"x"}')];
const END_OK = [0x02, 0x00, 0x00, 0x00, 0x02, ...ascii("{}")];

describe("encodeConnectEnvelope", () => {
  it("wraps JSON in a flag byte and a big-endian length", () => {
    expect(encodeConnectEnvelope({ a: 1 })).toEqual(new Uint8Array(MESSAGE_A));
  });

  it("counts UTF-8 bytes, not characters, in the length", () => {
    expect(encodeConnectEnvelope({ t: "é" })).toEqual(
      new Uint8Array([
        0x00,
        0x00,
        0x00,
        0x00,
        0x0a,
        ...ascii('{"t":"'),
        0xc3,
        0xa9,
        ...ascii('"}'),
      ]),
    );
  });
});

describe("createConnectFrameDecoder", () => {
  it("waits for the rest of a frame split inside its header", () => {
    const decoder = createConnectFrameDecoder();
    expect(decoder.push(new Uint8Array(MESSAGE_A.slice(0, 3)))).toEqual([]);
    expect(decoder.push(new Uint8Array(MESSAGE_A.slice(3)))).toEqual([
      { kind: "message", json: { a: 1 } },
    ]);
  });

  it("waits for the rest of a frame split inside its payload", () => {
    const decoder = createConnectFrameDecoder();
    expect(decoder.push(new Uint8Array(MESSAGE_A.slice(0, 8)))).toEqual([]);
    expect(decoder.push(new Uint8Array(MESSAGE_A.slice(8)))).toEqual([
      { kind: "message", json: { a: 1 } },
    ]);
  });

  it("decodes many frames from one chunk, ending with the trailer", () => {
    const decoder = createConnectFrameDecoder();
    expect(
      decoder.push(new Uint8Array([...MESSAGE_A, ...MESSAGE_B, ...END_OK])),
    ).toEqual([
      { kind: "message", json: { a: 1 } },
      { kind: "message", json: { type: "x" } },
      { kind: "end" },
    ]);
  });

  it("decodes frames fed one byte at a time", () => {
    const decoder = createConnectFrameDecoder();
    const frames = [...MESSAGE_B, ...MESSAGE_A].flatMap((byte) =>
      decoder.push(new Uint8Array([byte])),
    );
    expect(frames).toEqual([
      { kind: "message", json: { type: "x" } },
      { kind: "message", json: { a: 1 } },
    ]);
  });

  it("keeps a trailing partial frame for the next chunk", () => {
    const decoder = createConnectFrameDecoder();
    expect(
      decoder.push(new Uint8Array([...MESSAGE_A, ...MESSAGE_B.slice(0, 6)])),
    ).toEqual([{ kind: "message", json: { a: 1 } }]);
    expect(decoder.push(new Uint8Array(MESSAGE_B.slice(6)))).toEqual([
      { kind: "message", json: { type: "x" } },
    ]);
  });

  it("reads the error from an end-of-stream trailer", () => {
    const trailer = '{"error":{"code":"unavailable","message":"box asleep"}}';
    const decoder = createConnectFrameDecoder();
    expect(
      decoder.push(
        new Uint8Array([0x02, 0x00, 0x00, 0x00, 0x37, ...ascii(trailer)]),
      ),
    ).toEqual([
      { kind: "end", error: { code: "unavailable", message: "box asleep" } },
    ]);
  });

  it("reports a body that ends in the middle of a frame", () => {
    const decoder = createConnectFrameDecoder();
    decoder.push(new Uint8Array(MESSAGE_A.slice(0, 6)));
    expect(() => decoder.finish()).toThrow(
      new GrokBotError(
        "protocol",
        "Connect stream ended in the middle of a frame.",
      ),
    );
  });

  it("finishes cleanly after whole frames", () => {
    const decoder = createConnectFrameDecoder();
    decoder.push(new Uint8Array(MESSAGE_A));
    expect(decoder.finish()).toBe(undefined);
    expect(decoder.push(new Uint8Array(END_OK))).toEqual([{ kind: "end" }]);
  });

  it("rejects compressed frames", () => {
    const decoder = createConnectFrameDecoder();
    expect(() =>
      decoder.push(new Uint8Array([0x01, 0x00, 0x00, 0x00, 0x00])),
    ).toThrow(
      new GrokBotError(
        "protocol",
        "Compressed Connect frames are not supported.",
      ),
    );
  });

  it("rejects a frame whose payload is not JSON", () => {
    const decoder = createConnectFrameDecoder();
    expect(() =>
      decoder.push(
        new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x02, ...ascii("{x")]),
      ),
    ).toThrow(new GrokBotError("protocol", "Connect frame is not valid JSON."));
  });
});
