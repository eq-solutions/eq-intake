/**
 * Licence compare: synthetic data only (no real people, emails or numbers).
 */
import { describe, it, expect } from "vitest";
import {
  compareLicences,
  normaliseDate,
  rowsFromSheet,
} from "../src/skills/licence-compare/index.js";
import type { JvknSnapshot } from "../src/skills/licence-compare/index.js";

const snapshot: JvknSnapshot = {
  workers: [
    { userId: "u1", email: "pat@example.test" },
    { userId: "u2", email: "sam@example.test" },
    { userId: "u3", email: "dup@example.test" },
    { userId: "u4", email: "DUP@example.test" },
  ],
  licences: [
    { id: "l1", userId: "u1", licenceType: "White Card", licenceNumber: "WC-123", expiryDate: "2027-03-01", neverExpires: false },
    { id: "l2", userId: "u1", licenceType: "Forklift", licenceNumber: "FK1", expiryDate: "2026-12-31", neverExpires: false },
    { id: "l3", userId: "u2", licenceType: "Working at Heights", licenceNumber: "", expiryDate: "2027-01-15", neverExpires: false },
    { id: "l4", userId: "u2", licenceType: "Working at Heights", licenceNumber: "", expiryDate: "2028-01-15", neverExpires: false },
    { id: "l5", userId: "u2", licenceType: "Induction", licenceNumber: "I9", expiryDate: "", neverExpires: true },
  ],
};

const run = (csv: Record<string, string>[]) => compareLicences(rowsFromSheet(csv), snapshot);

describe("normaliseDate", () => {
  it("reads ISO and Australian day-first dates, rejects nonsense", () => {
    expect(normaliseDate("2027-03-01")).toBe("2027-03-01");
    expect(normaliseDate("1/3/2027")).toBe("2027-03-01");
    expect(normaliseDate("01.03.27")).toBe("2027-03-01");
    expect(normaliseDate("31/02/2027")).toBe("");
    expect(normaliseDate("soon")).toBe("");
  });
});

describe("compareLicences", () => {
  it("matches on type and number with the same expiry, ignoring case and punctuation", () => {
    const r = run([{ Email: "PAT@example.test", "Licence Type": "white card", Number: "wc 123", Expiry: "1/3/2027" }]);
    expect(r.lines[0]!.verdict).toBe("match");
    expect(r.lines[0]!.jvknLicenceId).toBe("l1");
  });

  it("flags a different expiry", () => {
    const r = run([{ email: "pat@example.test", licence: "Forklift", number: "FK1", expiry: "2027-12-31" }]);
    expect(r.lines[0]!.verdict).toBe("expiry_differs");
    expect(r.lines[0]!.jvknExpiry).toBe("2026-12-31");
  });

  it("reports a missing licence, and a wrong number on a known type", () => {
    const r = run([
      { email: "pat@example.test", licence: "Confined Space", number: "", expiry: "" },
      { email: "pat@example.test", licence: "Forklift", number: "ZZ9", expiry: "" },
    ]);
    expect(r.lines.map((l) => l.verdict)).toEqual(["missing_in_jvkn", "missing_in_jvkn"]);
    expect(r.lines[1]!.detail).toMatch(/different number/);
  });

  it("does not guess when two licences of a type match, or two workers share an email", () => {
    const r = run([
      { email: "sam@example.test", licence: "Working at Heights", number: "", expiry: "2027-01-15" },
      { email: "dup@example.test", licence: "Forklift", number: "", expiry: "" },
    ]);
    expect(r.lines.map((l) => l.verdict)).toEqual(["ambiguous", "ambiguous"]);
  });

  it("treats a blank file expiry as nothing to disagree with, and never-expires as comparable", () => {
    const r = run([
      { email: "pat@example.test", licence: "White Card", number: "WC-123", expiry: "" },
      { email: "sam@example.test", licence: "Induction", number: "I9", expiry: "never" },
      { email: "sam@example.test", licence: "Induction", number: "I9", expiry: "2030-01-01" },
    ]);
    expect(r.lines.map((l) => l.verdict)).toEqual(["match", "match", "duplicate_in_file"]);
  });

  it("flags unknown people and unreadable rows, and counts every verdict", () => {
    const r = run([
      { email: "nobody@example.test", licence: "White Card", number: "", expiry: "" },
      { email: "", licence: "White Card", number: "", expiry: "" },
    ]);
    expect(r.lines.map((l) => l.verdict)).toEqual(["person_not_found", "unreadable"]);
    expect(r.counts.person_not_found).toBe(1);
    expect(r.counts.unreadable).toBe(1);
    expect(Object.values(r.counts).reduce((a, b) => a + b, 0)).toBe(2);
  });
});
