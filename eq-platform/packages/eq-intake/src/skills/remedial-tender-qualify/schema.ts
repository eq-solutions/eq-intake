/**
 * Extraction-time JSON Schema for the AI vision prompt.
 *
 * NOT a canonical entity schema — it exists only to shape the vision prompt
 * across a whole tender bundle (contract + spec + photos) in one round-trip.
 * Canonical mapping lives in to-canonical.ts; schemas/tender_qualification.schema.json
 * is the actual canonical entity shape.
 *
 * Deliberately asks for less than the full 8-factor matrix. Several
 * sub-fields (client relationship history, proven capability, margin) are
 * business knowledge the estimator carries in their head, not something a
 * tender pack states — asking vision to guess those would violate
 * EQ-AS-CONDUIT rule #11 (never silently default an unanswerable question;
 * here that means never asking the model to fabricate a confident answer it
 * has no basis for). Every field the model isn't confident about must come
 * back null, never a guess — extract.ts then leaves that factor for a human.
 */
export const TENDER_QUALIFICATION_EXTRACT_SCHEMA: Record<string, unknown> = {
  type: "object",
  "x-eq-entity": "tender_qualification_extract",
  description:
    "A remedial-building tender bundle: contract + specification + site/scope photos. " +
    "Extract the header facts and only the go/no-go factors that are actually evidenced " +
    "in the documents. Return null for anything not clearly stated — never guess, and " +
    "never infer a business's own client relationship history, track record, or margin " +
    "from the documents themselves.",
  properties: {
    customer_name_raw: {
      type: ["string", "null"],
      description: "The client/principal's name as it appears on the tender documents.",
    },
    contact_raw: {
      type: ["string", "null"],
      description: "The tender's named contact — name, role, phone, email, whatever is printed. Free text.",
    },
    site_address_raw: {
      type: ["string", "null"],
      description: "The site or project address.",
    },
    scope_summary: {
      type: ["string", "null"],
      description: "A plain-language summary of the scope of works, 2-6 sentences.",
    },
    contract_value_estimate: {
      type: ["number", "null"],
      description: "The tendered/estimated contract value in AUD, if stated.",
    },
    client_principal_type: {
      type: ["string", "null"],
      description:
        "The principal's type as described, e.g. 'owner_builder', 'strata', 'tier1_head_contractor', 'government', 'private_developer'. Null if not clear.",
    },
    scope_investigated_and_defined: {
      type: ["boolean", "null"],
      description: "true if the specification reads as fully investigated/defined, false if it flags major unknowns/provisional items, null if unclear.",
    },
    scope_major_unknowns_count: {
      type: ["integer", "null"],
      description: "Count of explicitly flagged provisional/unknown/TBC scope items, if the documents make this countable. Null otherwise.",
    },
    cash_flow_claims_fund_delivery: {
      type: ["boolean", "null"],
      description: "true if payment terms (progress claims, cycle) read as funding delivery as work proceeds; false if payment is materially back-ended or a large upfront/deposit is required with little progress billing; null if payment terms aren't stated.",
    },
    contract_liability_capped: {
      type: ["boolean", "null"],
      description: "true if the contract states a liability cap; false if liability reads as uncapped; null if the contract wasn't supplied or doesn't address it.",
    },
    contract_disproportionate_liability: {
      type: ["boolean", "null"],
      description: "true if liability/indemnity clauses look disproportionate to the contract value (e.g. uncapped consequential loss, onerous indemnities); false if they read as balanced; null if unclear.",
    },
    program_achievable: {
      type: ["boolean", "null"],
      description: "true only if there is clear evidence the stated program duration suits the stated scope; false if the program reads as obviously compressed for the scope described; null otherwise — do not guess.",
    },
    program_penalty_heavy_or_compressed: {
      type: ["boolean", "null"],
      description: "true if liquidated damages / penalty clauses are unusually heavy or the program is explicitly compressed; false if standard/absent; null if not stated.",
    },
    technical_uncontrolled_design_or_structural_risk: {
      type: ["boolean", "null"],
      description: "true if the scope includes design-and-construct or structural work without a clear, controlled design responsibility split; false if design responsibility reads as clearly allocated and controlled; null if unclear.",
    },
  },
  required: [],
};
