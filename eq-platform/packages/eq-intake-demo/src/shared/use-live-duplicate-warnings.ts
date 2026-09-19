/**
 * useLiveDuplicateWarnings — the "does this row already exist in EQ" check,
 * as a precommit warning source alongside collectPreCommitWarnings's four
 * in-file-only kinds.
 *
 * Split into a fetch effect (re-runs on supabase/slots/manualMappings
 * change) and a pure filter (re-runs on resolutions change) so clicking
 * Skip/Keep on one candidate never re-triggers a network read — same
 * fetch-once-filter-often shape as useFieldImportanceOverrides.
 */
import { useEffect, useMemo, useState } from "react";
import type { LiveRowLookup } from "@eq/intake";
import type { FileSlot } from "./intake-bundle.js";
import type { RoleName } from "../rollup/roles.js";
import type { SupabaseLikeClient } from "../canonical/commit-canonical.js";
import { previewDuplicatesAgainstLive } from "../canonical/commit-canonical.js";
import type { PreCommitWarning } from "./precommit-warnings.js";

/** Resolution key for one candidate — matches CommitView's duplicateResolutions state. */
export function liveDuplicateKey(role: RoleName, rowIndex: number): string {
  return `${role}:${rowIndex}`;
}

/** Row indices within one role's sheet resolved "skip" — CommitView excludes these from the actual commit. */
export function skippedRowIndices(
  role: RoleName,
  resolutions: Record<string, "skip" | "keep">,
): Set<number> {
  const prefix = `${role}:`;
  const out = new Set<number>();
  for (const [key, action] of Object.entries(resolutions)) {
    if (action === "skip" && key.startsWith(prefix)) {
      out.add(Number(key.slice(prefix.length)));
    }
  }
  return out;
}

export function useLiveDuplicateWarnings(
  supabase: SupabaseLikeClient | null | undefined,
  slots: FileSlot[],
  manualMappings: Partial<Record<RoleName, Record<string, string | null>>>,
  resolutions: Record<string, "skip" | "keep">,
): PreCommitWarning[] {
  const [rawWarnings, setRawWarnings] = useState<PreCommitWarning[]>([]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;

  useEffect(() => {
    let cancelled = false;

    // Deferred a tick so setRawWarnings below never runs synchronously inside
    // this effect's body — same reasoning as useFieldImportanceOverrides.
    queueMicrotask(() => {
      if (!supabase) { setRawWarnings([]); return; }

      const lookup: LiveRowLookup = async (entity) => {
        const { data, error } = await sb.rpc("eq_tidy_read_entity", { p_table: entity });
        if (error) throw new Error(error.message);
        return (data as Record<string, unknown>[] | null) ?? [];
      };

      const reviewable = slots.filter((s) => s.role !== "unknown" && s.sheet);

      Promise.all(
        reviewable.map((slot) =>
          previewDuplicatesAgainstLive(
            slot.sheet!,
            slot.role as RoleName,
            lookup,
            manualMappings[slot.role as RoleName],
          ).then((candidates) =>
            candidates.map((c): PreCommitWarning => ({
              kind: "duplicate_existing",
              slotLabel: slot.file.name,
              role: slot.role as RoleName,
              rowIndex: c.rowIndex,
              newValue: c.newValue,
              existingId: c.existingId,
              existingLabel: c.existingLabel,
              similarity: c.similarity,
            })),
          ),
        ),
      )
        .then((perSlot) => { if (!cancelled) setRawWarnings(perSlot.flat()); })
        .catch(() => { if (!cancelled) setRawWarnings([]); }); // non-critical — enrichment, never blocks review
    });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, slots, manualMappings]);

  // Drop anything already resolved (Skip or Keep) — a real fix removes the
  // warning, same principle unmapped_required's column-pick already follows.
  return useMemo(
    () =>
      rawWarnings.filter((w) => {
        if (w.kind !== "duplicate_existing") return true;
        return !resolutions[liveDuplicateKey(w.role, w.rowIndex)];
      }),
    [rawWarnings, resolutions],
  );
}
