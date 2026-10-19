/**
 * @eq/intake — guided tidy for Sites.
 *
 * Reads the site records and PROPOSES changes, each with the reason it is
 * suggested and a tier saying how sure it is. It never writes: the screen shows
 * the list, a person approves, and the existing commit path applies it (with the
 * old values kept so it can be undone).
 *
 *   sure   read straight off what is already typed (a state or postcode after
 *          "NSW", a suburb that is the last part of the address) or pure
 *          formatting (spacing, CAPITALS, "Nsw"). Approved in one go.
 *   check  a sensible guess a person should glance at: a postcode borrowed from
 *          other sites in the same suburb, a likely misspelling.
 *   ask    when it is genuinely 50/50 (a suburb with two postcodes) it becomes a
 *          question with the candidates as options instead of a guess.
 *
 * Only blank fields are filled and only whole words are respelled; a value that is
 * already there is never overwritten by an address guess. Spelling is judged against
 * the tenant's own data plus a short built-in word list, because the names here are
 * mostly proper nouns: a word is only called a typo when it appears once and a very
 * similar word is used several times elsewhere.
 */

import { splitRetired } from './retired-sites.js';
import { knownSuburb } from './au-suburbs.js';

export type Tier = 'sure' | 'check';
export type ProposalKind = 'from_address' | 'from_suburb' | 'format' | 'spelling';
export type SiteField = 'name' | 'address_line_1' | 'address_line_2' | 'suburb' | 'state' | 'postcode';

export interface SiteRow {
  site_id: string;
  name?: string | null;
  address_line_1?: string | null;
  address_line_2?: string | null;
  suburb?: string | null;
  state?: string | null;
  postcode?: string | null;
  active?: boolean | null;
}

export interface Proposal {
  /** `${row_id}:${field}`, stable so a screen can untick one. */
  id: string;
  row_id: string;
  row_label: string;
  field: SiteField;
  old_value: string | null;
  new_value: string;
  tier: Tier;
  kind: ProposalKind;
  /** Plain-English reason shown next to the change. */
  why: string;
}

export interface QuestionOption {
  value: string;
  label: string;
}

/** A 50/50 the person has to settle: choosing an option turns into a proposal. */
export interface Question {
  id: string;
  row_id: string;
  row_label: string;
  field: 'postcode';
  title: string;
  detail: string;
  options: QuestionOption[];
}

export interface GuidedPlan {
  proposals: Proposal[];
  questions: Question[];
  counts: { sure: number; check: number; questions: number; sites: number; sites_total: number };
}

// ── Small helpers ────────────────────────────────────────────────────────────

const STATES = ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT'] as const;
const STATE_NAMES: Record<string, string> = {
  'new south wales': 'NSW', victoria: 'VIC', queensland: 'QLD', 'south australia': 'SA',
  'western australia': 'WA', tasmania: 'TAS', 'northern territory': 'NT', 'australian capital territory': 'ACT',
};
const STATE_WORD = new RegExp(`\\b(${STATES.join('|')})\\b`);
const STATE_THEN_POSTCODE = new RegExp(`\\b(${STATES.join('|')})\\b[.,]?\\s*(\\d{4})\\b`);
const STREET_WORDS = new Set([
  'street', 'st', 'road', 'rd', 'avenue', 'ave', 'drive', 'dr', 'lane', 'ln', 'place', 'pl', 'court', 'ct', 'crescent', 'cres',
  'highway', 'hwy', 'parade', 'pde', 'boulevard', 'blvd', 'way', 'close', 'terrace', 'tce', 'circuit', 'cct', 'level', 'floor',
  'unit', 'suite', 'building', 'tower', 'campus',
]);

const blank = (v: unknown): boolean => v === null || v === undefined || String(v).trim() === '';
const clean = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim();

function label(r: SiteRow): string {
  return clean(r.name) || 'Unnamed site';
}

const KEEP_UPPER = new Set<string>([...STATES, 'PO', 'BOX']);
export function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/(^|[\s\-'/(])([a-z])/g, (_m, pre: string, ch: string) => pre + ch.toUpperCase())
    .split(' ')
    .map((w) => (KEEP_UPPER.has(w.toUpperCase()) ? w.toUpperCase() : /\d/.test(w) ? w.toUpperCase() : w))
    .join(' ');
}

const LOWER_OK = new Set(['of', 'and', 'the', 'at', 'on', 'to', 'in', 'for', 'by', 'via']);

/** Mixed-case lines: "HIlls" -> "Hills", and a lowercase word -> "Word" ("technology place" -> "Technology Place"). */
export function fixCaps(s: string): string {
  return s
    .replace(/\b([A-Z])([A-Z])([a-z]+)\b/g, (_m, a: string, b: string, rest: string) => a + b.toLowerCase() + rest)
    .replace(/\b([a-z])([a-z]+)\b/g, (m, a: string, rest: string) => (LOWER_OK.has(m) ? m : a.toUpperCase() + rest));
}

const hasLetters = (s: string): boolean => /[a-z]/i.test(s);
const isAllCaps = (s: string): boolean => hasLetters(s) && s === s.toUpperCase() && s.replace(/[^A-Z]/g, '').length >= 4;
const isAllLower = (s: string): boolean => hasLetters(s) && s === s.toLowerCase() && s.replace(/[^a-z]/g, '').length >= 4;

// ── Reading an address line ──────────────────────────────────────────────────

export interface ParsedAddress {
  state?: string;
  postcode?: string;
  /** True when the postcode follows the state ("NSW 2015"), so it cannot be a street number. */
  postcodeAfterState: boolean;
  suburb?: { value: string; sure: boolean };
}

const STATE_NAME_RE = new RegExp(String.raw`\b(${Object.keys(STATE_NAMES).join('|')})\b`, 'gi');

export function parseAddress(text: string, knownSuburbs: ReadonlySet<string>): ParsedAddress {
  const t = clean(text).replace(STATE_NAME_RE, (m) => STATE_NAMES[m.toLowerCase()] ?? m);
  const out: ParsedAddress = { postcodeAfterState: false };
  if (!t) return out;

  const withPc = STATE_THEN_POSTCODE.exec(t);
  const stateOnly = STATE_WORD.exec(t);
  if (withPc) {
    out.state = withPc[1];
    out.postcode = withPc[2];
    out.postcodeAfterState = true;
  } else if (stateOnly) {
    out.state = stateOnly[1];
  }

  const cutAt = withPc ? withPc.index : stateOnly ? stateOnly.index : -1;
  const before = (cutAt >= 0 ? t.slice(0, cutAt) : t).replace(/[,\s]+$/, '');
  const segments = before.split(',').map((s) => s.trim()).filter(Boolean);
  const last = segments[segments.length - 1] ?? '';

  if (last && !/\d/.test(last)) {
    const words = last.split(' ');
    const isStreet = words.some((w) => STREET_WORDS.has(w.toLowerCase().replace(/\./g, '')));
    if (knownSuburbs.has(last.toLowerCase())) out.suburb = { value: titleCase(last), sure: cutAt >= 0 };
    else if (!isStreet && words.length <= 3 && (cutAt >= 0 || segments.length > 1)) out.suburb = { value: titleCase(last), sure: cutAt >= 0 };
  } else if (last && /\d/.test(last)) {
    // "133 Castlereagh Street Sydney": a known suburb at the end of a street line.
    const lower = last.toLowerCase();
    const hit = [...knownSuburbs].filter((k) => lower.endsWith(` ${k}`)).sort((a, b) => b.length - a.length)[0];
    if (hit && cutAt >= 0) out.suburb = { value: titleCase(hit), sure: false };
  }

  if (!out.postcode) {
    const tail = /(?:^|[\s,])(\d{4})\s*(?:,?\s*Australia)?\s*$/i.exec(t);
    if (tail && /[a-z]/i.test(t.slice(0, tail.index))) out.postcode = tail[1];
  }
  return out;
}

// ── Spelling ─────────────────────────────────────────────────────────────────

/** Words that are right and common in this trade's site and address names. Counted as "seen often". */
const BUILT_IN_WORDS = [
  'street', 'avenue', 'boulevard', 'crescent', 'highway', 'parade', 'terrace', 'circuit', 'drive', 'place', 'court', 'lane', 'road',
  'hospital', 'private', 'clinic', 'centre', 'center', 'health', 'medical', 'university', 'campus', 'building', 'tower', 'airport',
  'recycling', 'maintenance', 'property', 'services', 'engineering', 'electrical', 'construction', 'constructions', 'projects',
  'limited', 'australia', 'australian', 'industrial', 'warehouse', 'logistics', 'distribution', 'data', 'communications', 'systems',
  'theatre', 'school', 'college', 'library', 'station', 'shopping', 'village', 'gardens', 'heights', 'junction', 'international',
  'radiology', 'surgery', 'dental', 'pharmacy', 'laboratory', 'research', 'manufacturing', 'stadium', 'operations', 'technology',
  'airfield', 'parker', 'frederick', 'frenchs', 'forest', 'shepherd', 'berkeley', 'campbelltown', 'pharmaceuticals', 'pharmaceutical',
  'harbour', 'motorway', 'university', 'hills', 'church', 'mount', 'north', 'south', 'east', 'west', 'beach', 'bridge', 'park',
  'plaza', 'square', 'estate', 'precinct', 'northern', 'southern', 'eastern', 'western', 'central', 'general', 'national',
];

/** Optimal-string-alignment distance: one swap of two neighbouring letters counts as one edit. */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_v, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}

const WORD_RE = /[A-Za-z]{5,}/g;

function matchCase(from: string, to: string): string {
  if (from === from.toUpperCase()) return to.toUpperCase();
  if (from[0] === from[0]!.toUpperCase()) return to[0]!.toUpperCase() + to.slice(1);
  return to;
}

function buildVocabulary(rows: readonly SiteRow[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const w of BUILT_IN_WORDS) freq.set(w, 3);
  for (const r of rows) {
    for (const text of [r.name, r.address_line_1, r.address_line_2, r.suburb]) {
      for (const m of String(text ?? '').matchAll(WORD_RE)) {
        const w = m[0].toLowerCase();
        freq.set(w, (freq.get(w) ?? 0) + 1);
      }
    }
  }
  return freq;
}

/** The fixed word and why, or null. Only rare words that sit one or two letters from a well-used word. */
export function respell(text: string, vocab: ReadonlyMap<string, number>): { fixed: string; changes: Array<{ from: string; to: string; seen: number }> } | null {
  const changes: Array<{ from: string; to: string; seen: number }> = [];
  const fixed = text.replace(WORD_RE, (word) => {
    const w = word.toLowerCase();
    if ((vocab.get(w) ?? 0) >= 2) return word;
    const limit = w.length >= 8 ? 2 : 1;
    let best: { to: string; seen: number; dist: number } | null = null;
    for (const [cand, seen] of vocab) {
      if (seen < 3 || cand[0] !== w[0] || Math.abs(cand.length - w.length) > limit) continue;
      const dist = editDistance(w, cand);
      if (dist === 0 || dist > limit) continue;
      if (!best || dist < best.dist || (dist === best.dist && seen > best.seen)) best = { to: cand, seen, dist };
    }
    if (!best) return word;
    changes.push({ from: word, to: matchCase(word, best.to), seen: best.seen });
    return matchCase(word, best.to);
  });
  return changes.length > 0 ? { fixed, changes } : null;
}

// ── The plan ─────────────────────────────────────────────────────────────────

export function planSiteTidy(allRows: readonly SiteRow[]): GuidedPlan {
  const { live: rows } = splitRetired('sites', allRows as unknown as Array<Record<string, unknown>>) as { live: unknown[] };
  const sites = rows as SiteRow[];

  const knownSuburbs = new Set<string>();
  for (const s of sites) if (!blank(s.suburb)) knownSuburbs.add(clean(s.suburb).toLowerCase());

  const postcodesBySuburb = new Map<string, Map<string, number>>();
  const statesBySuburb = new Map<string, Map<string, number>>();
  const bump = (m: Map<string, Map<string, number>>, key: string, val: string): void => {
    const inner = m.get(key) ?? new Map<string, number>();
    inner.set(val, (inner.get(val) ?? 0) + 1);
    m.set(key, inner);
  };
  for (const s of sites) {
    if (blank(s.suburb)) continue;
    const key = clean(s.suburb).toLowerCase();
    if (!blank(s.postcode)) bump(postcodesBySuburb, key, clean(s.postcode));
    if (!blank(s.state)) bump(statesBySuburb, key, clean(s.state).toUpperCase());
  }

  const vocab = buildVocabulary(sites);
  const proposals: Proposal[] = [];
  const questions: Question[] = [];

  for (const s of sites) {
    const id = s.site_id;
    const lab = label(s);
    const taken = new Set<SiteField>();
    const add = (p: Omit<Proposal, 'id' | 'row_id' | 'row_label'>): void => {
      if (taken.has(p.field)) return;
      taken.add(p.field);
      proposals.push({ id: `${id}:${p.field}`, row_id: id, row_label: lab, ...p });
    };

    // 1. Formatting on what is already there (sure).
    for (const field of ['address_line_1', 'address_line_2', 'suburb'] as const) {
      const raw = s[field];
      if (blank(raw)) continue;
      const tidy = clean(raw).replace(/[,.\s]+$/, '');
      const cased = isAllCaps(tidy) || isAllLower(tidy) ? titleCase(tidy) : fixCaps(tidy);
      if (cased !== String(raw)) {
        add({ field, old_value: String(raw), new_value: cased, tier: 'sure', kind: 'format',
          why: cased === tidy ? 'Tidied spacing and stray punctuation' : 'Fixed the capital letters' });
      }
    }
    if (!blank(s.state)) {
      const st = clean(s.state);
      const mapped = STATE_NAMES[st.toLowerCase()] ?? st.toUpperCase();
      if (mapped !== String(s.state) && (STATES as readonly string[]).includes(mapped)) {
        add({ field: 'state', old_value: String(s.state), new_value: mapped, tier: 'sure', kind: 'format', why: 'Written the standard way' });
      }
    }
    if (!blank(s.name) && clean(s.name) !== String(s.name)) {
      add({ field: 'name', old_value: String(s.name), new_value: clean(s.name), tier: 'sure', kind: 'format', why: 'Removed extra spaces' });
    }

    // 2. Fill blanks from the address (sure when it is spelled out, else check).
    const addr = [s.address_line_1, s.address_line_2].map(clean).filter(Boolean).join(', ');
    const parsed = parseAddress(addr, knownSuburbs);
    let suburbNow = blank(s.suburb) ? '' : clean(s.suburb);
    if (blank(s.state) && parsed.state) {
      add({ field: 'state', old_value: null, new_value: parsed.state, tier: 'sure', kind: 'from_address', why: `"${parsed.state}" is in the address` });
    }
    if (blank(s.postcode) && parsed.postcode) {
      add({ field: 'postcode', old_value: null, new_value: parsed.postcode, tier: parsed.postcodeAfterState ? 'sure' : 'check', kind: 'from_address',
        why: parsed.postcodeAfterState ? `"${parsed.postcode}" follows the state in the address` : `The address ends in ${parsed.postcode}` });
    }
    if (blank(s.suburb) && parsed.suburb) {
      suburbNow = parsed.suburb.value;
      add({ field: 'suburb', old_value: null, new_value: parsed.suburb.value, tier: parsed.suburb.sure ? 'sure' : 'check', kind: 'from_address',
        why: parsed.suburb.sure ? 'It is the suburb written in the address' : 'It looks like the suburb at the end of the address' });
    }

    // 3. Borrow from other sites in the same suburb (check), or ask when they disagree.
    if (suburbNow) {
      const key = suburbNow.toLowerCase();
      if (blank(s.postcode) && !parsed.postcode) {
        const pcs = postcodesBySuburb.get(key);
        if (pcs && pcs.size === 1) {
          const [pc, n] = [...pcs][0]!;
          add({ field: 'postcode', old_value: null, new_value: pc, tier: 'check', kind: 'from_suburb',
            why: `${n} other site${n === 1 ? ' in' : 's in'} ${titleCase(suburbNow)} ${n === 1 ? 'uses' : 'use'} ${pc}` });
        } else if (pcs && pcs.size > 1) {
          questions.push({
            id: `${id}:postcode`, row_id: id, row_label: lab, field: 'postcode',
            title: `Which postcode is ${lab}?`,
            detail: `${titleCase(suburbNow)} has more than one postcode on your other sites.`,
            options: [...pcs].sort((a, b) => b[1] - a[1]).map(([pc, n]) => ({ value: pc, label: `${pc} (${n} site${n === 1 ? '' : 's'})` })),
          });
        }
        else if (!pcs) {
          const known = knownSuburb(suburbNow);
          if (known) {
            add({ field: 'postcode', old_value: null, new_value: known.postcode, tier: 'check', kind: 'from_suburb',
              why: `${titleCase(suburbNow)} is postcode ${known.postcode}` });
          }
        }
      }
      if (blank(s.state) && !parsed.state) {
        const sts = statesBySuburb.get(key);
        if (sts && sts.size === 1) {
          const [st, n] = [...sts][0]!;
          add({ field: 'state', old_value: null, new_value: st, tier: 'check', kind: 'from_suburb',
            why: `${n} other site${n === 1 ? '' : 's'} in ${titleCase(suburbNow)} ${n === 1 ? 'is' : 'are'} in ${st}` });
        }
        else if (!sts) {
          const known = knownSuburb(suburbNow);
          if (known) {
            add({ field: 'state', old_value: null, new_value: known.state, tier: 'check', kind: 'from_suburb',
              why: `${titleCase(suburbNow)} is in ${known.state}` });
          }
        }
      }
    }

    // 4. Likely misspellings (always check, never silent).
    for (const field of ['name', 'address_line_1', 'address_line_2', 'suburb'] as const) {
      const raw = s[field];
      if (blank(raw)) continue;
      const fixed = respell(clean(raw), vocab);
      if (!fixed) continue;
      add({ field, old_value: String(raw), new_value: fixed.fixed, tier: 'check', kind: 'spelling',
        why: fixed.changes.map((c) => `"${c.from}" looks like "${c.to}"`).join(', ') });
    }
  }

  proposals.sort((a, b) => (a.tier === b.tier ? a.row_label.localeCompare(b.row_label) : a.tier === 'sure' ? -1 : 1));
  const affected = new Set(proposals.map((p) => p.row_id));
  for (const q of questions) affected.add(q.row_id);
  return {
    proposals,
    questions,
    counts: {
      sure: proposals.filter((p) => p.tier === 'sure').length,
      check: proposals.filter((p) => p.tier === 'check').length,
      questions: questions.length,
      sites: affected.size,
      sites_total: sites.length,
    },
  };
}

// ── From proposals to writes, and back again (Undo) ─────────────────────────

/** Plain-English names for the fields the screen shows. */
export const FIELD_LABEL: Record<SiteField, string> = {
  name: 'Name',
  address_line_1: 'Street address',
  address_line_2: 'Address line 2',
  suburb: 'Suburb',
  state: 'State',
  postcode: 'Postcode',
};

/**
 * One write with both values kept. old_value / new_value may be null: a blank that was
 * never filled in goes back to null on Undo, not to an empty string.
 */
export interface GuidedFix {
  entity: 'site';
  table: 'sites';
  row_id: string;
  row_label: string;
  field: SiteField;
  fix_type: 'string';
  old_value: string | null;
  new_value: string | null;
}

export function proposalsToFixes(ps: readonly Proposal[]): GuidedFix[] {
  return ps.map((p) => ({
    entity: 'site', table: 'sites', row_id: p.row_id, row_label: p.row_label, field: p.field,
    fix_type: 'string', old_value: p.old_value, new_value: p.new_value,
  }));
}

/** The writes that put every value back as it was. */
export function undoFixes(fixes: readonly GuidedFix[]): GuidedFix[] {
  return fixes.map((f) => ({ ...f, old_value: f.new_value, new_value: f.old_value }));
}

/** A settled question becomes an ordinary proposal; "leave blank" (empty value) gives none. */
export function answerToProposal(q: Question, value: string): Proposal | null {
  if (!value) return null;
  return {
    id: q.id, row_id: q.row_id, row_label: q.row_label, field: q.field, old_value: null, new_value: value,
    tier: 'check', kind: 'from_suburb', why: 'You chose this one',
  };
}

/** Proposals grouped by site, in the order the sites first appear. */
export function groupBySite(ps: readonly Proposal[]): Array<{ row_id: string; row_label: string; items: Proposal[] }> {
  const out = new Map<string, { row_id: string; row_label: string; items: Proposal[] }>();
  for (const p of ps) {
    const g = out.get(p.row_id) ?? { row_id: p.row_id, row_label: p.row_label, items: [] };
    g.items.push(p);
    out.set(p.row_id, g);
  }
  return [...out.values()];
}
