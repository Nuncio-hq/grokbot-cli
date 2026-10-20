import dc from "node:diagnostics_channel";
import {
  type ClientHttp2Stream,
  createServer,
  type Http2Session,
  type ServerHttp2Session,
  type ServerHttp2Stream,
} from "node:http2";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { createHttp2Fetch } from "../http2-fetch.js";

/** Listener count per event name on one HTTP/2 session. */
export type ListenerCounts = Record<string, number>;

export interface Http2Probe {
  /** Client sessions opened by the counted calls: 1 when they all shared one connection. */
  readonly connections: number;
  readonly afterFirstCall: ListenerCounts;
  readonly afterAllCalls: ListenerCounts;
  /** Process warnings raised meanwhile, as `Name: message`. */
  readonly warnings: readonly string[];
  /** What reading a response that went silent threw. */
  readonly stalledError: string;
}

/**
 * Makes `calls` sequential and then `calls` concurrent calls over one connection to a
 * local HTTP/2 server, and reports what the client session is left listening to; then
 * reads a response that stalls. Runs in whichever runtime imports it, and as a script
 * (`bun http2-probe.ts`) prints the result as JSON: the leak this guards against is
 * Bun's alone, and the unit tests run on Node.
 */
export async function probeHttp2(calls: number): Promise<Http2Probe> {
  const clients = new Set<Http2Session>();
  const serverSessions: ServerHttp2Session[] = [];
  const warnings: string[] = [];
  const onWarning = (warning: Error) =>
    warnings.push(`${warning.name}: ${warning.message}`);
  const onStream = (message: unknown) => {
    // dc messages are `unknown`; this channel publishes { stream, headers } in Node and Bun.
    const published = message as { stream: ClientHttp2Stream };
    if (published.stream.session) clients.add(published.stream.session);
  };
  process.on("warning", onWarning);
  dc.subscribe("http2.client.stream.created", onStream);
  const server = createServer();
  server.on("stream", (raw, headers) => {
    // The event typings name the base class; a server's streams are ServerHttp2Streams.
    const stream = raw as ServerHttp2Stream;
    stream.on("error", () => {});
    stream.respond({ ":status": 200 });
    if (headers[":path"] !== "/stall") stream.end("ok");
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, () => listening.resolve());
  await listening.promise;
  try {
    const origin = `http://localhost:${(server.address() as AddressInfo).port}`;
    const fetch = createHttp2Fetch({ idleCloseMs: 60_000 });
    const call = async () =>
      (await fetch(origin, { method: "POST", body: "x" })).text();
    const snapshot = (): ListenerCounts => {
      const [session] = clients;
      if (clients.size !== 1 || !session) {
        throw new Error(`expected one client session, saw ${clients.size}`);
      }
      return Object.fromEntries(
        session
          .eventNames()
          .map((name) => [String(name), session.listenerCount(name)]),
      );
    };
    await call();
    const afterFirstCall = snapshot();
    for (let i = 1; i < calls; i++) await call();
    await Promise.all(Array.from({ length: calls }, call));
    // Warnings reach process listeners on a later tick.
    await sleep(20);
    const afterAllCalls = snapshot();
    const connections = clients.size;
    let stalledError = "";
    try {
      const stalled = createHttp2Fetch({ silenceTimeoutMs: 30 });
      await (await stalled(`${origin}/stall`, { method: "POST" })).text();
    } catch (error) {
      stalledError = error instanceof Error ? error.message : String(error);
    }
    return {
      connections,
      afterFirstCall,
      afterAllCalls,
      warnings,
      stalledError,
    };
  } finally {
    dc.unsubscribe("http2.client.stream.created", onStream);
    process.off("warning", onWarning);
    for (const session of clients) session.destroy();
    for (const session of serverSessions) session.destroy();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
  }
}

if (import.meta.main) console.log(JSON.stringify(await probeHttp2(20)));
