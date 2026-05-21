// PT-7B — pure shortage recommendation math.
//
// Contracts and rules in docs/PACKTRACK_SHORTAGE_RECOMMENDATIONS_PLAN.md.
// This module is DB-free: every helper takes typed inputs and
// returns a typed recommendation. The projector (PT-7C) hydrates
// inputs from read_material_lot_state + read_material_reconciliation_v2
// + product_packaging_specs + product_material_compatibility + the
// consumption sources, then hands the result to deriveShortageRecommendation.
//
// Honesty defaults:
//   - Never fabricate a usage rate when no history exists.
//   - Never quote a recommended_order_quantity when confidence=MISSING.
//   - Never trigger a shortage on receipt variance or cycle-count variance
//     alone — that belongs to PT-6's MANUAL_REVIEW bucket.
//   - Skip PVC/FOIL/BLISTER_FOIL kinds — those go through read_roll_usage.

import type { PackagingMaterialKind } from "./packaging-bom-kinds";

// ─── Vocabulary ────────────────────────────────────────────────────────

export type ShortageConfidence = "HIGH" | "MEDIUM" | "LOW" | "MISSING";

export type ShortageSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "WATCH";

export type ShortageSignalKind =
  | "CURRENT_ON_HAND"
  | "ACCEPTED_INVENTORY"
  | "DAILY_USAGE_RATE"
  | "PRODUCT_REQUIREMENT"
  | "COMPATIBILITY_REQUIRED"
  | "PACKTRACK_LEAD_TIME"
  | "RECENT_RECEIPT"
  | "REORDER_THRESHOLD"
  | "SCRAP_RECENT"
  | "MISSING_CONFIG";

export type ShortageSignal = {
  kind: ShortageSignalKind;
  label: string;
  /** Confidence of this individual signal — flows into the overall
   *  classifyShortageConfidence calculation. */
  confidence: ShortageConfidence;
  value?: number | null;
  /** Optional extra metadata; not load-bearing for math. */
  meta?: Record<string, unknown>;
};

// ─── Input model ───────────────────────────────────────────────────────

export type InventorySource =
  | "COUNTED"
  | "WEIGH_BACK_DERIVED"
  | "SUPPLIER_DECLARED"
  | "LEGACY_IMPORT"
  | null;

export type UsageRateSource =
  | "READ_MATERIAL_CONSUMPTION_DAILY"
  | "READ_SKU_DAILY_X_BOM"
  | "TARGET_BACKED_OUT"
  | null;

export type LeadTimeSource = "PACKTRACK_LIVE" | "CONFIG_DEFAULT" | null;

export type ShortageRecommendationInput = {
  /** Reproducible-snapshot timestamp. Drives needed_by_date math. */
  generatedAt: Date;

  // Material identity
  materialId: string;
  /** Empty / null means we can't send a recommendation to PackTrack —
   *  treated as MISSING_CONFIG. */
  materialCode: string | null;
  materialName: string;
  materialKind: PackagingMaterialKind;

  // Product context (optional — null for material-wide recs)
  productId?: string | null;
  productName?: string | null;
  productSku?: string | null;
  compatibilityRole?: string | null;
  /** PBOM-2 required flag. True → CRITICAL when on-hand reaches 0. */
  compatibilityRequired?: boolean;

  // Inventory state
  currentOnHand: number | null;
  acceptedInventory: number | null;
  inventorySource: InventorySource;
  /** Lot-state confidence — straight from read_material_lot_state. */
  inventoryConfidence: ShortageConfidence;

  // Usage / demand
  /** Average units consumed per day. null → no usage history. */
  dailyUsageRate: number | null;
  /** How many days of history backed the rate (≥7 for HIGH). */
  usageWindowDays?: number | null;
  usageSource: UsageRateSource;
  /** Optional explicit demand override (from due-target / production
   *  plan). When provided, projectedDemand = max(usage-derived, target). */
  productionTargetDemand?: number | null;

  // Configuration
  /** Lead-time horizon in days. null treated as MISSING_CONFIG. */
  leadTimeDays: number | null;
  leadTimeSource: LeadTimeSource;
  /** Safety buffer percentage applied on top of shortage qty.
   *  null defaults to 20%. */
  safetyBufferPercent?: number | null;
  /** Minimum order quantity. null → no rounding up. */
  minOrderQuantity?: number | null;
  /** Order quantity multiple (e.g. 100 means orders round up to a
   *  multiple of 100). null → no multiple rounding. */
  orderMultiple?: number | null;
  /** Reorder threshold; below this triggers rule #3 (par-level). */
  parLevel?: number | null;

  // Hysteresis: did the projector emit a recommendation for this
  // material on the previous run? When true, the helper applies the
  // 1.2× rule to avoid daily flapping.
  hadActiveRecommendation?: boolean;

  // Optional supporting context (drive signals; no math)
  recentReceipt?: {
    receivedAt: Date;
    quantity: number;
    source: "PACKTRACK" | "MANUAL_LUMA" | "ZOHO" | "IMPORT";
    supplier?: string | null;
  } | null;
  recentScrap?: {
    quantity: number;
    windowDays: number;
  } | null;

  // Product BOM line, when product-scoped
  productRequirement?: {
    perUnit?: number | null;
    perDisplay?: number | null;
    perCase?: number | null;
  } | null;
};

// ─── Output model ──────────────────────────────────────────────────────

export type ShortageRecommendation = {
  recommendationId: string | null;
  materialId: string;
  materialCode: string | null;
  materialName: string;
  productId: string | null;
  productName: string | null;
  productSku: string | null;
  compatibilityRole: string | null;

  currentOnHand: number | null;
  acceptedInventory: number | null;
  projectedDemand: number | null;
  projectedShortageQuantity: number | null;
  recommendedOrderQuantity: number | null;

  neededByDate: Date | null;
  confidence: ShortageConfidence;
  severity: ShortageSeverity;
  reason: string;
  sourceSignals: ShortageSignal[];

  generatedAt: Date;
  expiresAt: Date | null;

  sendableToPackTrack: boolean;
  missingInputs: string[];
  warnings: string[];

  /** Optional supplier hint when the most recent receipt carried one. */
  recommendedSupplierHint: string | null;
};

// ─── Kind gate (rule §5 from the plan) ─────────────────────────────────

const SKIPPED_KINDS: ReadonlySet<PackagingMaterialKind> = new Set([
  "PVC_ROLL",
  "FOIL_ROLL",
  "BLISTER_FOIL",
]);

export function skipMaterialKindForPackTrackShortage(
  kind: PackagingMaterialKind,
): boolean {
  return SKIPPED_KINDS.has(kind);
}

// ─── Constants ─────────────────────────────────────────────────────────

const DEFAULT_SAFETY_BUFFER_PERCENT = 20;
const DEFAULT_EXPIRES_HOURS = 24;
/** Hysteresis multiplier — when an existing recommendation is
 *  active, we keep it until on-hand exceeds 1.2× the trigger
 *  threshold (par_level / projected demand). Prevents daily flapping. */
const HYSTERESIS_MULTIPLIER = 1.2;

// ─── Confidence classifier ─────────────────────────────────────────────

export function classifyShortageConfidence(
  input: ShortageRecommendationInput,
): ShortageConfidence {
  const reasons = countConfidenceGaps(input);
  if (reasons.missing.length > 0) return "MISSING";
  if (reasons.gaps === 0) return "HIGH";
  if (reasons.gaps === 1) return "MEDIUM";
  return "LOW";
}

type ConfidenceTally = {
  /** Each gap counts toward MEDIUM (1) or LOW (2+). */
  gaps: number;
  /** Hard MISSING inputs — any one of these forces overall MISSING. */
  missing: string[];
};

function countConfidenceGaps(
  input: ShortageRecommendationInput,
): ConfidenceTally {
  const out: ConfidenceTally = { gaps: 0, missing: [] };

  // Material code missing is hard-MISSING (we can't send to PackTrack).
  if (!input.materialCode || input.materialCode.trim() === "") {
    out.missing.push("material_code");
  }

  // No inventory source at all → MISSING.
  if (input.inventorySource == null) {
    out.missing.push("inventory_source");
  } else if (input.inventorySource === "LEGACY_IMPORT") {
    out.gaps += 2; // LOW band
  } else if (input.inventorySource === "SUPPLIER_DECLARED") {
    out.gaps += 1;
  }

  // inventoryConfidence is metadata that the projector copies from
  // read_material_lot_state. Honest projectors set it consistent with
  // inventorySource (COUNTED/WEIGH_BACK→HIGH, SUPPLIER_DECLARED→MEDIUM,
  // LEGACY_IMPORT→LOW). Only the MISSING band adds a hard-missing
  // input here — the LOW/MEDIUM bands would otherwise double-count
  // the same gap already booked by inventorySource above.
  if (input.inventoryConfidence === "MISSING") {
    out.missing.push("inventory_confidence");
  }

  // Usage source / window
  if (input.usageSource == null && input.productionTargetDemand == null) {
    out.missing.push("usage_history");
  } else {
    if (input.usageSource === "READ_SKU_DAILY_X_BOM") out.gaps += 1;
    if (input.usageSource === "TARGET_BACKED_OUT") out.gaps += 1;
    const win = input.usageWindowDays ?? 0;
    if (input.usageSource === "READ_MATERIAL_CONSUMPTION_DAILY" && win < 7 && win > 0) {
      out.gaps += 1;
    }
    if (input.usageSource === "READ_MATERIAL_CONSUMPTION_DAILY" && win === 0) {
      out.missing.push("usage_history");
    }
  }

  // Product-scoped recs need a BOM line.
  if (input.productId && !hasAnyBomLine(input.productRequirement)) {
    out.missing.push("bom_configured");
  }

  // Compatibility — when productId present we expect compatibilityRole.
  if (input.productId && !input.compatibilityRole) {
    out.missing.push("compatibility");
  }

  // Lead-time default counts as one gap.
  if (input.leadTimeSource === "CONFIG_DEFAULT") out.gaps += 1;
  if (input.leadTimeSource == null) out.missing.push("lead_time");

  return out;
}

function hasAnyBomLine(
  req: ShortageRecommendationInput["productRequirement"],
): boolean {
  if (!req) return false;
  const u = req.perUnit ?? 0;
  const d = req.perDisplay ?? 0;
  const c = req.perCase ?? 0;
  return u > 0 || d > 0 || c > 0;
}

// ─── Severity classifier ───────────────────────────────────────────────

export function classifyShortageSeverity(
  input: ShortageRecommendationInput,
  ctx: {
    projectedShortageQuantity: number | null;
    runoutDate: Date | null;
  },
): ShortageSeverity {
  const onHand = input.acceptedInventory ?? input.currentOnHand ?? 0;
  const required = input.compatibilityRequired ?? false;

  // Rule §5.1: required material on zero accepted inventory → CRITICAL.
  if (required && onHand === 0) return "CRITICAL";
  if (
    required &&
    input.productionTargetDemand != null &&
    input.productionTargetDemand > 0 &&
    onHand < input.productionTargetDemand
  ) {
    // Required + can't meet target → CRITICAL even with some inventory.
    return "CRITICAL";
  }

  if (ctx.runoutDate) {
    const days = daysBetween(input.generatedAt, ctx.runoutDate);
    if (days <= 0) return "CRITICAL";
    const lead = input.leadTimeDays ?? 0;
    if (days < lead) return "HIGH";
    if (days < lead * 1.5) return "MEDIUM";
  }

  // Production target can't be met from accepted inventory + projected
  // demand window → HIGH.
  if (
    (ctx.projectedShortageQuantity ?? 0) > 0 &&
    input.productionTargetDemand != null
  ) {
    return "HIGH";
  }

  // Below par + projected demand > 0 → at least WATCH; escalate to
  // MEDIUM when also below lead-time window (already handled above).
  if (input.parLevel != null && onHand < input.parLevel) {
    if ((input.dailyUsageRate ?? 0) > 0) return "MEDIUM";
    return "WATCH";
  }

  if ((ctx.projectedShortageQuantity ?? 0) > 0) return "MEDIUM";

  return "WATCH";
}

// ─── Pure math ─────────────────────────────────────────────────────────

export function calculateRunoutDate(
  input: ShortageRecommendationInput,
): Date | null {
  const onHand = input.currentOnHand;
  const rate = input.dailyUsageRate;
  if (onHand == null || rate == null || rate <= 0) return null;
  if (onHand <= 0) return new Date(input.generatedAt);
  const daysRemaining = onHand / rate;
  return addDays(input.generatedAt, daysRemaining);
}

export function calculateProjectedShortage(
  input: ShortageRecommendationInput,
): { projectedDemand: number | null; projectedShortage: number | null } {
  const lead = input.leadTimeDays;
  const rate = input.dailyUsageRate;
  const accepted = input.acceptedInventory;

  // Rate-based demand across the lead-time horizon.
  let demand: number | null = null;
  if (lead != null && rate != null && rate >= 0) {
    demand = rate * lead;
  }
  // If a production target is supplied, max() it in.
  if (input.productionTargetDemand != null) {
    demand = Math.max(demand ?? 0, input.productionTargetDemand);
  }
  if (demand == null) {
    return { projectedDemand: null, projectedShortage: null };
  }
  const have = accepted ?? input.currentOnHand ?? 0;
  const shortage = Math.max(demand - have, 0);
  return { projectedDemand: demand, projectedShortage: shortage };
}

export function calculateRecommendedOrderQuantity(
  shortage: number | null,
  opts: {
    safetyBufferPercent?: number | null;
    minOrderQuantity?: number | null;
    orderMultiple?: number | null;
  } = {},
): number | null {
  if (shortage == null) return null;
  if (shortage <= 0) return 0;
  const bufferPct = (opts.safetyBufferPercent ?? DEFAULT_SAFETY_BUFFER_PERCENT) / 100;
  const raw = shortage * (1 + bufferPct);
  let qty = raw;
  const min = opts.minOrderQuantity ?? null;
  if (min != null && min > 0 && qty < min) qty = min;
  const mult = opts.orderMultiple ?? null;
  if (mult != null && mult > 0) {
    qty = Math.ceil(qty / mult) * mult;
  } else {
    qty = Math.ceil(qty);
  }
  if (qty < 0) return 0;
  return qty;
}

// ─── Signals ───────────────────────────────────────────────────────────

export function deriveShortageSignals(
  input: ShortageRecommendationInput,
): ShortageSignal[] {
  const out: ShortageSignal[] = [];

  if (input.currentOnHand != null) {
    out.push({
      kind: "CURRENT_ON_HAND",
      label: `On-hand`,
      confidence: input.inventoryConfidence,
      value: input.currentOnHand,
    });
  } else {
    out.push({
      kind: "MISSING_CONFIG",
      label: "Current on-hand not available",
      confidence: "MISSING",
      meta: { what: "current_on_hand" },
    });
  }

  if (input.acceptedInventory != null) {
    out.push({
      kind: "ACCEPTED_INVENTORY",
      label: "Accepted at receipt",
      confidence:
        input.inventorySource === "LEGACY_IMPORT"
          ? "LOW"
          : input.inventorySource === "SUPPLIER_DECLARED"
            ? "MEDIUM"
            : input.inventorySource === "COUNTED" || input.inventorySource === "WEIGH_BACK_DERIVED"
              ? "HIGH"
              : "MISSING",
      value: input.acceptedInventory,
    });
  }

  if (input.dailyUsageRate != null && input.dailyUsageRate >= 0) {
    const win = input.usageWindowDays ?? 0;
    let usageConfidence: ShortageConfidence = "MEDIUM";
    if (input.usageSource === "READ_MATERIAL_CONSUMPTION_DAILY" && win >= 7) {
      usageConfidence = "HIGH";
    } else if (input.usageSource === "READ_MATERIAL_CONSUMPTION_DAILY" && win > 0 && win < 7) {
      usageConfidence = "MEDIUM";
    } else if (input.usageSource === "READ_SKU_DAILY_X_BOM") {
      usageConfidence = "MEDIUM";
    } else if (input.usageSource === "TARGET_BACKED_OUT") {
      usageConfidence = "MEDIUM";
    } else if (input.usageSource == null) {
      usageConfidence = "MISSING";
    }
    out.push({
      kind: "DAILY_USAGE_RATE",
      label: "Avg daily consumption",
      confidence: usageConfidence,
      value: input.dailyUsageRate,
      meta: { window_days: win, source: input.usageSource },
    });
  } else if (input.usageSource == null && input.productionTargetDemand == null) {
    out.push({
      kind: "MISSING_CONFIG",
      label: "No usage history available",
      confidence: "MISSING",
      meta: { what: "usage_history" },
    });
  }

  if (input.productId && hasAnyBomLine(input.productRequirement)) {
    out.push({
      kind: "PRODUCT_REQUIREMENT",
      label: "Per unit / display / case (from BOM)",
      confidence: "HIGH",
      meta: {
        product_sku: input.productSku ?? null,
        per_unit: input.productRequirement?.perUnit ?? null,
        per_display: input.productRequirement?.perDisplay ?? null,
        per_case: input.productRequirement?.perCase ?? null,
      },
    });
  } else if (input.productId) {
    out.push({
      kind: "MISSING_CONFIG",
      label: "BOM not configured for product",
      confidence: "MISSING",
      meta: { what: "bom_configured" },
    });
  }

  if (input.productId && input.compatibilityRole && input.compatibilityRequired) {
    out.push({
      kind: "COMPATIBILITY_REQUIRED",
      label: `Required ${input.compatibilityRole} for ${input.productSku ?? input.productName ?? "product"}`,
      confidence: "HIGH",
      meta: { role: input.compatibilityRole, product_sku: input.productSku ?? null },
    });
  } else if (input.productId && !input.compatibilityRole) {
    out.push({
      kind: "MISSING_CONFIG",
      label: "Compatibility not configured for product",
      confidence: "MISSING",
      meta: { what: "compatibility" },
    });
  }

  if (input.leadTimeDays != null && input.leadTimeSource) {
    out.push({
      kind: "PACKTRACK_LEAD_TIME",
      label: input.leadTimeSource === "PACKTRACK_LIVE" ? "Lead time (live from PackTrack)" : "Lead time (config default)",
      confidence: input.leadTimeSource === "PACKTRACK_LIVE" ? "HIGH" : "MEDIUM",
      value: input.leadTimeDays,
    });
  } else {
    out.push({
      kind: "MISSING_CONFIG",
      label: "Lead time not configured",
      confidence: "MISSING",
      meta: { what: "lead_time" },
    });
  }

  if (input.recentReceipt) {
    out.push({
      kind: "RECENT_RECEIPT",
      label: `Most recent receipt — ${input.recentReceipt.source}`,
      confidence: input.recentReceipt.source === "PACKTRACK" ? "HIGH" : "MEDIUM",
      value: input.recentReceipt.quantity,
      meta: {
        received_at: input.recentReceipt.receivedAt.toISOString(),
        source: input.recentReceipt.source,
        supplier: input.recentReceipt.supplier ?? null,
      },
    });
  }

  if (input.parLevel != null && input.parLevel > 0) {
    out.push({
      kind: "REORDER_THRESHOLD",
      label: "Reorder threshold (par level)",
      confidence: "HIGH",
      value: input.parLevel,
    });
  }

  if (input.recentScrap && input.recentScrap.quantity > 0) {
    out.push({
      kind: "SCRAP_RECENT",
      label: `Recent scrap (last ${input.recentScrap.windowDays}d)`,
      confidence: "HIGH",
      value: input.recentScrap.quantity,
      meta: { window_days: input.recentScrap.windowDays },
    });
  }

  // Material code as a MISSING_CONFIG signal — separate from inventory
  // so the operator sees it as a distinct gap.
  if (!input.materialCode || input.materialCode.trim() === "") {
    out.push({
      kind: "MISSING_CONFIG",
      label: "Material has no SKU / code",
      confidence: "MISSING",
      meta: { what: "material_code" },
    });
  }

  return out;
}

// ─── Hysteresis ────────────────────────────────────────────────────────

export function shouldKeepExistingRecommendation(
  input: ShortageRecommendationInput,
  ctx: {
    projectedShortageQuantity: number | null;
    triggerThreshold: number | null;
  },
): boolean {
  if (!input.hadActiveRecommendation) return false;
  // Still in shortage → keep.
  if ((ctx.projectedShortageQuantity ?? 0) > 0) return true;
  // Just out of shortage — apply the 1.2× rule so we don't flap on
  // the boundary. Hold the rec until on-hand clears 1.2× threshold.
  const onHand = input.acceptedInventory ?? input.currentOnHand ?? 0;
  const trig = ctx.triggerThreshold ?? input.parLevel ?? null;
  if (trig == null || trig <= 0) return false;
  return onHand < trig * HYSTERESIS_MULTIPLIER;
}

// ─── Main entry points ────────────────────────────────────────────────

export function deriveShortageRecommendation(
  input: ShortageRecommendationInput,
): ShortageRecommendation | null {
  if (skipMaterialKindForPackTrackShortage(input.materialKind)) return null;

  const confidence = classifyShortageConfidence(input);
  const signals = deriveShortageSignals(input);
  const { projectedDemand, projectedShortage } =
    calculateProjectedShortage(input);
  const runoutDate = calculateRunoutDate(input);
  const severity = classifyShortageSeverity(input, {
    projectedShortageQuantity: projectedShortage,
    runoutDate,
  });

  const recommendedQty =
    confidence === "MISSING"
      ? null
      : calculateRecommendedOrderQuantity(projectedShortage, {
          safetyBufferPercent: input.safetyBufferPercent ?? null,
          minOrderQuantity: input.minOrderQuantity ?? null,
          orderMultiple: input.orderMultiple ?? null,
        });

  const sendable = confidence !== "MISSING"
    && !!input.materialCode
    && input.materialCode.trim() !== ""
    && recommendedQty != null
    && recommendedQty > 0;

  const missingInputs = signals
    .filter((s) => s.kind === "MISSING_CONFIG")
    .map((s) => (s.meta?.["what"] as string | undefined) ?? "unknown");

  const warnings: string[] = [];
  if (
    severity === "CRITICAL" &&
    (input.acceptedInventory ?? input.currentOnHand ?? 0) === 0 &&
    input.compatibilityRequired
  ) {
    warnings.push(
      `Required ${input.compatibilityRole ?? "material"} on zero inventory — production blocked.`,
    );
  }
  if (confidence === "MISSING") {
    warnings.push(
      "Manual review required — recommendation cannot be sized until missing inputs are filled.",
    );
  }
  if (severity === "WATCH" && (projectedShortage ?? 0) <= 0) {
    warnings.push(
      "No shortage projected at current usage rate — recommendation surfaced for visibility only.",
    );
  }

  // Skip non-actionable when there's neither a shortage nor a missing-
  // config gap nor a hysteresis hold.
  const keepingExisting = shouldKeepExistingRecommendation(input, {
    projectedShortageQuantity: projectedShortage,
    triggerThreshold: input.parLevel ?? null,
  });
  if (
    !keepingExisting &&
    confidence !== "MISSING" &&
    (projectedShortage ?? 0) <= 0 &&
    severity === "WATCH" &&
    (input.parLevel == null ||
      (input.currentOnHand ?? 0) >= input.parLevel) &&
    !input.compatibilityRequired
  ) {
    return null;
  }

  const reason = buildReason({
    input,
    confidence,
    severity,
    projectedShortage,
    runoutDate,
  });

  const expiresAt = addDays(input.generatedAt, DEFAULT_EXPIRES_HOURS / 24);

  return {
    recommendationId: null,
    materialId: input.materialId,
    materialCode: input.materialCode ?? null,
    materialName: input.materialName,
    productId: input.productId ?? null,
    productName: input.productName ?? null,
    productSku: input.productSku ?? null,
    compatibilityRole: input.compatibilityRole ?? null,

    currentOnHand: input.currentOnHand,
    acceptedInventory: input.acceptedInventory,
    projectedDemand,
    projectedShortageQuantity: projectedShortage,
    recommendedOrderQuantity: recommendedQty,

    neededByDate:
      runoutDate && input.leadTimeDays != null
        ? addDays(runoutDate, -input.leadTimeDays)
        : runoutDate,
    confidence,
    severity,
    reason,
    sourceSignals: signals,

    generatedAt: input.generatedAt,
    expiresAt,

    sendableToPackTrack: sendable,
    missingInputs,
    warnings,
    recommendedSupplierHint: input.recentReceipt?.supplier ?? null,
  };
}

export function deriveShortageRecommendations(
  inputs: ReadonlyArray<ShortageRecommendationInput>,
): ShortageRecommendation[] {
  const out: ShortageRecommendation[] = [];
  for (const i of inputs) {
    const r = deriveShortageRecommendation(i);
    if (r) out.push(r);
  }
  return out;
}

export function isRecommendationSendableToPackTrack(
  rec: ShortageRecommendation,
): boolean {
  return rec.sendableToPackTrack;
}

// ─── Internal: reason text + date math ────────────────────────────────

function buildReason(args: {
  input: ShortageRecommendationInput;
  confidence: ShortageConfidence;
  severity: ShortageSeverity;
  projectedShortage: number | null;
  runoutDate: Date | null;
}): string {
  const { input, confidence, severity, projectedShortage, runoutDate } = args;
  const name = input.materialName;
  const onHand = input.acceptedInventory ?? input.currentOnHand ?? 0;

  if (confidence === "MISSING") {
    return `Cannot size a recommendation for ${name} — manual review required.`;
  }
  if (
    severity === "CRITICAL" &&
    onHand === 0 &&
    input.compatibilityRequired
  ) {
    return `Required ${input.compatibilityRole ?? "material"} ${name} has zero accepted inventory — production blocked.`;
  }
  if (runoutDate) {
    const ymd = runoutDate.toISOString().slice(0, 10);
    const rate = input.dailyUsageRate;
    if (rate != null && rate > 0) {
      return `${name} runs out ${ymd} at the current rate of ${formatNumber(rate)} / day.`;
    }
  }
  if ((projectedShortage ?? 0) > 0) {
    return `Projected shortage of ${formatNumber(projectedShortage!)} units for ${name} within the lead-time window.`;
  }
  if (input.parLevel != null && onHand < input.parLevel) {
    return `${name} on-hand (${formatNumber(onHand)}) is below the reorder threshold (${formatNumber(input.parLevel)}).`;
  }
  return `${name} surfaced for review — see supporting signals.`;
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return n.toLocaleString("en-US");
  return n.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

function addDays(d: Date, days: number): Date {
  const ms = d.getTime() + Math.round(days * 86400000);
  return new Date(ms);
}

function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 86400000;
}
