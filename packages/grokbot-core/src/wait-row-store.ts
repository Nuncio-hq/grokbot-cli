import {
  compareSeq,
  type Generation,
  parseGeneration,
  type Seq,
  type TranscriptEntry,
} from "./transcript.js";

/** The wait's copy of one agent's rows above the job baseline: newest version per seq. */
export class RowStore {
  readonly #rows = new Map<Seq, TranscriptEntry>();
  #cursor: Seq;
  generation: Generation = parseGeneration("0");

  constructor(readonly baseline: Seq) {
    this.#cursor = baseline;
  }

  /** Highest updatedSeq held; streams and re-reads resume after it. */
  get cursor(): Seq {
    return this.#cursor;
  }

  /** True when any row is new or a newer version (higher updatedSeq) of one held. */
  add(entries: readonly TranscriptEntry[]): boolean {
    let added = false;
    for (const e of entries) {
      if (compareSeq(e.updatedSeq, this.baseline) <= 0) continue;
      const held = this.#rows.get(e.seq);
      if (held && compareSeq(e.updatedSeq, held.updatedSeq) <= 0) continue;
      this.#rows.set(e.seq, e);
      added = true;
      if (compareSeq(e.updatedSeq, this.#cursor) > 0)
        this.#cursor = e.updatedSeq;
    }
    return added;
  }

  entries(): TranscriptEntry[] {
    return [...this.#rows.values()];
  }
}
