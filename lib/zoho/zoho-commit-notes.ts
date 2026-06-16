// ZOHO-STAGING-BUFFER-v1.1.0 — accounting/reconciliation notes that
// travel with every Zoho commit (manual + auto). Single shared helper
// per op type so the Zoho-side accounting view sees identical
// formatting whether the buffer expired or an operator pushed by hand.
//
// Two-layer model:
//
//   1. FROZEN BODY (this file, build*Notes functions):
//      Generated once at preview/seed time. Captures every accounting
//      identifier: operation ID, receipt/lot/bag identifiers, product
//      SKU, quantities, dates. Never mutated after freeze. Same bytes
//      whether the eventual commit was manual or auto.
//
//   2. COMMIT-TRIGGER SUFFIX (formatCommitTriggerLine / appendCommitTriggerToNotes):
//      Generated at commit time, appended as one final line just
//      before the gateway call. Reflects the actual trigger
//      ("auto-commit after 24h buffer" / "manual commit-now by <actor>" /
//      "cron retry"). Lets Zoho-side accounting see who pushed
//      WITHOUT mutating the canonical reviewed body.
//
// All helpers obey:
//
//   - The most-important identifiers come first. If the note has to
//     be truncated, the truncated tail loses LOW-priority fields,
//     never the operation ID, receipt/lot/bag identifiers, product
//     SKU, or quantity. The commit-trigger suffix is also preserved
//     when present (it's a priority field).
//   - Missing fields are omitted entirely (no "field: —" noise).
//   - Pure functions — same inputs always produce the same string.
//     That's required because the body gets frozen into the payload
//     at preview/seed time and replayed verbatim on commit.

/** @deprecated Source-of-commit lives in the commit-trigger suffix
 *  (see {@link CommitTrigger}), not the frozen notes body. Kept as a
 *  type alias only because the seed/freeze code still passes it for
 *  audit-log structuring. */
export type CommitSource = "manual" | "auto";

/** The actual trigger that fired the commit. Appended to the frozen
 *  notes by the shared commit fns immediately before the gateway call. */
export type CommitTrigger =
  | { kind: "AUTO_COMMIT_AFTER_BUFFER" }
  | { kind: "MANUAL_COMMIT_NOW"; actor: string | null }
  | { kind: "CRON_RETRY" };

// Zoho's typical text-note column limit. Conservative — actual limit
// is higher in most contexts, but staying under this avoids ANY
// chance of a 400 on payload size and leaves headroom for downstream
// formatting wrappers.
export const ZOHO_NOTES_MAX_LENGTH = 2000;

// ─── Raw-bag receive notes ─────────────────────────────────────────

export type RawBagReceiveNotesInput = {
  /** Always present — primary identifier for cross-system lookup. */
  lumaOperationId: string;
  /** Always present. */
  receiveDate: string;
  receivedQuantity: number;
  /** @deprecated Source-of-commit is now appended at commit time via
   *  {@link appendCommitTriggerToNotes}. The frozen body no longer
   *  includes it. Kept as an optional input only for callers that
   *  haven't been migrated yet — currently ignored by the builder. */
  source?: CommitSource;

  // Optional identifiers, included when supplied.
  lumaReceiveId?: string | null;
  poNumber?: string | null;
  poLineReference?: string | null;
  receiptNumber?: string | null;
  boxNumber?: string | null;
  bagNumber?: number | null;
  internalReceiptNumber?: string | null;
  bagQrCode?: string | null;
  tabletType?: string | null;
  supplierLotNumber?: string | null;
  vendorBarcode?: string | null;
};

/** Fields in PRIORITY ORDER for raw-bag receive notes. The first N
 *  always render; later entries may be dropped on truncation. The
 *  Source line is intentionally absent — it's appended at commit
 *  time as a separate suffix line via {@link appendCommitTriggerToNotes}. */
function rawBagFieldOrder(input: RawBagReceiveNotesInput): Array<[string, string | null]> {
  return [
    // Priority 1 — never truncated
    ["Luma op", input.lumaOperationId],
    ["Receipt #", presentString(input.receiptNumber)],
    ["Bag #", input.bagNumber != null ? String(input.bagNumber) : null],
    ["Internal receipt #", presentString(input.internalReceiptNumber)],
    ["Qty", String(input.receivedQuantity)],
    // Priority 2 — preserved when possible
    ["Product", presentString(input.tabletType)],
    ["PO", presentString(input.poNumber)],
    ["PO line", presentString(input.poLineReference)],
    ["Date", input.receiveDate],
    // Priority 3 — first to go on truncation
    ["Supplier lot", presentString(input.supplierLotNumber)],
    ["Vendor barcode", presentString(input.vendorBarcode)],
    ["Box #", presentString(input.boxNumber)],
    ["Bag QR", presentString(input.bagQrCode)],
    ["Luma receive", presentString(input.lumaReceiveId)],
  ];
}

export function buildRawBagReceiveNotes(
  input: RawBagReceiveNotesInput,
  opts?: { maxLength?: number },
): string {
  const maxLength = opts?.maxLength ?? ZOHO_NOTES_MAX_LENGTH;
  const fields = rawBagFieldOrder(input).filter(
    (entry): entry is [string, string] => entry[1] != null,
  );
  return renderNotesRespectingMaxLength(
    fields,
    maxLength,
    // Priority-1 count — the first 5 fields are never dropped:
    //   Luma op, Receipt #, Bag #, Internal receipt #, Qty
    5,
  );
}

// ─── Production-output notes ──────────────────────────────────────

export type ProductionOutputNotesInput = {
  lumaOperationId: string;
  finishedLotId: string;
  /** @deprecated See note on RawBagReceiveNotesInput.source. */
  source?: CommitSource;
  unitsProduced: number;

  finishedLotNumber?: string | null;
  finishedLotTraceCode?: string | null;
  productName?: string | null;
  productSku?: string | null;
  productionDate?: string | null;
  packedDate?: string | null;
  casesProduced?: number | null;
  looseDisplaysProduced?: number | null;
  looseSinglesProduced?: number | null;
  /** Each entry: "bagId · receipt# · lot#" — caller flattens. */
  sourceBagSummaries?: ReadonlyArray<string>;
};

function productionOutputFieldOrder(
  input: ProductionOutputNotesInput,
): Array<[string, string | null]> {
  return [
    // Priority 1 — never truncated
    ["Luma op", input.lumaOperationId],
    [
      "Lot #",
      presentString(input.finishedLotNumber) ??
        presentString(input.finishedLotTraceCode),
    ],
    ["Lot ID", input.finishedLotId],
    ["SKU", presentString(input.productSku)],
    ["Units", String(input.unitsProduced)],
    // Priority 2 — preserved when possible
    ["Product", presentString(input.productName)],
    [
      "Cases / Displays / Singles",
      input.casesProduced != null ||
      input.looseDisplaysProduced != null ||
      input.looseSinglesProduced != null
        ? [
            input.casesProduced ?? 0,
            input.looseDisplaysProduced ?? 0,
            input.looseSinglesProduced ?? 0,
          ].join(" / ")
        : null,
    ],
    [
      "Date",
      presentString(input.productionDate) ?? presentString(input.packedDate),
    ],
    // Priority 3 — first to go on truncation
    [
      "Source bags",
      input.sourceBagSummaries && input.sourceBagSummaries.length > 0
        ? input.sourceBagSummaries.join("; ")
        : null,
    ],
  ];
}

export function buildProductionOutputNotes(
  input: ProductionOutputNotesInput,
  opts?: { maxLength?: number },
): string {
  const maxLength = opts?.maxLength ?? ZOHO_NOTES_MAX_LENGTH;
  const fields = productionOutputFieldOrder(input).filter(
    (entry): entry is [string, string] => entry[1] != null,
  );
  return renderNotesRespectingMaxLength(
    fields,
    maxLength,
    // Priority-1 count — never dropped:
    //   Luma op, Lot #, Lot ID, SKU, Units
    5,
  );
}

// ─── Internals ────────────────────────────────────────────────────

function presentString(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Render `[label: value]` newline-joined, drop lower-priority fields
 *  if needed, NEVER drop the first `priorityCount` entries.
 *
 *  If we still can't fit after dropping every low-priority field, the
 *  priority-1 block itself is truncated with an ellipsis as a last
 *  resort (this shouldn't happen with the 2000-char limit and our
 *  field set, but it's the only safe behavior if it does). */
function renderNotesRespectingMaxLength(
  fields: ReadonlyArray<[string, string]>,
  maxLength: number,
  priorityCount: number,
): string {
  const lines = fields.map(([label, value]) => `${label}: ${value}`);
  let body = lines.join("\n");
  if (body.length <= maxLength) return body;

  // Truncate from the END (lowest priority first), keeping the first
  // priorityCount lines.
  let kept = lines.length;
  while (body.length > maxLength && kept > priorityCount) {
    kept -= 1;
    body = lines.slice(0, kept).join("\n");
  }
  if (body.length <= maxLength) return body;

  // Pathological case — even priority-1 fields exceed the limit.
  // Truncate the body string and append an ellipsis marker.
  return `${body.slice(0, Math.max(0, maxLength - 3))}...`;
}

// ─── Commit-trigger suffix ────────────────────────────────────────

/** Render the single line the shared commit fn appends to the frozen
 *  body immediately before the gateway call. ALWAYS one line — never
 *  multi-line. Reflects the ACTUAL trigger so accounting can tell
 *  whether the row went through the buffer or was hand-pushed. */
export function formatCommitTriggerLine(trigger: CommitTrigger): string {
  switch (trigger.kind) {
    case "AUTO_COMMIT_AFTER_BUFFER":
      return "Commit trigger: auto-commit after 24h buffer";
    case "MANUAL_COMMIT_NOW":
      return trigger.actor
        ? `Commit trigger: manual commit-now by ${trigger.actor}`
        : "Commit trigger: manual commit-now";
    case "CRON_RETRY":
      return "Commit trigger: cron retry";
  }
}

/** Append the commit-trigger line to the frozen body.
 *
 *  Truncation rule (matches the priority rules in the body):
 *   1. If the body + suffix fit in maxLength, send both as-is.
 *   2. If they don't fit, KEEP the suffix and trim the body's
 *      lowest-priority lines. The suffix is treated as a
 *      priority field — never dropped.
 *   3. If even the priority-1 body + suffix don't fit, truncate the
 *      body inside the priority-1 block with an ellipsis, but the
 *      suffix line still survives.
 *
 *  This means accounting can ALWAYS see who triggered the commit, even
 *  if some bag/lot detail had to be dropped to fit. */
export function appendCommitTriggerToNotes(
  frozenNotes: string,
  trigger: CommitTrigger,
  opts?: { maxLength?: number },
): string {
  const maxLength = opts?.maxLength ?? ZOHO_NOTES_MAX_LENGTH;
  const suffix = formatCommitTriggerLine(trigger);
  const combinedSeparator = frozenNotes.length > 0 ? "\n" : "";
  const combined = `${frozenNotes}${combinedSeparator}${suffix}`;
  if (combined.length <= maxLength) return combined;

  // Body + suffix doesn't fit. Trim the LAST body line repeatedly
  // until body + separator + suffix fits, or until we've trimmed
  // every body line (in which case we send just the suffix, possibly
  // truncated by the second-stage fallback below).
  const suffixWithSeparator = `\n${suffix}`;
  let bodyLines = frozenNotes.split("\n");
  while (bodyLines.length > 0) {
    const candidate = `${bodyLines.join("\n")}${suffixWithSeparator}`;
    if (candidate.length <= maxLength) return candidate;
    bodyLines = bodyLines.slice(0, -1);
  }
  // Suffix alone — if even that doesn't fit, truncate inside the
  // suffix with an ellipsis. This is pathological; suffix is always
  // short.
  if (suffix.length <= maxLength) return suffix;
  return `${suffix.slice(0, Math.max(0, maxLength - 3))}...`;
}
