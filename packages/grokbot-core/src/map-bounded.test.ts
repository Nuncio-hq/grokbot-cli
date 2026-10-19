import { describe, expect, it } from "vitest";
import { mapBounded } from "./map-bounded.js";

const tick = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe("mapBounded", () => {
  it("keeps the input order when later items finish first", async () => {
    const out = await mapBounded([30, 10, 20], 3, async (ms) => {
      await tick(ms);
      return ms;
    });
    expect(out).toStrictEqual([30, 10, 20]);
  });

  it("never runs more than the limit at once", async () => {
    let running = 0;
    let peak = 0;
    await mapBounded([1, 2, 3, 4, 5, 6, 7], 3, async () => {
      peak = Math.max(peak, ++running);
      await tick(5);
      running--;
    });
    expect(peak).toBe(3);
  });

  it("rejects with the first failure", async () => {
    const call = mapBounded([1, 2], 2, async (n) => {
      if (n === 2) throw new Error("two failed");
      return n;
    });
    await expect(call).rejects.toThrow("two failed");
  });

  it("returns an empty list for no items", async () => {
    expect(await mapBounded([], 4, async () => 1)).toStrictEqual([]);
  });
});
