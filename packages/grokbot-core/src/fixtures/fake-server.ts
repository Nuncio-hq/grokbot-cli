import type { CallOptions, JsonObject, ServerTransport } from "../contracts.js";

export type ScriptedStream =
  | readonly unknown[]
  | (() => AsyncIterable<unknown>);

export interface RecordedCall {
  readonly kind: "call" | "stream";
  readonly method: string;
  readonly body: JsonObject;
}

/** Hangs until the caller aborts, like a real stream between frames. */
export async function* hangUntilAborted(
  frames: readonly unknown[],
  signal?: AbortSignal,
): AsyncGenerator<unknown> {
  yield* frames;
  await new Promise<never>((_, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

/**
 * Fake ServerTransport. Unary responses are queued per method (the last one repeats);
 * streams are consumed in order, one per `stream()` call.
 */
export function fakeServer(script: {
  calls?: Record<string, readonly unknown[] | ((body: JsonObject) => unknown)>;
  streams?: readonly ScriptedStream[];
}) {
  const log: RecordedCall[] = [];
  const queues = new Map<string, unknown[]>();
  let streamIndex = 0;
  const server: ServerTransport = {
    async call(method: string, body: JsonObject): Promise<unknown> {
      log.push({ kind: "call", method, body });
      const scripted = script.calls?.[method];
      if (typeof scripted === "function") return scripted(body);
      if (!scripted) throw new Error(`fake server: unscripted call ${method}`);
      const queue = queues.get(method) ?? [...scripted];
      queues.set(method, queue);
      return queue.length > 1 ? queue.shift() : queue[0];
    },
    stream(
      method: string,
      body: JsonObject,
      options?: CallOptions,
    ): AsyncIterable<unknown> {
      log.push({ kind: "stream", method, body });
      const scripted = script.streams?.[streamIndex++];
      if (scripted === undefined) return hangUntilAborted([], options?.signal);
      return typeof scripted === "function"
        ? scripted()
        : (async function* () {
            yield* scripted;
          })();
    },
  };
  return { server, log };
}
