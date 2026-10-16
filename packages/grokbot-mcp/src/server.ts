import { createInterface } from "node:readline";
import type { CommandRunner, JsonObject } from "grokbot-core";
import {
  encodeResponse,
  INTERNAL_ERROR,
  isRequestId,
  methodNotFound,
  type Outcome,
  parseIncoming,
  type RequestId,
} from "./json-rpc.js";
import { noteMcpClient } from "./mcp-client-name.js";
import { eraHandlers } from "./mcp-era-handlers.js";
import { requestEra } from "./mcp-era-request.js";

export interface ServeOptions {
  readonly input: NodeJS.ReadableStream;
  /** Receives only newline-terminated JSON-RPC messages. */
  readonly output: { readonly write: (chunk: string) => unknown };
  readonly runner: CommandRunner;
  /** Diagnostics; index.ts sends them to stderr. */
  readonly log: (line: string) => void;
}

/**
 * Serves MCP over newline-delimited JSON-RPC until `input` ends.
 * Dual-era: a request whose `_meta` names a protocol version is served statelessly
 * by the 2026-07-28 rules; anything else gets today's initialize-era behavior.
 */
export async function serve(options: ServeOptions): Promise<void> {
  const { input, output, runner, log } = options;
  const handlers = eraHandlers(runner);
  const inFlight = new Map<RequestId, AbortController>();
  const running = new Set<Promise<void>>();
  const send = (id: RequestId | null, outcome: Outcome): void => {
    output.write(encodeResponse(id, outcome));
  };

  // An aborted request gets no response: the client cancelled it or hung up.
  async function respond(
    id: RequestId,
    method: string,
    params: JsonObject,
  ): Promise<void> {
    noteMcpClient(params);
    const route = requestEra(params);
    if ("error" in route) return send(id, { error: route.error });
    const handler = handlers[route.era].get(method);
    if (!handler) return send(id, { error: methodNotFound(method) });
    const controller = new AbortController();
    inFlight.set(id, controller);
    let outcome: Outcome;
    try {
      outcome = await handler(params, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) {
        log(`${method} ${id} failed: ${String(error)}`);
      }
      outcome = { error: INTERNAL_ERROR };
    } finally {
      inFlight.delete(id);
    }
    if (!controller.signal.aborted) send(id, outcome);
  }

  function cancel(params: JsonObject) {
    const { requestId, reason } = params;
    const controller = isRequestId(requestId)
      ? inFlight.get(requestId)
      : undefined;
    if (!controller) return;
    log(`cancelled request ${requestId}: ${String(reason ?? "no reason")}`);
    controller.abort();
  }

  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const message = parseIncoming(line);
    switch (message.kind) {
      case "invalid":
        send(message.id, { error: message.error });
        break;
      case "notification":
        if (message.method === "notifications/cancelled") {
          cancel(message.params);
        }
        break;
      case "request": {
        const task = respond(message.id, message.method, message.params);
        running.add(task);
        task.finally(() => running.delete(task));
      }
    }
  }
  for (const controller of inFlight.values()) controller.abort();
  await Promise.all(running);
}
