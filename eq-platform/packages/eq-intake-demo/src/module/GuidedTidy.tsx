/**
 * Guided tidy for Sites: the screen that does the looking so a person only has to
 * approve. It shows what can be filled in or fixed with the reason for each, in
 * three groups (sure things, worth a quick look, a question when it is 50/50),
 * applies only what is ticked, and keeps an Undo for every batch.
 *
 * The suggestions come from planSiteTidy() in @eq/intake (pure, no writes). Writes
 * go through the same commit the old Tidy tab uses; Undo writes the old values back.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import {
  fetchCanonicalRows,
  commitTidyFixes,
  planSiteTidy,
  proposalsToFixes,
  undoFixes,
  answerToProposal,
  groupBySite,
  FIELD_LABEL,
  type CanonicalFetchClient,
  type GuidedPlan,
  type GuidedFix,
  type GuidedSiteRow,
  type Proposal,
  type TidyFix,
} from "@eq/intake";
import type { SupabaseLikeClient } from "../canonical/commit-canonical.js";
import { loadBatches, nextSelection, pushBatch, saveBatches, type TidyBatch } from "./guided-tidy-history.js";
import { describeCounts } from "./GuidedTidyCard.js";

export interface GuidedTidyProps {
  supabase?: SupabaseLikeClient | null;
  tenantId?: string;
  /** Whoever may edit records (intake.edit_canonical). Everyone else sees the suggestions read-only. */
  canEdit?: boolean;
  onBack: () => void;
  /** Called after anything was applied or undone, so the Overview recounts. */
  onDataChanged?: () => void;
}

const plural = (n: number, one: string, many: string = `${one}s`): string => `${n.toLocaleString()} ${n === 1 ? one : many}`;

async function loadPlan(supabase: SupabaseLikeClient): Promise<GuidedPlan> {
  const rows = await fetchCanonicalRows(supabase as unknown as CanonicalFetchClient, "sites");
  return planSiteTidy(rows as unknown as GuidedSiteRow[]);
}

function commit(supabase: SupabaseLikeClient, tenantId: string, fixes: GuidedFix[]) {
  // null is a valid new value (a blank that Undo puts back); the commit RPC writes it as NULL.
  return commitTidyFixes({
    supabase: supabase as unknown as Parameters<typeof commitTidyFixes>[0]["supabase"],
    tenantId,
    fixes: fixes as unknown as TidyFix[],
  });
}

function ChangeRow({ p, checked, onToggle, disabled }: { p: Proposal; checked: boolean; onToggle: () => void; disabled: boolean }): JSX.Element {
  return (
    <label className="eq-gt-change">
      <input type="checkbox" checked={checked} onChange={onToggle} disabled={disabled} />
      <span className="eq-gt-change__body">
        <span className="eq-gt-change__what">{FIELD_LABEL[p.field]}</span>
        <span className="eq-gt-change__values">
          {p.old_value ? <s className="eq-gt-old">{p.old_value}</s> : <em className="eq-gt-blank">blank</em>}
          <span aria-hidden="true"> → </span>
          <strong>{p.new_value}</strong>
        </span>
        <span className="eq-gt-change__why">{p.why}</span>
      </span>
    </label>
  );
}

function Section({
  title, sub, items, selected, onToggle, onToggleAll, disabled, footer,
}: {
  title: string; sub: string; items: Proposal[]; selected: ReadonlySet<string>;
  onToggle: (id: string) => void; onToggleAll: (ids: string[], on: boolean) => void; disabled: boolean;
  /** Shown under the last site of the group, e.g. an Apply button so nobody has to scroll to the end. */
  footer?: ReactNode;
}): JSX.Element | null {
  if (items.length === 0) return null;
  const allOn = items.every((p) => selected.has(p.id));
  return (
    <section className="eq-gt-section">
      <div className="eq-gt-section__head">
        <div>
          <h3 className="eq-gt-section__title">{title}</h3>
          <p className="eq-gt-section__sub">{sub}</p>
        </div>
        {!disabled && (
          <button type="button" className="eq-intake-btn-ghost" onClick={() => onToggleAll(items.map((p) => p.id), !allOn)}>
            {allOn ? "Untick all" : "Tick all"}
          </button>
        )}
      </div>
      {groupBySite(items).map((g) => (
        <div className="eq-gt-site" key={g.row_id}>
          <p className="eq-gt-site__name">{g.row_label}</p>
          {g.items.map((p) => (
            <ChangeRow key={p.id} p={p} checked={selected.has(p.id)} onToggle={() => onToggle(p.id)} disabled={disabled} />
          ))}
        </div>
      ))}
      {footer && <div className="eq-gt-section__foot">{footer}</div>}
    </section>
  );
}

export function GuidedTidy({ supabase, tenantId, canEdit = false, onBack, onDataChanged }: GuidedTidyProps): JSX.Element {
  const [plan, setPlan] = useState<GuidedPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);
  const [batches, setBatches] = useState<TidyBatch[]>(() => loadBatches(tenantId));

  const knownIds = useRef<Set<string>>(new Set());
  const bannerRef = useRef<HTMLDivElement | null>(null);

  // keep = true after an apply: whatever is still on offer stays ticked or answered as it was.
  const load = useCallback(async (keep: boolean = false) => {
    if (!supabase) { setError("No database connection available."); return; }
    setError(null);
    try {
      const next = await loadPlan(supabase);
      setPlan(next);
      if (keep) {
        setSelected((prev) => nextSelection(prev, knownIds.current, next.proposals));
        const stillAsked = new Set(next.questions.map((q) => q.id));
        setAnswers((a) => Object.fromEntries(Object.entries(a).filter(([id]) => stillAsked.has(id))));
      } else {
        setSelected(new Set(next.proposals.filter((p) => p.tier === "sure").map((p) => p.id)));
        setAnswers({});
      }
      knownIds.current = new Set(next.proposals.map((p) => p.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't read your sites.");
    }
  }, [supabase]);

  useEffect(() => { void load(); }, [load]);

  const sure = useMemo(() => plan?.proposals.filter((p) => p.tier === "sure") ?? [], [plan]);
  const check = useMemo(() => plan?.proposals.filter((p) => p.tier === "check") ?? [], [plan]);
  const answered = useMemo(
    () => (plan?.questions ?? []).map((q) => answerToProposal(q, answers[q.id] ?? "")).filter((p): p is Proposal => p !== null),
    [plan, answers],
  );
  const chosen = useMemo(() => [...(plan?.proposals ?? []).filter((p) => selected.has(p.id)), ...answered], [plan, selected, answered]);

  const toggle = (id: string): void => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = (ids: string[], on: boolean): void => setSelected((s) => { const n = new Set(s); for (const id of ids) { if (on) n.add(id); else n.delete(id); } return n; });

  const sureChosen = useMemo(() => sure.filter((p) => selected.has(p.id)), [sure, selected]);

  // Applies the given suggestions (default: everything ticked or answered).
  useEffect(() => {
    if (notice) bannerRef.current?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }, [notice]);

  const apply = async (list: Proposal[] = chosen): Promise<void> => {
    if (!supabase || !tenantId || list.length === 0) return;
    setBusy(true);
    setNotice(null);
    try {
      const fixes = proposalsToFixes(list);
      const result = await commit(supabase, tenantId, fixes);
      const batch: TidyBatch = { id: crypto.randomUUID(), at: new Date().toISOString(), count: result.applied, fixes };
      const nextBatches = pushBatch(batches, batch);
      setBatches(nextBatches);
      saveBatches(tenantId, nextBatches);
      setNotice(result.skipped > 0
        ? { kind: "warn", text: `Applied ${plural(result.applied, "change")}. ${plural(result.skipped, "change")} couldn't be saved and were left as they were.` }
        : { kind: "ok", text: `Applied ${plural(result.applied, "change")}. You can undo this below.` });
      onDataChanged?.();
      await load(true);
    } catch (e) {
      setNotice({ kind: "warn", text: e instanceof Error ? e.message : "That didn't save. Nothing was changed." });
    } finally {
      setBusy(false);
    }
  };

  const undo = async (batch: TidyBatch): Promise<void> => {
    if (!supabase || !tenantId) return;
    setBusy(true);
    setNotice(null);
    try {
      await commit(supabase, tenantId, undoFixes(batch.fixes));
      const rest = batches.filter((b) => b.id !== batch.id);
      setBatches(rest);
      saveBatches(tenantId, rest);
      setNotice({ kind: "ok", text: `Put ${plural(batch.count, "change")} back as they were.` });
      onDataChanged?.();
      await load();
    } catch (e) {
      setNotice({ kind: "warn", text: e instanceof Error ? e.message : "That didn't undo. Nothing was changed." });
    } finally {
      setBusy(false);
    }
  };

  const nothing = plan !== null && plan.proposals.length === 0 && plan.questions.length === 0;

  return (
    <div className="eq-gt">
      <div className="eq-gt__head">
        <button type="button" className="eq-drill__back" onClick={onBack}>← Back</button>
        <h2 className="eq-gt__title">Tidy up your sites</h2>
      </div>

      {error && <div className="eq-gt-banner eq-gt-banner--warn" role="alert">{error}</div>}
      {notice && <div ref={bannerRef} className={`eq-gt-banner eq-gt-banner--${notice.kind}`} role="status">{notice.text}</div>}
      {!plan && !error && <p className="eq-gt__loading">Looking through your sites…</p>}

      {plan && (
        <>
          <p className="eq-gt__summary">
            {nothing
              ? "Nothing to tidy. Your sites look good."
              : `I can help with ${plural(plan.counts.sites, "site")} out of ${plan.counts.sites_total.toLocaleString()}.`}
          </p>
          {!nothing && (
            <p className="eq-gt__detail">{describeCounts(plan.counts)}. Nothing changes until you press Apply.</p>
          )}
          {!canEdit && !nothing && (
            <div className="eq-gt-banner eq-gt-banner--warn" role="status">You can look but not change anything. Ask a manager or supervisor to tidy these.</div>
          )}

          <Section
            title="Sure things"
            sub="Read straight from what's already typed, or just spacing and capital letters. Untick anything you don't want."
            items={sure} selected={selected} onToggle={toggle} onToggleAll={toggleAll} disabled={!canEdit || busy}
            footer={canEdit && (
              <div className="eq-gt-actions eq-gt-actions--inline">
                <button type="button" className="eq-intake-btn-primary" onClick={() => void apply(sureChosen)} disabled={busy || sureChosen.length === 0}>
                  {busy ? "Working…" : sureChosen.length === 0 ? "Nothing ticked" : `Apply ${plural(sureChosen.length, "change")}`}
                </button>
                <span className="eq-gt__detail">Just these ones. You can undo it afterwards.</span>
              </div>
            )}
          />
          <Section
            title="Worth a quick look"
            sub="Good guesses, like a postcode other sites in the same suburb use, or a word that looks misspelled. Tick the ones you agree with."
            items={check} selected={selected} onToggle={toggle} onToggleAll={toggleAll} disabled={!canEdit || busy}
          />

          {plan.questions.length > 0 && (
            <section className="eq-gt-section">
              <div className="eq-gt-section__head">
                <div>
                  <h3 className="eq-gt-section__title">Your call</h3>
                  <p className="eq-gt-section__sub">These could go either way, so I'm asking instead of guessing.</p>
                </div>
              </div>
              {plan.questions.map((q) => (
                <fieldset className="eq-gt-question" key={q.id} disabled={!canEdit || busy}>
                  <legend className="eq-gt-question__title">{q.title}</legend>
                  <p className="eq-gt-section__sub">{q.detail}</p>
                  {q.options.map((o) => (
                    <label className="eq-gt-option" key={o.value}>
                      <input type="radio" name={q.id} checked={answers[q.id] === o.value} onChange={() => setAnswers((a) => ({ ...a, [q.id]: o.value }))} />
                      {o.label}
                    </label>
                  ))}
                  <label className="eq-gt-option">
                    <input type="radio" name={q.id} checked={(answers[q.id] ?? "") === ""} onChange={() => setAnswers((a) => ({ ...a, [q.id]: "" }))} />
                    Leave it blank for now
                  </label>
                </fieldset>
              ))}
            </section>
          )}

          {!nothing && canEdit && (
            <div className="eq-gt-actions">
              <button type="button" className="eq-intake-btn-primary" onClick={() => void apply()} disabled={busy || chosen.length === 0}>
                {busy ? "Working…" : chosen.length === 0 ? "Nothing ticked" : `Apply ${plural(chosen.length, "change")}`}
              </button>
              <span className="eq-gt__detail">You can undo it afterwards.</span>
            </div>
          )}
        </>
      )}

      {batches.length > 0 && (
        <section className="eq-gt-section">
          <div className="eq-gt-section__head">
            <div>
              <h3 className="eq-gt-section__title">Recent changes</h3>
              <p className="eq-gt-section__sub">Undo puts every value in a batch back as it was.</p>
            </div>
          </div>
          {batches.map((b) => (
            <div className="eq-gt-history" key={b.id}>
              <span>{plural(b.count, "change")} · {new Date(b.at).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</span>
              {canEdit && (
                <button type="button" className="eq-intake-btn-ghost" onClick={() => void undo(b)} disabled={busy}>Undo</button>
              )}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
