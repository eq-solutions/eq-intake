import { useState, useEffect, useCallback, useRef, type JSX } from "react";
import {
  readSiteAdvisory,
  adjudicateSiteAdvisory,
  adjudicateDuplicateWithAI,
  makeEdgeFnCaller,
  previewSiteMerge,
  executeSiteMerge,
} from "@eq/intake";
import type {
  SiteAdvisorySummary,
  SiteAdvisoryItem,
  SiteVerdict,
  AiSiteVerdict,
  SiteMergePreview,
} from "@eq/intake";
import type { SupabaseLikeClient } from "../canonical/commit-canonical.js";

// ---------------------------------------------------------------------------
// The write-time resolver's adjudication console — extracted out of
// IntakeHealthHome so it lives in To Do (a decision) instead of Overview (a
// diagnostic). Self-contained: owns its own readSiteAdvisory load/refresh,
// independent of RemediationQueue's eq_queue_list load and of Overview's
// other health checks.
// ---------------------------------------------------------------------------

export interface DuplicateMergePanelProps {
  supabase?: SupabaseLikeClient | null;
  /** See IntakeModuleProps.canMergeSites — host-computed, manager-only by default. */
  canMergeSites?: boolean;
  /** Called after a merge actually moves canonical data — see RemediationQueueProps.onDataChanged. */
  onDataChanged?: () => void;
}

const VERDICT_LABEL: Record<SiteVerdict, string> = {
  same: "Same site",
  different: "Different",
  unsure: "Unsure",
};

function MergePanel({
  item, canMerge, preview, previewBusy, mergeBusy, mergeErr, merged,
  onPreview, onCancelPreview, onConfirm,
}: {
  item: SiteAdvisoryItem;
  canMerge: boolean;
  preview?: SiteMergePreview;
  previewBusy: boolean;
  mergeBusy: boolean;
  mergeErr?: string;
  merged?: { survivor_site_id: string; movedTotal: number; alreadyMerged?: boolean };
  onPreview: () => void;
  onCancelPreview: () => void;
  onConfirm: () => void;
}): JSX.Element | null {
  // Merge only makes sense once a human/AI has said "same" — matches the
  // server-side gate (eq_site_merge_execute requires a recorded 'same' verdict).
  if (item.verdict !== "same") return null;

  if (merged) {
    return (
      <span className="eq-merge-panel__done">
        {merged.alreadyMerged
          ? "✓ Already merged elsewhere — nothing left to move"
          : `✓ Merged — ${merged.movedTotal} row${merged.movedTotal === 1 ? "" : "s"} moved`}
      </span>
    );
  }

  // Preview (eq_site_merge_preview) carries no role gate server-side — only
  // eq_site_merge_execute does (manager-only, eq-shell 0185/0228). So anyone
  // can see exactly what would move; only a manager can pull the trigger.
  if (preview) {
    return (
      <span className="eq-merge-panel__preview">
        <span className="eq-merge-panel__preview-text">
          {preview.total_rows} row{preview.total_rows === 1 ? "" : "s"} across{" "}
          {preview.tables.filter((t) => t.count > 0).length} table{preview.tables.filter((t) => t.count > 0).length === 1 ? "" : "s"}{" "}
          will move into {preview.survivor_name ?? "the survivor site"}. The other row is retired, not deleted.
        </span>
        {canMerge ? (
          <button
            type="button"
            disabled={mergeBusy}
            onClick={onConfirm}
            className="eq-merge-panel__confirm-btn"
          >
            {mergeBusy ? "Merging…" : "Confirm merge"}
          </button>
        ) : (
          <span className="eq-merge-panel__hint">Ask a manager to confirm this merge</span>
        )}
        <button
          type="button"
          disabled={mergeBusy}
          onClick={onCancelPreview}
          className="eq-merge-panel__cancel-btn"
        >
          {canMerge ? "Cancel" : "Close"}
        </button>
        {mergeErr && <span className="eq-merge-panel__err" role="alert">{mergeErr}</span>}
      </span>
    );
  }

  return (
    <span className="eq-merge-panel__actions">
      <button
        type="button"
        disabled={previewBusy}
        onClick={onPreview}
        title="See exactly what will move before merging"
        className="eq-merge-panel__preview-btn"
      >
        {previewBusy ? "Checking…" : "Preview merge"}
      </button>
      {mergeErr && <span className="eq-merge-panel__err">{mergeErr}</span>}
    </span>
  );
}

function SiteAdvisoryPanel({
  summary, onAdjudicate, saving, errors, onAskAi, aiSuggest, aiBusy, aiErr,
  canMergeSites, mergePreviews, mergePreviewBusy, mergeBusy, mergeErrors, merged,
  onPreviewMerge, onCancelPreviewMerge, onConfirmMerge,
}: {
  summary: SiteAdvisorySummary;
  onAdjudicate: (advisoryId: string, verdict: SiteVerdict, note?: string) => void;
  saving: Record<string, boolean>;
  errors: Record<string, boolean>;
  onAskAi: (item: SiteAdvisoryItem) => void;
  aiSuggest: Record<string, AiSiteVerdict>;
  aiBusy: Record<string, boolean>;
  aiErr: Record<string, boolean>;
  canMergeSites?: boolean;
  mergePreviews: Record<string, SiteMergePreview>;
  mergePreviewBusy: Record<string, boolean>;
  mergeBusy: Record<string, boolean>;
  mergeErrors: Record<string, string>;
  merged: Record<string, { survivor_site_id: string; movedTotal: number; alreadyMerged?: boolean }>;
  onPreviewMerge: (item: SiteAdvisoryItem) => void;
  onCancelPreviewMerge: (advisoryId: string) => void;
  onConfirmMerge: (item: SiteAdvisoryItem) => void;
}): JSX.Element {
  // Hooks must run unconditionally — this state exists whether or not there's
  // anything to show, so the "Watching — nothing flagged yet" early return
  // below stays a valid early return rather than a Rules-of-Hooks violation.
  const [expanded, setExpanded] = useState(false);
  // "Unsure" gets an inline note step instead of firing immediately — the
  // advisory_adjudicate RPC has always accepted a note, the UI just never
  // offered one. Only one row's note field is open at a time.
  const [notingId, setNotingId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  // A decided row that's re-opened via "Change answer" — re-shows the verdict
  // buttons for that one row instead of the locked-in "you said" text. The
  // adjudicate RPC records the latest verdict, so re-firing it just overwrites.
  const [editingId, setEditingId] = useState<string | null>(null);
  // Resolved rows (a final verdict with nothing left to do) collapse out of
  // the main queue by default so the list actually shrinks as you work
  // through it — expand to review or change one.
  const [resolvedOpen, setResolvedOpen] = useState(false);
  const [resolvedExpanded, setResolvedExpanded] = useState(false);

  if (summary.total === 0) {
    return (
      <div className="eq-health-licence-strip">
        <span className="eq-health-badge eq-health-badge--ok">Watching — nothing flagged yet</span>
      </div>
    );
  }

  // A "same" verdict still needs a merge — keep it in the working queue.
  // "different"/"unsure" (or a "same" that's already merged) have nothing
  // left to do, so they're resolved and free to leave the main list.
  const isResolved = (it: SiteAdvisoryItem) =>
    it.verdict != null && (it.verdict !== "same" || !!merged[it.id]);

  const actionableItems = summary.items.filter((it) => !isResolved(it));
  const resolvedItems = summary.items.filter(isResolved);

  const VISIBLE_CAP = 8;
  const visibleActionable = expanded ? actionableItems : actionableItems.slice(0, VISIBLE_CAP);
  const hiddenCount = actionableItems.length - VISIBLE_CAP;

  const renderRow = (it: SiteAdvisoryItem) => {
    const canChangeAnswer = it.verdict != null && !merged[it.id];
    const showButtons = it.verdict == null || editingId === it.id;
    return (
      <li key={it.id} className="eq-advisory-item">
        <div className="eq-advisory-item__row">
          <span className="eq-advisory-item__name">{it.candidate_name ?? it.candidate_code ?? "New site"}</span>
          <span aria-hidden="true" className="eq-advisory-item__arrow">→</span>
          <span className="eq-advisory-item__matched">
            {it.matched_name ?? "existing site"}{it.matched_active === false ? " (retired)" : ""}
          </span>
          <span className={`eq-health-badge eq-health-badge--${it.outcome === "match" ? "warning" : "info"}`}>
            {it.outcome === "match" ? "likely same" : "unsure"}
          </span>
          {it.verdict && editingId !== it.id && (
            <span className="eq-advisory-item__verdict-note">
              · you said: {VERDICT_LABEL[it.verdict]}
              {it.verdict_note ? <> — &ldquo;{it.verdict_note}&rdquo;</> : null}
              {canChangeAnswer && (
                <button
                  type="button"
                  className="eq-advisory-item__change-btn"
                  onClick={() => setEditingId(it.id)}
                >
                  Change answer
                </button>
              )}
            </span>
          )}
        </div>
        <div className="eq-advisory-item__controls">
          {!showButtons && (
            <MergePanel
              item={it}
              canMerge={!!canMergeSites}
              preview={mergePreviews[it.id]}
              previewBusy={!!mergePreviewBusy[it.id]}
              mergeBusy={!!mergeBusy[it.id]}
              mergeErr={mergeErrors[it.id]}
              merged={merged[it.id]}
              onPreview={() => onPreviewMerge(it)}
              onCancelPreview={() => onCancelPreviewMerge(it.id)}
              onConfirm={() => onConfirmMerge(it)}
            />
          )}
          {showButtons && (
            <>
              <span className="eq-advisory-item__verdict-btns">
                {(["same", "different", "unsure"] as SiteVerdict[]).map((v) => {
                  const suggested = aiSuggest[it.id]?.verdict === v;
                  const current = it.verdict === v;
                  return (
                    <button
                      key={v}
                      type="button"
                      disabled={!!saving[it.id]}
                      onClick={() => {
                        // Unsure opens an inline note instead of firing
                        // immediately — same/different need no follow-up.
                        if (v === "unsure") { setNotingId(it.id); setNoteDraft(it.verdict_note ?? ""); }
                        else {
                          onAdjudicate(it.id, v);
                          // "Same" still needs a merge — fetch the preview
                          // now instead of waiting for a second click, so
                          // recording the verdict visibly moves the row
                          // forward instead of looking like a no-op.
                          if (v === "same") onPreviewMerge(it);
                          setEditingId(null);
                        }
                      }}
                      title={
                        current ? "This is your current answer"
                        : suggested ? `Claude suggests: ${VERDICT_LABEL[v]}`
                        : `Record: ${VERDICT_LABEL[v]}`
                      }
                      className={`eq-advisory-item__verdict-btn${suggested ? " eq-advisory-item__verdict-btn--suggested" : ""}${current ? " eq-advisory-item__verdict-btn--current" : ""}`}
                    >
                      {VERDICT_LABEL[v]}
                    </button>
                  );
                })}
                {editingId === it.id && (
                  <button
                    type="button"
                    className="eq-intake-btn-ghost eq-queue__btn"
                    onClick={() => { setEditingId(null); setNotingId(null); setNoteDraft(""); }}
                  >
                    Cancel
                  </button>
                )}
              </span>
              {notingId === it.id && (
                <span className="eq-advisory-item__note-row">
                  <input
                    type="text"
                    className="eq-queue__input"
                    placeholder="What's unclear? (optional — helps whoever looks next)"
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    disabled={!!saving[it.id]}
                    aria-label={`Note for ${it.candidate_name ?? "this row"}`}
                  />
                  <button
                    type="button"
                    className="eq-intake-btn-primary eq-queue__btn"
                    disabled={!!saving[it.id]}
                    onClick={() => {
                      onAdjudicate(it.id, "unsure", noteDraft.trim() || undefined);
                      setNotingId(null);
                      setNoteDraft("");
                      setEditingId(null);
                    }}
                  >
                    {saving[it.id] ? "Saving…" : "Record: Unsure"}
                  </button>
                  <button
                    type="button"
                    className="eq-intake-btn-ghost eq-queue__btn"
                    disabled={!!saving[it.id]}
                    onClick={() => { setNotingId(null); setNoteDraft(""); }}
                  >
                    Cancel
                  </button>
                </span>
              )}
              {it.verdict == null && (
                aiSuggest[it.id] ? (
                  <span className="eq-advisory-item__ai-reason">
                    <span className="eq-advisory-item__ai-label">✨ Claude:</span>{" "}
                    {aiSuggest[it.id].reasoning}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onAskAi(it)}
                    disabled={!!aiBusy[it.id]}
                    title="Ask Claude for a suggested answer with a reason"
                    className="eq-advisory-item__ai-btn"
                  >
                    {aiBusy[it.id] ? "Asking Claude…" : "✨ Ask Claude"}
                  </button>
                )
              )}
              {aiErr[it.id] && <span className="eq-advisory-item__err">AI unavailable</span>}
            </>
          )}
          {errors[it.id] && <span className="eq-advisory-item__err">couldn&rsquo;t save — try again</span>}
        </div>
      </li>
    );
  };

  return (
    <div>
      <div className="eq-health-licence-strip">
        <span className="eq-health-badge eq-health-badge--critical">
          {summary.total} caught at the write
        </span>
        {summary.recent_count > 0 && (
          <span className="eq-health-badge eq-health-badge--warning">
            {summary.recent_count} in the last {summary.recent_days} days
          </span>
        )}
        {summary.pending > 0 && (
          <span className="eq-health-badge eq-health-badge--info">
            {summary.pending} need a human
          </span>
        )}
        {summary.decided > 0 && (
          <span className="eq-health-badge eq-health-badge--ok">
            {summary.decided} adjudicated
          </span>
        )}
      </div>
      {actionableItems.length > 0 ? (
        <>
          <ul className="eq-advisory-list">
            {visibleActionable.map(renderRow)}
          </ul>
          {hiddenCount > 0 && (
            <button
              type="button"
              className="eq-intake-btn-ghost"
              style={{ marginTop: 8 }}
              onClick={() => setExpanded((e) => !e)}
            >
              {expanded ? "Show fewer" : `Show all ${actionableItems.length}`}
            </button>
          )}
        </>
      ) : (
        <p className="eq-queue__section-hint">Nothing needs your input right now.</p>
      )}
      {resolvedItems.length > 0 && (
        <div className="eq-advisory-resolved">
          <button
            type="button"
            className="eq-intake-btn-ghost"
            onClick={() => setResolvedOpen((o) => !o)}
          >
            {resolvedOpen ? "Hide" : "Show"} {resolvedItems.length} resolved
          </button>
          {resolvedOpen && (
            <>
              <ul className="eq-advisory-list" style={{ marginTop: 8 }}>
                {(resolvedExpanded ? resolvedItems : resolvedItems.slice(0, VISIBLE_CAP)).map(renderRow)}
              </ul>
              {resolvedItems.length > VISIBLE_CAP && (
                <button
                  type="button"
                  className="eq-intake-btn-ghost"
                  style={{ marginTop: 8 }}
                  onClick={() => setResolvedExpanded((e) => !e)}
                >
                  {resolvedExpanded ? "Show fewer" : `Show all ${resolvedItems.length}`}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function DuplicateMergePanel({ supabase, canMergeSites, onDataChanged }: DuplicateMergePanelProps): JSX.Element | null {
  const [advisory,   setAdvisory]   = useState<SiteAdvisorySummary | null>(null);
  const [adjSaving,  setAdjSaving]  = useState<Record<string, boolean>>({});
  const [adjErrors,  setAdjErrors]  = useState<Record<string, boolean>>({});
  const [aiSuggest,  setAiSuggest]  = useState<Record<string, AiSiteVerdict>>({});
  const [aiBusy,     setAiBusy]     = useState<Record<string, boolean>>({});
  const [aiErr,      setAiErr]      = useState<Record<string, boolean>>({});
  const [mergePreviews,     setMergePreviews]     = useState<Record<string, SiteMergePreview>>({});
  const [mergePreviewBusy,  setMergePreviewBusy]  = useState<Record<string, boolean>>({});
  const [mergeBusy,         setMergeBusy]         = useState<Record<string, boolean>>({});
  const [mergeErrors,       setMergeErrors]       = useState<Record<string, string>>({});
  const [merged,            setMerged]            = useState<Record<string, { survivor_site_id: string; movedTotal: number; alreadyMerged?: boolean }>>({});
  const [loading,    setLoading]    = useState(false);

  const reload = useCallback(async () => {
    if (!supabase) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as any;
    setLoading(true);
    try {
      const result = await readSiteAdvisory(sb);
      setAdvisory(result);
    } catch (err) {
      // Non-fatal — a tenant not yet on migration 0180 has no summary RPC.
      // eslint-disable-next-line no-console
      console.warn(
        "[DuplicateMergePanel] Site advisory read failed:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Live updates — same pattern as ContactDuplicateMergePanel (an eq-shell
  // migration adds site_resolution_advisory/site_resolution_merge_log to the
  // Realtime publication, mirroring what 0323 did for the contact tables). A
  // new flag, or a merge landing from any tab/session (auto or human),
  // reloads the panel on its own. Debounced so a burst of writes triggers
  // one reload, not one per row. If a tenant's Realtime isn't wired up yet
  // this is a no-op — mount + focus refresh + the manual button below still
  // cover it.
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!supabase) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as any;
    // Defensive: a mock/partial client (the standalone demo playground) or
    // an older supabase-js build may not expose .channel at all.
    if (typeof sb.channel !== "function") return;

    const debouncedReload = () => {
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(() => { void reload(); }, 400);
    };

    let channel: { unsubscribe?: () => void } | undefined;
    try {
      channel = sb
        .channel("site-duplicate-merge-panel")
        .on("postgres_changes", { event: "INSERT", schema: "app_data", table: "site_resolution_advisory" }, debouncedReload)
        .on("postgres_changes", { event: "INSERT", schema: "app_data", table: "site_resolution_merge_log" }, debouncedReload)
        .subscribe();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[DuplicateMergePanel] realtime subscribe failed, falling back to mount/focus/manual refresh:", err instanceof Error ? err.message : err);
      return;
    }

    return () => {
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
      try { sb.removeChannel?.(channel); } catch { /* best-effort cleanup */ }
    };
  }, [supabase, reload]);

  // Safety net for a missed/dropped realtime event — refresh when the tab
  // regains focus, same pattern most live dashboards use.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") void reload(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [reload]);

  // Record a human verdict on a flagged row, then reflect it optimistically:
  // the item shows the verdict and the pending/decided counts shift. If the
  // write fails (e.g. a tenant not yet on migration 0183, so the RPC is
  // missing) we flag it inline and leave the buttons — nothing else breaks.
  const handleAdjudicate = useCallback(
    async (advisoryId: string, verdict: SiteVerdict, note?: string) => {
      if (!supabase) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any;
      setAdjSaving((s) => ({ ...s, [advisoryId]: true }));
      setAdjErrors((e) => {
        if (!e[advisoryId]) return e;
        const next = { ...e };
        delete next[advisoryId];
        return next;
      });
      try {
        await adjudicateSiteAdvisory(sb, { advisoryId, verdict, note });
        setAdvisory((prev) => {
          if (!prev) return prev;
          let wasPending = false;
          const items = prev.items.map((it) => {
            if (it.id !== advisoryId) return it;
            wasPending = it.verdict == null;
            // Don't carry the old note forward onto a changed verdict — an
            // "unsure" note re-attached to a subsequent "same"/"different"
            // reads as if it justified the new answer. Mirrors what the RPC
            // itself does server-side (p_note ?? null clears it).
            return { ...it, verdict, verdict_note: note ?? null, decided_at: new Date().toISOString() };
          });
          return {
            ...prev,
            items,
            decided: wasPending ? prev.decided + 1 : prev.decided,
            pending: wasPending ? Math.max(0, prev.pending - 1) : prev.pending,
          };
        });
        // A changed verdict invalidates any merge preview/error fetched
        // under the previous one — clear so "Change answer" back to "same"
        // starts clean instead of showing a stale "N rows will move".
        setMergePreviews((p) => {
          if (!(advisoryId in p)) return p;
          const next = { ...p }; delete next[advisoryId]; return next;
        });
        setMergeErrors((e) => {
          if (!e[advisoryId]) return e;
          const next = { ...e }; delete next[advisoryId]; return next;
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          "[DuplicateMergePanel] adjudicate failed:",
          err instanceof Error ? err.message : err,
        );
        setAdjErrors((e) => ({ ...e, [advisoryId]: true }));
      } finally {
        setAdjSaving((s) => {
          const next = { ...s };
          delete next[advisoryId];
          return next;
        });
      }
    },
    [supabase],
  );

  // Ask Claude for a suggested verdict + a plain-English reason on a flagged row.
  // Advisory only — it fills aiSuggest so the console can show the reason and
  // pre-highlight a button; the human still taps to record. Fails soft (aiErr).
  const handleAskAi = useCallback(
    async (item: SiteAdvisoryItem) => {
      if (!supabase) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const callEdgeFn = makeEdgeFnCaller(supabase as any);
      setAiErr((e) => {
        if (!e[item.id]) return e;
        const next = { ...e }; delete next[item.id]; return next;
      });
      setAiBusy((b) => ({ ...b, [item.id]: true }));
      try {
        const verdict = await adjudicateDuplicateWithAI(
          { name: item.candidate_name, code: item.candidate_code },
          { name: item.matched_name, active: item.matched_active },
          callEdgeFn,
        );
        setAiSuggest((s) => ({ ...s, [item.id]: verdict }));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[DuplicateMergePanel] AI adjudication failed:", err instanceof Error ? err.message : err);
        setAiErr((e) => ({ ...e, [item.id]: true }));
      } finally {
        setAiBusy((b) => {
          const next = { ...b }; delete next[item.id]; return next;
        });
      }
    },
    [supabase],
  );

  // Preview: fetch exactly what would move before the human confirms. Pure
  // read (eq_site_merge_preview) — nothing changes until Confirm is tapped.
  const handlePreviewMerge = useCallback(
    async (item: SiteAdvisoryItem) => {
      if (!supabase) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any;
      setMergeErrors((e) => {
        if (!e[item.id]) return e;
        const next = { ...e }; delete next[item.id]; return next;
      });
      setMergePreviewBusy((b) => ({ ...b, [item.id]: true }));
      try {
        const preview = await previewSiteMerge(sb, item.id);
        if (preview.already_merged) {
          // Someone else (or an earlier click) already executed this merge —
          // the server still answers the preview, just with nothing left to
          // move. Land straight on the "done" state instead of showing a
          // Confirm button that would only 500 on a re-execute.
          setMerged((m) => ({ ...m, [item.id]: { survivor_site_id: preview.survivor_site_id, movedTotal: 0, alreadyMerged: true } }));
        } else {
          setMergePreviews((p) => ({ ...p, [item.id]: preview }));
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[DuplicateMergePanel] merge preview failed:", err instanceof Error ? err.message : err);
        setMergeErrors((e) => ({ ...e, [item.id]: err instanceof Error ? err.message : "couldn't preview" }));
      } finally {
        setMergePreviewBusy((b) => {
          const next = { ...b }; delete next[item.id]; return next;
        });
      }
    },
    [supabase],
  );

  const handleCancelPreviewMerge = useCallback((advisoryId: string) => {
    setMergePreviews((p) => {
      if (!(advisoryId in p)) return p;
      const next = { ...p }; delete next[advisoryId]; return next;
    });
  }, []);

  // Execute: the write. Requires a preview to already be on screen (the human
  // saw what would move) — mirrors the server-side precondition that a 'same'
  // verdict must already be recorded.
  const handleConfirmMerge = useCallback(
    async (item: SiteAdvisoryItem) => {
      if (!supabase) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any;
      setMergeErrors((e) => {
        if (!e[item.id]) return e;
        const next = { ...e }; delete next[item.id]; return next;
      });
      setMergeBusy((b) => ({ ...b, [item.id]: true }));
      try {
        const result = await executeSiteMerge(sb, { advisoryId: item.id });
        const movedTotal = Object.values(result.moved).reduce((sum, n) => sum + n, 0);
        setMerged((m) => ({ ...m, [item.id]: { survivor_site_id: result.survivor_site_id, movedTotal } }));
        onDataChanged?.();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[DuplicateMergePanel] merge execute failed:", err instanceof Error ? err.message : err);
        setMergeErrors((e) => ({ ...e, [item.id]: err instanceof Error ? err.message : "merge failed" }));
      } finally {
        setMergeBusy((b) => {
          const next = { ...b }; delete next[item.id]; return next;
        });
      }
    },
    [supabase, onDataChanged],
  );

  if (!supabase || advisory === null) return null;

  return (
    <div className="eq-queue__section">
      <div className="eq-queue__section-header">
        <h3>Possible duplicate sites</h3>
        <span className="eq-queue__section-count">{advisory.total}</span>
        <span className="eq-queue__watching" title="Updates live as data is written — the Refresh button below covers tenants without live updates yet">
          <span className="eq-queue__watching-dot" aria-hidden="true" />
          {loading ? "updating…" : "watching"}
        </span>
      </div>
      <p className="eq-queue__section-hint">
        Caught automatically as data was written. Say same or different, then merge if you have access —
        the other record is retired, not deleted.
      </p>
      <SiteAdvisoryPanel
        summary={advisory}
        onAdjudicate={handleAdjudicate}
        saving={adjSaving}
        errors={adjErrors}
        onAskAi={handleAskAi}
        aiSuggest={aiSuggest}
        aiBusy={aiBusy}
        aiErr={aiErr}
        canMergeSites={canMergeSites}
        mergePreviews={mergePreviews}
        mergePreviewBusy={mergePreviewBusy}
        mergeBusy={mergeBusy}
        mergeErrors={mergeErrors}
        merged={merged}
        onPreviewMerge={handlePreviewMerge}
        onCancelPreviewMerge={handleCancelPreviewMerge}
        onConfirmMerge={handleConfirmMerge}
      />
      <button
        type="button"
        className="eq-intake-btn-ghost"
        style={{ marginTop: 8 }}
        onClick={() => void reload()}
        disabled={loading}
      >
        {loading ? "Refreshing…" : "↻ Refresh"}
      </button>
    </div>
  );
}
