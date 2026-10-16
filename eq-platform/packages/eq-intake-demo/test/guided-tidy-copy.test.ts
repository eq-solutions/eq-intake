import { describe, it, expect } from "vitest";
import { describeCounts } from "../src/module/GuidedTidyCard.js";
import { pushBatch, type TidyBatch } from "../src/module/guided-tidy-history.js";

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
