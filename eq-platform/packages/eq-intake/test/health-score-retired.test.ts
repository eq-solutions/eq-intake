import { describe, it, expect } from "vitest";
import { computeHealthScores } from "../src/health-score.js";

/**
 * Merged (retired) sites stay in the database. The Overview's totals and gap
 * counts must not include them: on SKS they made "264 records" out of 210 live
 * sites and inflated every "missing postcode / suburb" count with empty copies.
 */
describe("computeHealthScores and retired sites", () => {
  it("leaves active = false sites out of the total and the gap counts, and asks for the column", async () => {
    const asked: Record<string, string[]> = {};
    const sitesRows = [
      { name: "Equinix SY9", active: true, postcode: "2142" },
      { name: "Equinix SY9", active: false }, // merged copy, nothing filled in
      { name: "SY5", active: false },
      { name: "Port Macquarie", postcode: null }, // no flag: still counted
    ];
    const client = {
      rpc: async (fn: string, args: { p_table: string; p_columns: string[] }) => {
        expect(fn).toBe("eq_tidy_read_entity_columns");
        asked[args.p_table] = args.p_columns;
        return { data: args.p_table === "sites" ? sitesRows : [], error: null };
      },
    };

    const scores = await computeHealthScores(client as never);
    const sites = scores.find((s) => s.entity === "sites")!;

    expect(asked["sites"]).toContain("active");
    expect(sites.total).toBe(2);
    expect(sites.gapCounts["postcode"] ?? 0).toBeLessThanOrEqual(1);
  });
});
