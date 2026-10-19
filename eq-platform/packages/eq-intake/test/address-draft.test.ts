import { describe, it, expect } from "vitest";
import { buildDraftRequest, draftCandidates, draftProposals } from "../src/address-draft.js";

const row = (id: string, o: Record<string, unknown> = {}) => ({ site_id: id, name: `Site ${id}`, active: true, ...o });
const cands = [{ id: "a", name: "Strathfield Private Hospital" }, { id: "b", name: "Acme Pty Ltd" }];

const reply = (results: unknown[], urls: string[] = ["https://www.healthdirect.gov.au/x"]) => ({
  content: [
    { type: "web_search_tool_result", content: urls.map((url) => ({ type: "web_search_result", url })) },
    { type: "text", text: "Here you go:\n" + JSON.stringify({ results }) },
  ],
});
const found = (o: Record<string, unknown> = {}) => ({ id: "a", status: "found", address_line_1: "6 Everton Rd", suburb: "Strathfield", state: "NSW", postcode: "2135", source_url: "https://www.healthdirect.gov.au/x", ...o });

describe("who gets an address lookup", () => {
  it("only live sites with a name and every address field blank", () => {
    const list = draftCandidates([
      row("1"),
      row("2", { address_line_1: "1 Smith St" }),
      row("3", { suburb: "Huntingwood" }),
      row("4", { name: "  " }),
      row("5", { active: false }),
    ]);
    expect(list.map((c) => c.id)).toEqual(["1"]);
  });

  it("asks for the web search tool and a source for each", () => {
    const req = buildDraftRequest(cands) as { tools: Array<{ name: string }>; messages: Array<{ content: string }> };
    expect(req.tools[0]!.name).toBe("web_search");
    expect(req.messages[0]!.content).toContain("Strathfield Private Hospital");
    expect(req.messages[0]!.content).toContain("not_sure");
  });
});

describe("checking what the model says", () => {
  it("turns a confirmed address into four suggestions that are checks with the source", () => {
    const ps = draftProposals(reply([found()]), cands);
    expect(ps.map((p) => `${p.field}=${p.new_value}`)).toEqual(["address_line_1=6 Everton Rd", "suburb=Strathfield", "state=NSW", "postcode=2135"]);
    expect(ps.every((p) => p.tier === "check" && p.kind === "ai_draft" && p.old_value === null && p.source === "https://www.healthdirect.gov.au/x")).toBe(true);
  });

  it("drops not_sure answers, unknown ids and missing parts", () => {
    expect(draftProposals(reply([{ id: "b", status: "not_sure" }]), cands)).toEqual([]);
    expect(draftProposals(reply([found({ id: "zzz" })]), cands)).toEqual([]);
    expect(draftProposals(reply([found({ postcode: "21" })]), cands)).toEqual([]);
    expect(draftProposals(reply([found({ state: "XX" })]), cands)).toEqual([]);
    expect(draftProposals(reply([found({ address_line_1: "" })]), cands)).toEqual([]);
  });

  it("drops a source the search did not return, or one that is not https", () => {
    expect(draftProposals(reply([found({ source_url: "https://invented.example/page" })]), cands)).toEqual([]);
    expect(draftProposals(reply([found({ source_url: "http://www.healthdirect.gov.au/x" })], ["http://www.healthdirect.gov.au/x"]), cands)).toEqual([]);
  });

  it("drops an address whose postcode disagrees with the built-in suburb list", () => {
    expect(draftProposals(reply([found({ postcode: "2000" })]), cands)).toEqual([]);
  });

  it("survives a reply that is not the JSON we asked for", () => {
    expect(draftProposals({ content: [{ type: "text", text: "Sorry, I can't." }] }, cands)).toEqual([]);
    expect(draftProposals(null, cands)).toEqual([]);
  });
});
