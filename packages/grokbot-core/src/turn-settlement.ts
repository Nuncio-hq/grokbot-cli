import type { TurnSettlement } from "./agent-status.js";
import type { Turn } from "./turn-model.js";

/**
 * The newest settlement of the turn's latest run that this client understands.
 * `live.lastTurnSettlement.turnId` is the `requestId` of every row of the run it settles,
 * so it matches the run the turn's final reply comes from (see Turn.lastRuns). A
 * settlement that names our `sentMessageId` as its clientNonce matches while the turn is
 * still on our own message's run. A settlement of an earlier run of the turn (before a
 * delegate's reply or a card answer started the next) ends nothing, and neither does one
 * of another turn or with an outcome this client does not know.
 */
export function settlementOfTurn(
  turn: Turn,
  sentMessageId: string,
  settlements: Iterable<TurnSettlement>,
): TurnSettlement | undefined {
  let found: TurnSettlement | undefined;
  for (const s of settlements) {
    if (s.outcome === "unknown") continue;
    const ours =
      turn.lastRuns.includes(s.turnId) ||
      (s.clientNonce === sentMessageId && turn.onOwnRun);
    if (ours && (found === undefined || s.settledAtMs > found.settledAtMs))
      found = s;
  }
  return found;
}
