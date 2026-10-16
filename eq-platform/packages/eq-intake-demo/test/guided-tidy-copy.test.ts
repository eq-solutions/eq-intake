import { describe, it, expect } from "vitest";
import { describeCounts } from "../src/module/GuidedTidyCard.js";
import { nextSelection, pushBatch, type TidyBatch } from "../src/module/guided-tidy-history.js";

describe("describeCounts", () => {
  it("says only what is not zero, with the right singular and plural", () => {
    expect(describeCounts({ sure: 19, check: 12, questions: 1 })).toBe("19 changes I'm sure about, 12 to check, 1 question for you");
    expect(describeCounts({ sure: 0, check: 11, questions: 0 })).toBe("11 to check");
    expect(describeCounts({ sure: 1, check: 0, questions: 2 })).toBe("1 change I'm sure about, 2 questions for you");
  });
});

describe("undo history", () => {
  const b = (id: string): TidyBatch => ({ id, at: "2026-10-16T00:00:00Z", count: 1, fixes: [] });
  it("keeps the newest first and caps the list", () => {
    const list = ["a", "b", "c", "d", "e", "f"].reduce<TidyBatch[]>((acc, id) => pushBatch(acc, b(id)), []);
    expect(list.map((x) => x.id)).toEqual(["f", "e", "d", "c", "b"]);
  });
  it("does not duplicate a batch that is pushed twice", () => {
    expect(pushBatch(pushBatch([], b("a")), b("a"))).toHaveLength(1);
  });
});

describe("selection after a partial apply", () => {
  const p = (id: string, tier: "sure" | "check") => ({ id, tier });
  it("keeps what was ticked for what is still on offer, drops what was applied", () => {
    // s1, s2 were sure and ticked; c1 was ticked, c2 was not. s1 has just been applied.
    const prev = new Set(["s1", "s2", "c1"]);
    const known = new Set(["s1", "s2", "c1", "c2"]);
    const next = [p("s2", "sure"), p("c1", "check"), p("c2", "check")];
    expect([...nextSelection(prev, known, next)].sort()).toEqual(["c1", "s2"]);
  });
  it("respects a sure one the person unticked, and ticks a brand new sure one", () => {
    const prev = new Set<string>();
    const known = new Set(["s1"]);
    const next = [p("s1", "sure"), p("sNew", "sure"), p("cNew", "check")];
    expect([...nextSelection(prev, known, next)]).toEqual(["sNew"]);
  });
});
