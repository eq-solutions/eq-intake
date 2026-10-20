import { describe, it, expect } from "vitest";
import { FLAG_KIND, GAP_KIND, TIDY_WORDS, fixReason, plainCounts } from "../src/module/tidy-copy.js";

const fix = (fix_type: string, old_value: string | null, new_value: string | null) => ({ fix_type, old_value, new_value });

describe("why a quick fix is being made", () => {
  it("gives a sentence for each kind of fix", () => {
    expect(fixReason(fix("phone", "0412345678", "+61 412 345 678"))).toBe("Phone number set out the standard Australian way");
    expect(fixReason(fix("au_state", "New South Wales", "NSW"))).toBe("State written in its short form, like NSW");
    expect(fixReason(fix("email", "Foo@X.com", "foo@x.com"))).toBe("Email put in lower case");
  });

  it("says plainly when only capitals or spacing change", () => {
    expect(fixReason(fix("other", "Labour Hire", "labour_hire"))).toBe("Only the capital letters or spacing change, not the meaning");
    expect(fixReason(fix("other", "Acme ", "Acme"))).toBe("Extra spaces removed");
    expect(fixReason(fix("other", "Direct", "Employee"))).toBe("Written the way the template expects");
  });
});

describe("the wording a person reads", () => {
  it("has no jargon in any heading or hint", () => {
    const all = [...Object.values(TIDY_WORDS), ...Object.values(GAP_KIND), ...Object.values(FLAG_KIND)].join(" ").toLowerCase();
    for (const word of ["normalis", "canonical", "auto-fix", "required field", "cross-field", "ambiguous"]) {
      expect(all).not.toContain(word);
    }
  });

  it("counts with the right singular and plural", () => {
    expect(plainCounts.fixes(1)).toBe("1 quick fix");
    expect(plainCounts.fixes(41)).toBe("41 quick fixes");
    expect(plainCounts.gaps(1)).toBe("1 missing detail");
    expect(plainCounts.review(63)).toBe("63 to look at");
  });
});
