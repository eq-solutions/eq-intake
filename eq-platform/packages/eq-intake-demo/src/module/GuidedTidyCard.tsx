/**
 * The invitation on the Overview: "I can tidy up N of your sites". It looks quietly
 * in the background and shows nothing at all when there is nothing to offer, or the
 * person cannot change records, or the read fails.
 */

import { useEffect, useState, type JSX } from "react";
import { fetchCanonicalRows, planSiteTidy, type CanonicalFetchClient, type GuidedPlan, type GuidedSiteRow } from "@eq/intake";
import type { SupabaseLikeClient } from "../canonical/commit-canonical.js";

export interface GuidedTidyCardProps {
  supabase?: SupabaseLikeClient | null;
  canEdit?: boolean;
  onOpen: () => void;
  /** Bumped by the host after data changes, so the offer recounts. */
  refreshSignal?: number;
}

const plural = (n: number, one: string, many: string = `${one}s`): string => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** "19 changes I'm sure about, 12 to check, 1 question for you" - only the parts that are not zero. */
export function describeCounts(c: { sure: number; check: number; questions: number }): string {
  const parts: string[] = [];
  if (c.sure > 0) parts.push(`${c.sure.toLocaleString()} ${c.sure === 1 ? "change" : "changes"} I'm sure about`);
  if (c.check > 0) parts.push(`${c.check.toLocaleString()} to check`);
  if (c.questions > 0) parts.push(`${c.questions.toLocaleString()} ${c.questions === 1 ? "question" : "questions"} for you`);
  return parts.join(", ");
}

export function GuidedTidyCard({ supabase, canEdit = false, onOpen, refreshSignal }: GuidedTidyCardProps): JSX.Element | null {
  const [plan, setPlan] = useState<GuidedPlan | null>(null);

  useEffect(() => {
    if (!supabase || !canEdit) return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await fetchCanonicalRows(supabase as unknown as CanonicalFetchClient, "sites");
        if (!cancelled) setPlan(planSiteTidy(rows as unknown as GuidedSiteRow[]));
      } catch {
        if (!cancelled) setPlan(null);
      }
    })();
    return () => { cancelled = true; };
  }, [supabase, canEdit, refreshSignal]);

  if (!canEdit || !plan || (plan.proposals.length === 0 && plan.questions.length === 0)) return null;

  const { sure, check, questions, sites } = plan.counts;
  return (
    <div className="eq-gt-card">
      <div className="eq-gt-card__main">
        <p className="eq-gt-card__title">I can tidy up {plural(sites, "site")} for you</p>
        <p className="eq-gt-card__detail">{describeCounts({ sure, check, questions })}. Nothing changes until you approve it.</p>
      </div>
      <button type="button" className="eq-intake-btn-primary" onClick={onOpen}>Review</button>
    </div>
  );
}
