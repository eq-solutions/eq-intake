import { describe, it, expect } from "vitest";
import { FIELD_LABEL, answerToProposal, editDistance, fixCaps, groupBySite, parseAddress, planSiteTidy, proposalsToFixes, respell, titleCase, undoFixes, type SiteRow } from "../src/guided-tidy.js";

const site = (id: string, o: Partial<SiteRow> = {}): SiteRow => ({ site_id: id, name: `Site ${id}`, active: true, ...o });
const get = (plan: ReturnType<typeof planSiteTidy>, id: string, field: string) => plan.proposals.find((p) => p.row_id === id && p.field === field);

describe("reading an address", () => {
  const known = new Set(["sydney", "eastern creek"]);

  it("takes suburb, state and postcode that are spelled out", () => {
    expect(parseAddress("200 Bourke Rd, Alexandria NSW 2015", known)).toMatchObject({ state: "NSW", postcode: "2015", postcodeAfterState: true, suburb: { value: "Alexandria", sure: true } });
  });

  it("does not mistake a four digit street number for a postcode", () => {
    const p = parseAddress("2000 Smith Street", known);
    expect(p.postcode).toBeUndefined();
  });

  it("finds a known suburb at the end of a street line, but only as a check", () => {
    const p = parseAddress("Level 10, 133 Castlereagh Street Sydney NSW ", known);
    expect(p.state).toBe("NSW");
    expect(p.suburb).toEqual({ value: "Sydney", sure: false });
  });

  it("treats a trailing word after a comma as a likely suburb, not a street", () => {
    expect(parseAddress("10 Hill Road, Homebush", known).suburb).toEqual({ value: "Homebush", sure: false });
    expect(parseAddress("17 Roberts Road", known).suburb).toBeUndefined();
  });
});

describe("spelling", () => {
  it("measures a swapped pair of letters as one edit", () => {
    expect(editDistance("recylcling", "recycling")).toBe(1);
    expect(editDistance("abc", "abc")).toBe(0);
  });

  it("fixes a rare word that sits next to a well-used one, keeping the original capital letters", () => {
    const vocab = new Map([["recycling", 3]]);
    expect(respell("Scrap Metal & Recylcling Pty Ltd", vocab)?.fixed).toBe("Scrap Metal & Recycling Pty Ltd");
  });

  it("leaves brand and place names alone when nothing similar is used elsewhere", () => {
    const vocab = new Map([["recycling", 3], ["hospital", 3]]);
    expect(respell("Zi-argos", vocab)).toBeNull();
    expect(respell("Lawrence Hargraves", vocab)).toBeNull();
  });

  it("never touches a word that is already used more than once", () => {
    const vocab = new Map([["hargraves", 2], ["hargrave", 5]]);
    expect(respell("Hargraves", vocab)).toBeNull();
  });
});

describe("capital letters in mixed lines", () => {
  it("fixes odd capitals and lowercase words, but leaves small joining words and codes", () => {
    expect(fixCaps("Surry HIlls")).toBe("Surry Hills");
    expect(fixCaps("3 technology place Macquarie park")).toBe("3 Technology Place Macquarie Park");
    expect(fixCaps("Corner of Darcy & Mons Rd, Westmead NSW 2145")).toBe("Corner of Darcy & Mons Rd, Westmead NSW 2145");
    expect(fixCaps("GATE 2 - 148 Shepherd Street")).toBe("GATE 2 - 148 Shepherd Street");
  });
});

describe("title case", () => {
  it("handles hyphens, apostrophes and the state codes", () => {
    expect(titleCase("EASTERN CREEK")).toBe("Eastern Creek");
    expect(titleCase("o'brien-smith rd")).toBe("O'Brien-Smith Rd");
    expect(titleCase("sydney nsw")).toBe("Sydney NSW");
  });
});

describe("planSiteTidy", () => {
  const sites: SiteRow[] = [
    site("a", { address_line_1: "200 Bourke Rd, Alexandria NSW 2015" }),
    site("b", { address_line_1: "17 ROBERTS ROAD", suburb: "Eastern Creek", state: "Nsw" }),
    site("c", { address_line_1: "1 Roberts Rd", suburb: "Eastern Creek", postcode: "2766", state: "NSW" }),
    site("d", { address_line_1: "2 Roberts Rd", suburb: "Eastern Creek", postcode: "2766", state: "NSW" }),
    site("e", { name: "Scrap Metal & Recylcling Pty Ltd" }),
    site("f", { name: "Recycling Hub" }), site("g", { name: "Recycling Yard" }), site("h", { name: "Recycling Depot" }),
    site("i", { name: "Zi-argos" }),
    site("j", { address_line_1: "5 Park St", suburb: "Wetherill Park", postcode: "2164", state: "NSW" }),
    site("k", { address_line_1: "6 Park St", suburb: "Wetherill Park", postcode: "2165", state: "NSW" }),
    site("l", { address_line_1: "7 Park St", suburb: "Wetherill Park", state: "NSW" }),
    site("m", { address_line_1: "9 Gone St, Gone NSW 2999", active: false }),
    site("n", { address_line_1: "99 Keep Rd, Strathfield NSW 2135", suburb: "Strathfield", postcode: "2000", state: "NSW" }),
  ];
  const plan = planSiteTidy(sites);

  it("fills blanks from a spelled out address as sure changes", () => {
    expect(get(plan, "a", "suburb")).toMatchObject({ new_value: "Alexandria", tier: "sure", kind: "from_address" });
    expect(get(plan, "a", "state")).toMatchObject({ new_value: "NSW", tier: "sure" });
    expect(get(plan, "a", "postcode")).toMatchObject({ new_value: "2015", tier: "sure", old_value: null });
  });

  it("fixes capitals and the state code as sure formatting, with the reason", () => {
    expect(get(plan, "b", "address_line_1")).toMatchObject({ new_value: "17 Roberts Road", tier: "sure", kind: "format", why: "Fixed the capital letters" });
    expect(get(plan, "b", "state")).toMatchObject({ old_value: "Nsw", new_value: "NSW", tier: "sure" });
  });

  it("borrows a postcode from other sites in the suburb as a check, and says how many", () => {
    expect(get(plan, "b", "postcode")).toMatchObject({ new_value: "2766", tier: "check", kind: "from_suburb" });
    expect(get(plan, "b", "postcode")!.why).toContain("2 other sites");
  });

  it("turns a suburb with two postcodes into a question, not a guess", () => {
    expect(get(plan, "l", "postcode")).toBeUndefined();
    const q = plan.questions.find((x) => x.row_id === "l")!;
    expect(q.options.map((o) => o.value).sort()).toEqual(["2164", "2165"]);
  });

  it("flags the misspelling as a check and leaves brand names alone", () => {
    expect(get(plan, "e", "name")).toMatchObject({ new_value: "Scrap Metal & Recycling Pty Ltd", tier: "check", kind: "spelling" });
    expect(get(plan, "i", "name")).toBeUndefined();
  });

  it("never overwrites a value that is already there, and ignores retired sites", () => {
    expect(get(plan, "n", "postcode")).toBeUndefined();
    expect(plan.proposals.some((p) => p.row_id === "m")).toBe(false);
    expect(plan.counts.sites_total).toBe(sites.length - 1);
  });

  it("words the reason correctly for one site and for several", () => {
    const one = planSiteTidy([site("x", { suburb: "Mosman" }), site("y", { suburb: "Mosman", state: "NSW" })]);
    expect(get(one, "x", "state")!.why).toBe("1 other site in Mosman is in NSW");
    expect(get(plan, "b", "postcode")!.why).toBe("2 other sites in Eastern Creek use 2766");
  });

  it("lists the sure changes first and counts them", () => {
    const firstCheck = plan.proposals.findIndex((p) => p.tier === "check");
    expect(plan.proposals.slice(0, firstCheck).every((p) => p.tier === "sure")).toBe(true);
    expect(plan.counts.sure + plan.counts.check).toBe(plan.proposals.length);
    expect(plan.counts.questions).toBe(1);
  });
});

describe("applying and undoing", () => {
  it("turns proposals into writes that Undo puts back exactly, including a blank that was null", () => {
    const plan = planSiteTidy([site("a", { address_line_1: "200 Bourke Rd, Alexandria NSW 2015" })]);
    const fixes = proposalsToFixes(plan.proposals);
    expect(fixes.every((f) => f.table === "sites" && f.entity === "site")).toBe(true);
    const back = undoFixes(fixes);
    const postcode = back.find((f) => f.field === "postcode")!;
    expect(postcode.new_value).toBeNull();
    expect(postcode.old_value).toBe("2015");
    expect(undoFixes(back)).toEqual(fixes);
  });

  it("makes a settled question into a proposal, and leave-blank into nothing", () => {
    const plan = planSiteTidy([
      site("j", { suburb: "Wetherill Park", postcode: "2164", state: "NSW" }),
      site("k", { suburb: "Wetherill Park", postcode: "2165", state: "NSW" }),
      site("l", { suburb: "Wetherill Park", state: "NSW" }),
    ]);
    const q = plan.questions[0]!;
    expect(answerToProposal(q, "2165")).toMatchObject({ row_id: "l", field: "postcode", new_value: "2165", old_value: null });
    expect(answerToProposal(q, "")).toBeNull();
  });

  it("groups by site and labels fields in plain English", () => {
    const plan = planSiteTidy([site("a", { address_line_1: "200 Bourke Rd, Alexandria NSW 2015" })]);
    const g = groupBySite(plan.proposals);
    expect(g).toHaveLength(1);
    expect(g[0]!.items.length).toBe(3);
    expect(FIELD_LABEL.address_line_1).toBe("Street address");
  });
});

describe("filling from the retired copy of the same site", () => {
  const retired = (id: string, o: Partial<SiteRow> = {}): SiteRow => ({ site_id: id, name: "Norwest CBA Data Centre", active: false, ...o });

  it("offers the retired twin's address when the live site has none", () => {
    const plan = planSiteTidy([
      site("live", { name: "Norwest CBA Data Centre" }),
      retired("old", { address_line_1: "11 Irvine Place", suburb: "Bella Vista", state: "NSW", postcode: "2153" }),
    ]);
    expect(plan.proposals.filter((p) => p.row_id === "live").map((p) => `${p.field}=${p.new_value}`).sort())
      .toEqual(["address_line_1=11 Irvine Place", "postcode=2153", "state=NSW", "suburb=Bella Vista"]);
    expect(get(plan, "live", "address_line_1")).toMatchObject({ tier: "check", kind: "from_twin" });
  });

  it("drops a trailing comma the old record carried", () => {
    const plan = planSiteTidy([site("live", { name: "Norwest CBA Data Centre", address_line_1: "" }), retired("old", { address_line_1: "3 Sydney St," })]);
    expect(get(plan, "live", "address_line_1")?.new_value).toBe("3 Sydney St");
  });

  it("matches the name ignoring capitals and spacing, and never fills over a street address", () => {
    const withTwin = planSiteTidy([site("live", { name: "norwest cba  data centre" }), retired("old", { address_line_1: "11 Irvine Place" })]);
    expect(get(withTwin, "live", "address_line_1")?.new_value).toBe("11 Irvine Place");
    const hasAddress = planSiteTidy([site("live", { name: "Norwest CBA Data Centre", address_line_1: "86 Kareena Rd" }), retired("old", { address_line_1: "49 Kareena Rd", postcode: "2229" })]);
    expect(hasAddress.proposals.some((p) => p.kind === "from_twin")).toBe(false);
  });

  it("does nothing when two retired twins disagree, or there is no twin", () => {
    const clash = planSiteTidy([site("live", { name: "Norwest CBA Data Centre" }), retired("a", { address_line_1: "1 A St" }), retired("b", { address_line_1: "2 B St" })]);
    expect(clash.proposals.some((p) => p.kind === "from_twin")).toBe(false);
    expect(planSiteTidy([site("live", { name: "Norwest CBA Data Centre" })]).proposals.some((p) => p.kind === "from_twin")).toBe(false);
  });
});

describe("postcodes from the built-in suburb list", () => {
  it("fills a blank postcode for a suburb with one postcode, as a check, when no other site answers it", () => {
    const plan = planSiteTidy([site("a", { address_line_1: "35 Huntingwood Drive", suburb: "Huntingwood", state: "NSW", postcode: null })]);
    expect(get(plan, "a", "postcode")).toMatchObject({ new_value: "2148", tier: "check", kind: "from_suburb" });
  });

  it("fills a blank state the same way", () => {
    const plan = planSiteTidy([site("a", { suburb: "Hunters Hill", state: null, postcode: "2110" })]);
    expect(get(plan, "a", "state")).toMatchObject({ new_value: "NSW", tier: "check" });
  });

  it("leaves unknown suburbs alone, and lets the tenant's own sites win over the list", () => {
    const unknown = planSiteTidy([site("a", { suburb: "Nowhereville", state: "NSW", postcode: null })]);
    expect(get(unknown, "a", "postcode")).toBeUndefined();
    const own = planSiteTidy([
      site("a", { suburb: "Huntingwood", state: "NSW", postcode: null }),
      site("b", { suburb: "Huntingwood", state: "NSW", postcode: "2999" }),
    ]);
    expect(get(own, "a", "postcode")).toMatchObject({ new_value: "2999" });
  });
});
