import { readFile } from "node:fs/promises";
import { type Agent, parseListAgentsResponse } from "./agents.js";
import type { RunnerContext } from "./command-runner-context.js";
import { GrokBotError, type JsonObject } from "./contracts.js";
import { asJsonObject } from "./transcript.js";

/** Tries of a create call; each failed try usually took the server about 30 s. */
const CREATE_TRIES = 3;

/** The bot or room a create or set-members reply carries in `agent`, if any. */
export function agentFromReply(reply: unknown): Agent | undefined {
  const agent = asJsonObject(reply)?.agent;
  return agent === undefined
    ? undefined
    : parseListAgentsResponse({ agents: [agent] })[0];
}

/** HTTP status in a transport error message ("... failed with HTTP 504: ..."). */
const STATUS = /failed with HTTP (\d{3})/;

/**
 * A failure a retry may fix: a timeout, a network failure (no status), or a 5xx.
 * A 4xx is the request's fault, so sending it again cannot help.
 */
function isRetryable(error: GrokBotError): boolean {
  if (error.code === "timeout") return true;
  if (error.code !== "http") return false;
  const status = STATUS.exec(error.message)?.[1];
  return status === undefined || status.startsWith("5");
}

/**
 * Runs a create call whose `agentId` the client picks. The server keeps that id, so a
 * timed-out create may still land: after a failure it looks for the id in the roster,
 * then retries with the same id, as the server's own 504 message asks. Every error it
 * throws names the id; `rerun` tells the user what running the command again does.
 */
export async function createWithClientId(
  ctx: RunnerContext,
  method: "CreateGrokBotTemporalAgent" | "CreateGrokBotRoom",
  body: JsonObject & { readonly agentId: string },
  rerun: string,
  signal?: AbortSignal,
): Promise<Agent> {
  for (let attempt = 1; ; attempt++) {
    let failure: GrokBotError | undefined;
    try {
      const agent = agentFromReply(
        await ctx.server.call(method, body, { signal }),
      );
      if (agent) return agent;
    } catch (error) {
      if (!(error instanceof GrokBotError)) throw error;
      if (!isRetryable(error)) {
        throw new GrokBotError(
          error.code,
          `${error.message} (no bot was made; it would have been ${body.agentId}).`,
          { cause: error },
        );
      }
      failure = error;
    }
    let roster: readonly Agent[];
    try {
      roster = await ctx.fetchAgents(signal);
    } catch (error) {
      if (!(error instanceof GrokBotError)) throw error;
      const first = failure ? failure.message : `${method} returned no agent`;
      throw new GrokBotError(
        error.code,
        `Could not confirm ${body.agentId}: ${first}, then ${error.message.replace(/\.$/, "")}. ${rerun}`,
        { cause: error },
      );
    }
    const landed = roster.find((a) => a.agentId === body.agentId);
    if (landed) return landed;
    if (!failure) {
      throw new GrokBotError(
        "protocol",
        `${method} returned no agent and ${body.agentId} is not on the roster.`,
      );
    }
    if (attempt >= CREATE_TRIES) {
      throw new GrokBotError(
        failure.code,
        `${method} failed ${CREATE_TRIES} times (${failure.message}). It may still finish as ${body.agentId}. ${rerun}`,
      );
    }
  }
}

/** Reads a text file named by a CLI flag. */
export async function readInputFile(
  path: string,
  param: string,
): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unreadable";
    throw new GrokBotError(
      "not-found",
      `Cannot read ${param} ${path} (${code}).`,
    );
  }
}

const sameName = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/** Roster entries whose name equals `name`, ignoring case and outer spaces. */
export function namedLike(
  roster: readonly Agent[],
  name: string,
): readonly Agent[] {
  return roster.filter((a) => sameName(a.name, name));
}
