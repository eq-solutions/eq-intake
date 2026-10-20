import { describe, it, expect } from "vitest";
import { lookupAddresses, type LookupFetch } from "../src/module/ai-address-lookup.js";

const cands = [{ id: "a", name: "Strathfield Private Hospital" }];
const ok = (body: unknown): LookupFetch => async () => ({ ok: true, status: 200, json: async () => body });
const status = (code: number): LookupFetch => async () => ({ ok: false, status: code, json: async () => ({}) });

describe("address lookup", () => {
  it("sends nothing when there are no sites to look up", async () => {
    let called = false;
    const r = await lookupAddresses([], async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; });
    expect(called).toBe(false);
    expect(r).toEqual({ proposals: [], failed: 0 });
  });

  it("posts to the AI proxy with the signed-in cookie and returns checked suggestions", async () => {
    let seen: { url: string; credentials: string } | null = null;
    const body = {
      content: [
        { type: "web_search_tool_result", content: [{ url: "https://www.healthdirect.gov.au/x" }] },
        { type: "text", text: JSON.stringify({ results: [{ id: "a", status: "found", address_line_1: "6 Everton Rd", suburb: "Strathfield", state: "NSW", postcode: "2135", source_url: "https://www.healthdirect.gov.au/x" }] }) },
      ],
    };
    const f: LookupFetch = async (url, init) => { seen = { url, credentials: init.credentials }; return { ok: true, status: 200, json: async () => body }; };
    const out = await lookupAddresses(cands, f);
    expect(seen).toEqual({ url: "/api/anthropic-proxy/messages", credentials: "include" });
    expect(out.proposals).toHaveLength(5);
    expect(out.failed).toBe(0);
  });

  it("says why in plain words when it is refused or fails", async () => {
    await expect(lookupAddresses(cands, status(403))).rejects.toThrow(/permission/);
    await expect(lookupAddresses(cands, status(429))).rejects.toThrow(/too many/);
    await expect(lookupAddresses(cands, status(500))).rejects.toThrow(/Nothing was changed/);
    expect(await lookupAddresses(cands, ok({ content: [] }))).toEqual({ proposals: [], failed: 0 });
  });

  it("goes a couple of sites at a time, and keeps what worked when one batch fails", async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, name: `Place ${i}` }));
    let calls = 0;
    const flaky: LookupFetch = async (_u, init) => {
      calls++;
      const text = (JSON.parse(init.body) as { messages: Array<{ content: string }> }).messages[0]!.content;
      if (text.includes("id s2")) return { ok: false, status: 504, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ content: [] }) };
    };
    const seen: number[] = [];
    const out = await lookupAddresses(many, flaky, (p) => seen.push(p.checked));
    expect(calls).toBe(3);
    expect(out.failed).toBe(2);
    expect(seen[seen.length - 1]).toBe(6);
  });
});
