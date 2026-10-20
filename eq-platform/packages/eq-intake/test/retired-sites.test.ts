import { describe, it, expect } from "vitest";
import { splitRetired } from "../src/retired-sites.js";

describe("splitRetired", () => {
  const rows = [
    { site_id: "a", name: "Equinix SY9", active: true },
    { site_id: "b", name: "Equinix SY9", active: false },
    { site_id: "c", name: "No flag yet" },
  ];

  it("keeps merged (retired) sites out of the working list and counts them", () => {
    const r = splitRetired("sites", rows);
    expect(r.live.map((x) => x.site_id)).toEqual(["a", "c"]);
    expect(r.retired).toBe(1);
  });

  it("also keeps people who have left, and archived customers, contacts and assets, out of the working list", () => {
    for (const entity of ["staff", "customers", "contacts", "assets"]) {
      const r = splitRetired(entity, [{ id: "1", active: true }, { id: "2", active: false }, { id: "3" }]);
      expect(r.live.map((x) => x.id)).toEqual(["1", "3"]);
      expect(r.retired).toBe(1);
    }
  });

  it("leaves entities with no active flag alone", () => {
    const r = splitRetired("licences", [{ id: "1", active: false }]);
    expect(r.live).toHaveLength(1);
    expect(r.retired).toBe(0);
  });

  it("handles an empty list", () => {
    expect(splitRetired("sites", [])).toEqual({ live: [], retired: 0 });
  });
});
