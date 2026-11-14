/**
 * useIntakeBundle — the shared "drop a file, parse it, work out what it is"
 * state, lifted out of the individual sections so ONE drop zone can feed
 * BOTH the export path and the Into-EQ commit path.
 *
 * This is the piece IntakeModule's old comment flagged as "the next step":
 * QuickExportSection and CanonicalCommitSection each used to wire up
 * parseFile() + classifySheet() independently, forcing the bookkeeper to
 * drop files twice. Now they drop once; this hook holds the classified
 * slots and every destination reads from the same set.
 */

import { useState, useCallback } from "react";
import { parseFile, classifySheet, type ParsedSheet } from "@eq/intake";
import {
  CUSTOMER_SCHEMA,
  CONTACT_SCHEMA,
  SITE_SCHEMA,
  STAFF_SCHEMA,
} from "../simpro-schemas.js";
import type { RoleName } from "../rollup/roles.js";
import { isLikelyIgnoredSheet, splitFullNameColumn } from "./sheet-hints.js";

/** The four roles a SimPRO-shaped sheet gets classified into. */
export const ROLE_REGISTRY: Record<RoleName, Record<string, unknown>> = {
  customer: CUSTOMER_SCHEMA,
  contact: CONTACT_SCHEMA,
  site: SITE_SCHEMA,
  staff: STAFF_SCHEMA,
};

/** One dropped sheet, after parse + classification. */
export interface FileSlot {
  file: File;
  role: RoleName | "unknown";
  sheet?: ParsedSheet;
  confidence?: number;
  error?: string;
  /** Per-role heuristic scores from classifySheet — powers the "could be A or B" / "what is it?" detection tiers. */
  scores?: Record<string, number>;
  /** How classifySheet reached `role` — "heuristic" is decisive, the others need a human glance. */
  method?: "heuristic" | "ai" | "ambiguous_fallback";
  /**
   * Set when the tab name says "not this one" (old, ignore, archive...). The
   * slot stays visible but its role is "unknown", so it can never win a role
   * slot in slotForRole / availableRoles until the person picks "Use it anyway".
   */
  skipReason?: string;
  /** What classifySheet said for a skipped tab, kept so "Use it anyway" needs no re-read. */
  held?: { role: RoleName | "unknown"; confidence: number; scores: Record<string, number>; method: "heuristic" | "ai" | "ambiguous_fallback" };
}

/** Plain-English plural for a role, for UI copy. */
export function roleLabel(role: RoleName | "unknown"): string {
  switch (role) {
    case "customer":
      return "customers";
    case "site":
      return "sites";
    case "contact":
      return "contacts";
    case "staff":
      return "staff";
    default:
      return "unknown";
  }
}

function toRole(entity: string): RoleName | "unknown" {
  return entity === "customer" ||
    entity === "contact" ||
    entity === "site" ||
    entity === "staff"
    ? (entity as RoleName)
    : "unknown";
}

export interface IntakeBundle {
  slots: FileSlot[];
  busy: boolean;
  /** Parse + classify dropped files and append them as slots. */
  ingestFiles: (files: File[]) => Promise<void>;
  removeSlot: (idx: number) => void;
  reset: () => void;
  /** Distinct non-unknown roles present across the current slots. */
  availableRoles: Set<RoleName>;
  /** The first readable slot for a given role, or undefined. */
  slotForRole: (role: RoleName) => FileSlot | undefined;
  /** Override a slot's classified role — the "Change" / close-call / unsure picks. */
  setSlotRole: (idx: number, role: RoleName) => void;
  /** Bring a skipped tab back in, using what classification already said about it. */
  unskipSlot: (idx: number) => void;
}

export function useIntakeBundle(): IntakeBundle {
  const [slots, setSlots] = useState<FileSlot[]>([]);
  const [busy, setBusy] = useState(false);

  const ingestFiles = useCallback(async (files: File[]) => {
    setBusy(true);
    try {
      const next: FileSlot[] = [];
      for (const file of files) {
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const parsed = await parseFile({ bytes, fileName: file.name });
          if (!parsed.sheets.length) {
            next.push({ file, role: "unknown", error: "Couldn't read this file" });
            continue;
          }
          // One slot per sheet, so multi-tab workbooks classify each tab.
          for (const sheet of parsed.sheets) {
            // A lone "Full Name" column is split into First/Last BEFORE
            // classifying, so the name columns count toward the staff or
            // contacts score. The split copy is only kept when the sheet
            // really is staff or contacts.
            const probe = splitFullNameColumn(sheet, "staff");
            const classification = await classifySheet({
              schemas: ROLE_REGISTRY,
              sheet: probe,
            });
            const role = toRole(classification.entity);
            const keptSheet = role === "staff" || role === "contact" ? probe : sheet;
            const slot: FileSlot = {
              file,
              role,
              sheet: keptSheet,
              confidence: classification.confidence,
              scores: classification.scores,
              method: classification.method,
            };
            if (isLikelyIgnoredSheet(sheet.sheetName)) {
              slot.held = {
                role,
                confidence: classification.confidence,
                scores: classification.scores,
                method: classification.method,
              };
              slot.role = "unknown";
              slot.skipReason = `Skipped: the tab is called "${sheet.sheetName}", which sounds like old or unused data.`;
            }
            next.push(slot);
          }
        } catch (e) {
          next.push({
            file,
            role: "unknown",
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      setSlots((prev) => [...prev, ...next]);
    } finally {
      setBusy(false);
    }
  }, []);

  const removeSlot = useCallback((idx: number) => {
    setSlots((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const setSlotRole = useCallback((idx: number, role: RoleName) => {
    setSlots((prev) =>
      prev.map((s, i) =>
        i === idx
          ? {
              ...s,
              role,
              method: "heuristic" as const,
              sheet: s.sheet ? splitFullNameColumn(s.sheet, role) : s.sheet,
            }
          : s,
      ),
    );
  }, []);

  const unskipSlot = useCallback((idx: number) => {
    setSlots((prev) =>
      prev.map((s, i) => {
        if (i !== idx || !s.held) return s;
        const { held, skipReason: _skipReason, ...rest } = s;
        return {
          ...rest,
          role: held.role,
          confidence: held.confidence,
          scores: held.scores,
          method: held.method,
        };
      }),
    );
  }, []);

  const reset = useCallback(() => setSlots([]), []);

  const availableRoles = new Set<RoleName>(
    slots
      .filter((s) => s.role !== "unknown" && s.sheet)
      .map((s) => s.role as RoleName),
  );

  const slotForRole = useCallback(
    (role: RoleName): FileSlot | undefined =>
      slots.find((s) => s.role === role && s.sheet),
    [slots],
  );

  return { slots, busy, ingestFiles, removeSlot, reset, availableRoles, slotForRole, setSlotRole, unskipSlot };
}
