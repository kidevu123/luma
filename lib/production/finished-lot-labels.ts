// LOT-1E — finished-lot label payload helpers + recall-passport CSV.
//
// Pure functions only. No DB calls. Built on top of the snapshot
// objects emitted by the LOT-1C projector (`print_payload`) and the
// LOT-1D passport loader.
//
// Print-policy invariants (per LOT-1A §4 / LOT-1B §7 #3):
//   - finished_lots.trace_code is the customer-facing printed code.
//   - internal_receipt_number stays internal — never on the customer
//     template.
//   - supplier_lot_number is hidden by default; only the explicit
//     `customers.supplier_lot_visible = true` flag flips it on.
//   - print payload is a snapshot, not a live recomputation.
//   - Missing data renders as the literal string "missing" — we never
//     leave fields blank pretending the label is complete.

import type {
  RecallPassport,
  OutputRow,
  PackagingLotRow,
  QcEventRow,
  RawBagRow,
} from "./recall-passport-loaders";

// ─── Types ────────────────────────────────────────────────────────────

export type FinishedLotLabelOutputType =
  | "DISPLAY"
  | "MASTER_CASE"
  | "LOOSE_UNIT"
  | "PALLET"
  | "OTHER";

export type LabelTemplate = "INTERNAL" | "CUSTOMER";

/** What goes on every label (both internal + customer-facing). The
 *  fields a CUSTOMER label may NOT include are listed under
 *  `internalFields` so renderers know to omit them. */
export type FinishedLotLabelPayload = {
  template: LabelTemplate;
  /** Single canonical identifier — always populated. */
  traceCode: string;
  /** Optional secondary code (customer's own SKU code, if any). */
  traceAlias: string | null;
  productName: string;
  productSku: string | null;
  outputType: FinishedLotLabelOutputType;
  quantity: number;
  unit: string;
  packedAt: string | null;
  expiresAt: string | null;
  /** Always carries the value the projector snapshotted into
   *  print_payload (LOT-1C). When the projector hasn't run yet, this
   *  is `null` and the renderer surfaces "missing". */
  printPayloadSnapshot: Record<string, unknown> | null;
  /** QR encoding for the carton label. Always the FL- prefix on a
   *  customer carton — never the BAG- raw-bag namespace. */
  qrPayloadText: string;
  /** Fields the renderer should ONLY show on internal templates.
   *  Customer templates must ignore this field. */
  internalFields: {
    internalReceiptAlias: string | null;
    sourceRawBagCount: number;
    supplierLotNumber: string | null;
    confidence: string;
    /** Free-form list of warnings the projector / loader reported. */
    warnings: string[];
    /** Missing-input notes the projector / loader reported. */
    missingLinks: string[];
  };
};

// ─── Pure helpers ─────────────────────────────────────────────────────

/** Defaults to false — supplier lot is hidden unless the customer
 *  explicitly opted in. */
export function shouldExposeSupplierLotForCustomer(args: {
  customerSupplierLotVisible?: boolean | null;
}): boolean {
  return args.customerSupplierLotVisible === true;
}

/** Format a trace code for human-readable print. Prefers the
 *  customer-supplied alias when set; falls back to the canonical
 *  trace_code. Renders "MISSING TRACE CODE" when neither is set —
 *  rather than silently printing a blank label. */
export function formatTraceCodeForPrint(
  traceCode: string | null | undefined,
  alias?: string | null,
): string {
  if (alias && alias.trim().length > 0) return alias.trim();
  if (traceCode && traceCode.trim().length > 0) return traceCode.trim();
  return "MISSING TRACE CODE";
}

const MISSING = "missing";

/** Build a single label payload for one (finished lot × output type)
 *  pair. Template determines what's exposed. */
export function buildFinishedLotLabelPayload(args: {
  template: LabelTemplate;
  traceCode: string | null;
  traceAlias: string | null;
  productName: string | null;
  productSku: string | null;
  output: {
    outputType: string;
    quantity: number;
    unit: string;
    printPayload: Record<string, unknown> | null;
  };
  packedAt: Date | string | null;
  expiresAt: Date | string | null;
  internalReceiptAlias: string | null;
  sourceRawBagCount: number;
  supplierLotNumber: string | null;
  customerSupplierLotVisible?: boolean | null;
  confidence: string;
  warnings: string[];
  missingLinks: string[];
}): FinishedLotLabelPayload {
  const isCustomer = args.template === "CUSTOMER";
  const exposeSupplier = shouldExposeSupplierLotForCustomer({
    customerSupplierLotVisible: args.customerSupplierLotVisible ?? null,
  });

  // Customer template suppresses supplier_lot unless explicitly opted
  // in. Internal template always carries it.
  const internalSupplierLot = args.supplierLotNumber;
  const customerSupplierLot = exposeSupplier ? args.supplierLotNumber : null;

  const traceCode = formatTraceCodeForPrint(args.traceCode, args.traceAlias);
  return {
    template: args.template,
    traceCode,
    traceAlias: args.traceAlias,
    productName: args.productName ?? MISSING,
    productSku: args.productSku,
    outputType: normalizeOutputType(args.output.outputType),
    quantity: args.output.quantity,
    unit: args.output.unit,
    packedAt: toIso(args.packedAt),
    expiresAt: toIso(args.expiresAt),
    printPayloadSnapshot: args.output.printPayload ?? null,
    qrPayloadText: traceCode,
    internalFields: {
      // The internal-only block is populated regardless of template;
      // renderers using the CUSTOMER template must ignore it. Tests
      // assert this for the supplier_lot field.
      internalReceiptAlias: args.internalReceiptAlias,
      sourceRawBagCount: args.sourceRawBagCount,
      // supplierLotNumber: customer template carries `customerSupplierLot`
      // (null when not visible); internal template carries the raw value.
      supplierLotNumber: isCustomer
        ? customerSupplierLot
        : internalSupplierLot,
      confidence: args.confidence,
      warnings: args.warnings,
      missingLinks: args.missingLinks,
    },
  };
}

/** Convenience wrapper for the common "render customer-facing label"
 *  path. Equivalent to buildFinishedLotLabelPayload with
 *  template='CUSTOMER'. */
export function buildCustomerSafeLabelPayload(
  args: Omit<Parameters<typeof buildFinishedLotLabelPayload>[0], "template">,
): FinishedLotLabelPayload {
  return buildFinishedLotLabelPayload({ ...args, template: "CUSTOMER" });
}

function normalizeOutputType(raw: string): FinishedLotLabelOutputType {
  switch (raw) {
    case "DISPLAY":
    case "MASTER_CASE":
    case "LOOSE_UNIT":
    case "PALLET":
    case "OTHER":
      return raw;
    default:
      return "OTHER";
  }
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// ─── CSV export ───────────────────────────────────────────────────────

const CSV_HEADERS = [
  "search_kind",
  "search_value",
  "section",
  "row_index",
  "product",
  "product_sku",
  "supplier_lot",
  "internal_receipt_number",
  "raw_bag_qr",
  "finished_lot_trace_code",
  "finished_lot_number",
  "packed_date",
  "output_type",
  "output_quantity",
  "output_unit",
  "packaging_material",
  "packaging_lot_qty",
  "qc_event_type",
  "qc_occurred_at",
  "customer_code",
  "customer_name",
  "shipment_carrier",
  "shipment_tracking",
  "shipment_qty",
  "shipped_at",
  "confidence",
  "warnings",
  "missing_links",
] as const;

type CsvRow = Record<(typeof CSV_HEADERS)[number], string>;

function csvEscape(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function emptyRow(): CsvRow {
  const r = {} as CsvRow;
  for (const h of CSV_HEADERS) r[h] = "";
  return r;
}

/** Serialise a recall passport as CSV. One row per item across all
 *  sections (raw bag / finished lot / output / packaging / QC /
 *  shipment), tagged by `section`. The first row of the CSV is the
 *  header; subsequent rows carry section-specific data, with shared
 *  context columns (search_kind / search_value / confidence) repeated
 *  on every row so the file is self-describing.
 *
 *  Customer-safe: when `customerSupplierLotVisible !== true`, the
 *  supplier_lot column is blank for every row regardless of which
 *  bag carried which lot. */
export function buildRecallPassportCsv(
  passport: RecallPassport,
  opts: { customerSupplierLotVisible?: boolean | null } = {},
): string {
  const lines: string[] = [];
  lines.push(CSV_HEADERS.map(csvEscape).join(","));

  const exposeSupplier = shouldExposeSupplierLotForCustomer({
    customerSupplierLotVisible: opts.customerSupplierLotVisible ?? null,
  });

  const searchKind = passport.searchInput.kind;
  const searchValue = describeSearchValue(passport.searchInput);
  const confidence = passport.confidence;
  const warnings = passport.warnings.join(" | ");
  const missingLinks = passport.missingLinks.join(" | ");

  const lot = passport.finishedLots[0];

  function pushRow(partial: Partial<CsvRow>): void {
    const row = emptyRow();
    row.search_kind = searchKind;
    row.search_value = searchValue;
    row.confidence = confidence;
    row.warnings = warnings;
    row.missing_links = missingLinks;
    if (lot) {
      row.product = lot.productName ?? "";
      row.product_sku = lot.productSku ?? "";
      row.finished_lot_trace_code = lot.traceCode ?? "";
      row.finished_lot_number = lot.finishedLotNumber;
      row.packed_date = lot.packedAt
        ? lot.packedAt.toISOString().slice(0, 10)
        : "";
    }
    for (const k of Object.keys(partial) as Array<keyof CsvRow>) {
      const v = partial[k];
      if (v !== undefined) row[k] = v;
    }
    lines.push(CSV_HEADERS.map((h) => csvEscape(row[h])).join(","));
  }

  // Summary row (always emitted, even when sections are empty).
  pushRow({ section: "summary", row_index: "0" });

  passport.rawBags.forEach((b: RawBagRow, i: number) => {
    pushRow({
      section: "raw_bag",
      row_index: String(i + 1),
      supplier_lot: exposeSupplier ? (b.supplierLotNumber ?? "") : "",
      internal_receipt_number: b.internalReceiptNumber ?? "",
      raw_bag_qr: b.bagQrCode ?? "",
    });
  });

  passport.outputs.forEach((o: OutputRow, i: number) => {
    pushRow({
      section: "output",
      row_index: String(i + 1),
      output_type: o.outputType,
      output_quantity: String(o.quantity),
      output_unit: o.unit,
    });
  });

  passport.packagingLots.forEach((p: PackagingLotRow, i: number) => {
    pushRow({
      section: "packaging_lot",
      row_index: String(i + 1),
      packaging_material: p.materialName ?? "",
      packaging_lot_qty: p.quantityUsed != null ? String(p.quantityUsed) : "",
    });
  });

  passport.qcEvents.forEach((q: QcEventRow, i: number) => {
    pushRow({
      section: "qc_event",
      row_index: String(i + 1),
      qc_event_type: q.eventType,
      qc_occurred_at: q.occurredAt.toISOString(),
    });
  });

  passport.shipmentLinks.forEach((s, i) => {
    pushRow({
      section: "shipment",
      row_index: String(i + 1),
      customer_code: s.customerCode ?? "",
      customer_name: s.customerName ?? "",
      shipment_carrier: s.carrier ?? "",
      shipment_tracking: s.trackingNumber ?? "",
      shipment_qty: s.quantity != null ? String(s.quantity) : "",
      shipped_at: s.shippedAt ? s.shippedAt.toISOString() : "",
    });
  });

  return lines.join("\n") + "\n";
}

function describeSearchValue(input: RecallPassport["searchInput"]): string {
  switch (input.kind) {
    case "supplier_lot":
    case "internal_receipt_number":
    case "raw_bag_qr":
    case "finished_lot_trace_code":
      return input.value;
    case "product_date_range":
      return `${input.productId} ${input.fromDate}..${input.toDate}`;
    case "customer_date_range":
      return `${input.customerId} ${input.fromDate}..${input.toDate}`;
  }
}

/** Exposed CSV header list — used by tests so the contract is
 *  visible at the type level. */
export function getCsvHeaders(): readonly string[] {
  return CSV_HEADERS;
}
