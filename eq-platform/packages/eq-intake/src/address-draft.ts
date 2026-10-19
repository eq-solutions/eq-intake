/**
 * AI-drafted addresses for sites that have none. The model searches the web for each
 * named place; nothing it says is trusted until it passes the checks here, and the
 * person still approves every line. A suggestion without a source page the search
 * actually returned is thrown away, and so is one whose postcode disagrees with the
 * built-in suburb list. "Not sure" is a normal answer and leaves the site blank.
 */

import { knownSuburb } from './au-suburbs.js';
import { splitRetired } from './retired-sites.js';
import type { Proposal, SiteField, SiteRow } from './guided-tidy.js';

export const MAX_DRAFT_SITES = 20;
export const DRAFT_MODEL = 'claude-sonnet-4-5';

export interface DraftCandidate {
  id: string;
  name: string;
}

const blank = (v: unknown): boolean => v == null || String(v).trim() === '';

/** Live sites with a name and nothing at all in the address fields. */
export function draftCandidates(allRows: readonly SiteRow[]): DraftCandidate[] {
  const { live } = splitRetired('sites', allRows as unknown as Array<Record<string, unknown>>) as { live: unknown[] };
  return (live as SiteRow[])
    .filter((s) => !blank(s.name) && blank(s.address_line_1) && blank(s.suburb) && blank(s.state) && blank(s.postcode))
    .map((s) => ({ id: s.site_id, name: String(s.name).trim() }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_DRAFT_SITES);
}

export function buildDraftRequest(candidates: readonly DraftCandidate[]): Record<string, unknown> {
  const list = candidates.map((c) => `- id ${c.id}: ${c.name}`).join('\n');
  return {
    model: DRAFT_MODEL,
    max_tokens: 4000,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 20 }],
    messages: [{
      role: 'user',
      content:
        'These are site names from an Australian electrical contractor\'s records. For each one that is a real, ' +
        'specific place in Australia, use web search to find its street address.\n\n' +
        `${list}\n\n` +
        'Rules: only answer "found" when a search result clearly confirms BOTH the place and its address. ' +
        'If the name is a company, a person, a stock location, a general area, or you are not sure which site is meant, ' +
        'answer "not_sure". Never guess or fill in from memory. source_url must be a page from your search results.\n\n' +
        'Reply with ONLY this JSON, no other text:\n' +
        '{"results":[{"id":"<id>","status":"found"|"not_sure","address_line_1":"","suburb":"","state":"NSW","postcode":"2000","source_url":"https://..."}]}',
    }],
  };
}

const STATES = new Set(['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT']);

interface Block { type?: string; text?: string; content?: unknown }

function resultUrls(blocks: readonly Block[]): Set<string> {
  const urls = new Set<string>();
  for (const b of blocks) {
    if (b.type !== 'web_search_tool_result' || !Array.isArray(b.content)) continue;
    for (const r of b.content as Array<{ url?: unknown }>) if (typeof r.url === 'string') urls.add(r.url);
  }
  return urls;
}

function parseJson(text: string): unknown {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}

const clean = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim();

export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

export type DraftProposal = Proposal & { source: string };

/** Turns the model's reply into suggestions, dropping everything that does not check out. */
export function draftProposals(response: unknown, candidates: readonly DraftCandidate[]): DraftProposal[] {
  const blocks = ((response as { content?: unknown })?.content ?? []) as Block[];
  if (!Array.isArray(blocks)) return [];
  const urls = resultUrls(blocks);
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
  const parsed = parseJson(text) as { results?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.results)) return [];

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const out: DraftProposal[] = [];
  const seen = new Set<string>();
  for (const raw of parsed.results as Array<Record<string, unknown>>) {
    const cand = byId.get(clean(raw.id));
    if (!cand || seen.has(cand.id) || raw.status !== 'found') continue;
    const street = clean(raw.address_line_1);
    const suburb = clean(raw.suburb);
    const state = clean(raw.state).toUpperCase();
    const postcode = clean(raw.postcode);
    const source = clean(raw.source_url);
    if (!street || !suburb || !STATES.has(state) || !/^\d{4}$/.test(postcode)) continue;
    if (!/^https:\/\//i.test(source) || !urls.has(source)) continue;
    const known = knownSuburb(suburb);
    if (known && (known.postcode !== postcode || known.state !== state)) continue;

    seen.add(cand.id);
    const why = `Found on ${hostOf(source)}. Check it before you tick it`;
    const fields: Array<[SiteField, string]> = [['address_line_1', street], ['suburb', suburb], ['state', state], ['postcode', postcode]];
    for (const [field, value] of fields) {
      out.push({
        id: `${cand.id}:ai:${field}`, row_id: cand.id, row_label: cand.name, field,
        old_value: null, new_value: value, tier: 'check', kind: 'ai_draft', why, source,
      });
    }
  }
  return out;
}
