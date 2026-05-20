/**
 * lib/zoho/operation-payloads.ts
 *
 * Pure payload builders for Zoho Integration Service dry-run calls.
 * No DB, no network, no side effects.
 */

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/** Enriched data needed to build a TABLET_RECEIVE dry-run payload. */
export type TabletReceiveInput = {
  /** zoho_assembly_ops.id */
  opId: string;
  /** zoho_assembly_ops.finishedLotId */
  finishedLotId: string;
  /** zoho_assembly_ops.sourceInventoryBagId */
  sourceInventoryBagId: string | null;
  /** zoho_assembly_ops.zohoItemId — the Zoho item ID for the tablet type */
  zohoTabletItemId: string | null;
  /** from PO via sourcePoLineId → purchaseOrders.zohoPoId */
  zohoPoId: string | null;
  /** from sourcePoLineId → poLines.zohoLineItemId */
  zohoLineItemId: string | null;
  /** zoho_assembly_ops.quantity */
  quantity: number;
  /** YYYY-MM-DD — caller passes today's date or lot date */
  date: string;
  /** zoho_assembly_ops.idempotencyKey — internal planning key */
  internalIdempotencyKey: string;
};

/** Enriched data needed to build an assembly dry-run payload. */
export type AssemblyInput = {
  /** zoho_assembly_ops.id */
  opId: string;
  /** zoho_assembly_ops.finishedLotId */
  finishedLotId: string;
  /** "UNIT_ASSEMBLE" | "DISPLAY_ASSEMBLE" | "CASE_ASSEMBLE" */
  opKind: "UNIT_ASSEMBLE" | "DISPLAY_ASSEMBLE" | "CASE_ASSEMBLE";
  /** zoho_assembly_ops.zohoItemId — composite item ID */
  zohoCompositeItemId: string | null;
  /** zoho_assembly_ops.quantity */
  quantity: number;
  /** YYYY-MM-DD */
  date: string;
  /** Optional: ID of the upstream TABLET_RECEIVE op for this lot */
  upstreamReceiveOpId: string | null;
  /** Optional: ID of the upstream assembly op (UNIT→DISPLAY chain) */
  upstreamAssemblyOpId: string | null;
};

// ---------------------------------------------------------------------------
// Validation / result types
// ---------------------------------------------------------------------------

export type PayloadBlocker = {
  field: string;
  message: string;
};

export type PayloadWarning = {
  field: string;
  message: string;
};

export type PayloadBuildResult<T> =
  | { ok: true; payload: T; warnings: PayloadWarning[] }
  | { ok: false; blockers: PayloadBlocker[]; warnings: PayloadWarning[] };

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

export type PurchaseReceivePayload = {
  dry_run: true;
  luma_operation_id: string;
  luma_bag_id: string | null;
  luma_workflow_session_id: string;
  purchaseorder_id: string;
  date: string;
  line_items: Array<{
    line_item_id: string | null;
    item_id: string;
    quantity: number;
    unit: "pcs";
  }>;
};

export type AssemblyPayload = {
  dry_run: true;
  luma_operation_id: string;
  luma_workflow_session_id: string;
  upstream_receive_id: string | null;
  upstream_assembly_id: string | null;
  assembly_level: "unit" | "display" | "case";
  composite_item_id: string;
  quantity: number;
  date: string;
  is_backorder_allowed: false;
};

// ---------------------------------------------------------------------------
// Idempotency key builder
// ---------------------------------------------------------------------------

/**
 * Returns the external Idempotency-Key header value sent to Zoho Integration
 * Service. Distinct from the internal planning idempotency key.
 */
export function buildDryRunIdempotencyKey(
  opId: string,
  opKind:
    | "TABLET_RECEIVE"
    | "UNIT_ASSEMBLE"
    | "DISPLAY_ASSEMBLE"
    | "CASE_ASSEMBLE",
): string {
  if (opKind === "TABLET_RECEIVE") {
    return `luma-purchase-receive-${opId}`;
  }
  return `luma-assembly-${opId}`;
}

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

export function buildTabletReceivePayload(
  input: TabletReceiveInput,
): PayloadBuildResult<PurchaseReceivePayload> {
  const blockers: PayloadBlocker[] = [];
  const warnings: PayloadWarning[] = [];

  if (!input.zohoPoId) {
    blockers.push({
      field: "purchaseorder_id",
      message: "zohoPoId not mapped on purchase order",
    });
  }

  if (!input.zohoTabletItemId) {
    blockers.push({
      field: "line_items[0].item_id",
      message: "Zoho item ID not mapped on tablet type",
    });
  }

  if (!input.zohoLineItemId) {
    warnings.push({
      field: "line_items[0].line_item_id",
      message:
        "Zoho PO line item ID not available; Zoho Integration Service will match by item_id",
    });
  }

  if (input.sourceInventoryBagId === null) {
    warnings.push({
      field: "luma_bag_id",
      message: "Source inventory bag ID not recorded on this op",
    });
  }

  if (blockers.length > 0) {
    return { ok: false, blockers, warnings };
  }

  // At this point both zohoPoId and zohoTabletItemId are non-null (guards above).
  const payload: PurchaseReceivePayload = {
    dry_run: true,
    luma_operation_id: input.opId,
    luma_bag_id: input.sourceInventoryBagId ?? null,
    luma_workflow_session_id: input.finishedLotId,
    purchaseorder_id: input.zohoPoId as string,
    date: input.date,
    line_items: [
      {
        line_item_id: input.zohoLineItemId ?? null,
        item_id: input.zohoTabletItemId as string,
        quantity: input.quantity,
        unit: "pcs",
      },
    ],
  };

  return { ok: true, payload, warnings };
}

export function buildAssemblyPayload(
  input: AssemblyInput,
): PayloadBuildResult<AssemblyPayload> {
  const blockers: PayloadBlocker[] = [];
  const warnings: PayloadWarning[] = [];

  if (!input.zohoCompositeItemId) {
    blockers.push({
      field: "composite_item_id",
      message: "Zoho composite item ID not mapped on product",
    });
  }

  if (blockers.length > 0) {
    return { ok: false, blockers, warnings };
  }

  const levelMap: Record<
    "UNIT_ASSEMBLE" | "DISPLAY_ASSEMBLE" | "CASE_ASSEMBLE",
    "unit" | "display" | "case"
  > = {
    UNIT_ASSEMBLE: "unit",
    DISPLAY_ASSEMBLE: "display",
    CASE_ASSEMBLE: "case",
  };

  const payload: AssemblyPayload = {
    dry_run: true,
    luma_operation_id: input.opId,
    luma_workflow_session_id: input.finishedLotId,
    upstream_receive_id: input.upstreamReceiveOpId,
    upstream_assembly_id: input.upstreamAssemblyOpId,
    assembly_level: levelMap[input.opKind],
    composite_item_id: input.zohoCompositeItemId as string,
    quantity: input.quantity,
    date: input.date,
    is_backorder_allowed: false,
  };

  return { ok: true, payload, warnings };
}
