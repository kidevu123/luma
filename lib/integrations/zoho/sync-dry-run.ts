// ZOHO-2A — dry-run diff engine + orchestrator for items + customers.
//
// Pure-logic diff helpers (diffZohoItemsAgainstLuma /
// diffZohoCustomersAgainstLuma) plus an orchestrator
// (runZohoDryRunSync) that:
//   - probes gateway readiness via deriveZohoReadiness
//   - if NEEDS_REAUTH / NEEDS_SELECTION / non-READY → returns a BLOCKED
//     result and persists one zoho_sync_runs row (sync_type=ITEMS,
//     status=PARTIAL, error explains the reason). NEVER calls the
//     item / customer endpoints in that case.
//   - if READY_FOR_DRY_RUN → fetches items + customers, normalizes,
//     diffs against the current Luma master, persists one
//     zoho_sync_runs row PER kind (ITEMS + CUSTOMERS) with
//     dry_run=true.
//
// NEVER writes to products, tablet_types, packaging_materials, or
// customers. NEVER writes to Zoho. The ZOHO-3 apply phase replaces
// these helpers with live-write paths gated by an explicit operator
// click.

import { db } from "@/lib/db";
import { zohoSyncRuns } from "@/lib/db/schema";
import {
  checkZohoGatewayHealth,
  deriveZohoReadiness,
  fetchZohoBrandStatus,
  type ZohoReadiness,
} from "./gateway";
import {
  fetchZohoItemsDryRun,
  deriveZohoItemLumaTarget,
  type LumaItemTarget,
  type NormalizedZohoItem,
} from "./items";
import {
  fetchZohoCustomersDryRun,
  deriveZohoCustomerLumaTarget,
  type NormalizedZohoCustomer,
} from "./customers";

// ─── Public types ─────────────────────────────────────────────────────────

export type DryRunAction =
  | "CREATE_CANDIDATE"
  | "UPDATE_CANDIDATE"
  | "NO_CHANGE"
  | "NEEDS_REVIEW"
  | "CONFLICT";

export type DryRunReason =
  | "missing_sku"
  | "duplicate_sku_in_zoho"
  | "duplicate_zoho_id"
  | "inactive_in_zoho"
  | "local_already_mapped"
  | "material_code_mismatch"
  | "name_differs_from_local"
  | "missing_customer_code"
  | "customer_duplicate_in_zoho"
  | "no_match_in_luma"
  | "luma_target_unknown"
  | "mapping_present_no_change"
  | "mapping_present_name_changed";

export type DryRunItemRow = {
  action: DryRunAction;
  reasons: readonly DryRunReason[];
  zohoItemId: string;
  zohoName: string;
  sku: string | null;
  suggestedTarget: LumaItemTarget;
  matchedLumaId: string | null;
  matchedLumaTable: "products" | "tablet_types" | "packaging_materials" | null;
};

export type DryRunCustomerRow = {
  action: DryRunAction;
  reasons: readonly DryRunReason[];
  zohoCustomerId: string;
  zohoName: string;
  customerCodeSuggestion: string | null;
  matchedLumaId: string | null;
};

export type DryRunCounts = {
  scanned: number;
  createCandidates: number;
  updateCandidates: number;
  noChange: number;
  needsReview: number;
  conflicts: number;
};

export type DryRunResult =
  | {
      kind: "BLOCKED";
      readiness: ZohoReadiness;
      reason: string;
      itemRunId: string | null;
      customerRunId: string | null;
    }
  | {
      kind: "OK";
      readiness: ZohoReadiness;
      itemRunId: string;
      customerRunId: string;
      items: {
        rows: readonly DryRunItemRow[];
        counts: DryRunCounts;
        warnings: readonly string[];
      };
      customers: {
        rows: readonly DryRunCustomerRow[];
        counts: DryRunCounts;
        warnings: readonly string[];
      };
    }
  | {
      kind: "ERROR";
      readiness: ZohoReadiness;
      message: string;
    };

// ─── Luma-side snapshot types passed into the diff engine ────────────────

/** Subset of Luma master-table fields the diff needs. Tests stub these
 *  directly; real callers load them from the existing Drizzle queries. */
export type LumaItemSnapshot = {
  products: ReadonlyArray<{ id: string; sku: string; name: string; zohoItemId: string | null }>;
  tabletTypes: ReadonlyArray<{ id: string; sku: string | null; name: string; zohoItemId: string | null }>;
  packagingMaterials: ReadonlyArray<{ id: string; sku: string; name: string; zohoItemId: string | null }>;
};

export type LumaCustomerSnapshot = {
  customers: ReadonlyArray<{ id: string; customerCode: string; name: string; zohoCustomerId: string | null }>;
};

// ─── Pure diff helpers ────────────────────────────────────────────────────

/** Pure: diff a list of normalized Zoho items against the current Luma
 *  master snapshot. Never mutates either side. Idempotent. */
export function diffZohoItemsAgainstLuma(
  zohoItems: readonly NormalizedZohoItem[],
  luma: LumaItemSnapshot,
): { rows: DryRunItemRow[]; warnings: string[] } {
  const warnings: string[] = [];

  // Build lookup indexes once.
  const allLumaByZohoId = new Map<
    string,
    { id: string; table: "products" | "tablet_types" | "packaging_materials"; name: string }
  >();
  for (const p of luma.products) {
    if (p.zohoItemId) allLumaByZohoId.set(p.zohoItemId, { id: p.id, table: "products", name: p.name });
  }
  for (const t of luma.tabletTypes) {
    if (t.zohoItemId) allLumaByZohoId.set(t.zohoItemId, { id: t.id, table: "tablet_types", name: t.name });
  }
  for (const m of luma.packagingMaterials) {
    if (m.zohoItemId) allLumaByZohoId.set(m.zohoItemId, { id: m.id, table: "packaging_materials", name: m.name });
  }

  // Zoho-side duplicate detection (item_id MUST be unique inside Zoho,
  // but SKU can collide across products in Zoho's looser model).
  const zohoIdCounts = new Map<string, number>();
  const zohoSkuCounts = new Map<string, number>();
  for (const z of zohoItems) {
    zohoIdCounts.set(z.zohoItemId, (zohoIdCounts.get(z.zohoItemId) ?? 0) + 1);
    if (z.sku) {
      const k = z.sku.trim().toLowerCase();
      zohoSkuCounts.set(k, (zohoSkuCounts.get(k) ?? 0) + 1);
    }
  }

  const rows: DryRunItemRow[] = [];
  for (const z of zohoItems) {
    const reasons: DryRunReason[] = [];
    let action: DryRunAction = "CREATE_CANDIDATE";

    if ((zohoIdCounts.get(z.zohoItemId) ?? 0) > 1) {
      reasons.push("duplicate_zoho_id");
      action = "CONFLICT";
    }
    if (z.sku && (zohoSkuCounts.get(z.sku.trim().toLowerCase()) ?? 0) > 1) {
      reasons.push("duplicate_sku_in_zoho");
      action = "CONFLICT";
    }

    const matched = allLumaByZohoId.get(z.zohoItemId) ?? null;
    if (matched) {
      reasons.push("local_already_mapped");
      action = action === "CONFLICT" ? "CONFLICT" : "NO_CHANGE";
      if (matched.name !== z.name) {
        reasons.push("mapping_present_name_changed");
        action = action === "CONFLICT" ? "CONFLICT" : "UPDATE_CANDIDATE";
      } else if (action !== "CONFLICT") {
        reasons.push("mapping_present_no_change");
      }
    } else {
      // No mapping yet. Decide between CREATE_CANDIDATE / NEEDS_REVIEW.
      if (!z.sku) {
        reasons.push("missing_sku");
        action = action === "CONFLICT" ? "CONFLICT" : "NEEDS_REVIEW";
      }
      if (!z.active) {
        reasons.push("inactive_in_zoho");
        action = action === "CONFLICT" ? "CONFLICT" : "NEEDS_REVIEW";
      }
    }

    const suggestedTarget = deriveZohoItemLumaTarget(z);
    if (action !== "CONFLICT" && suggestedTarget === "UNKNOWN" && !matched) {
      reasons.push("luma_target_unknown");
      action = "NEEDS_REVIEW";
    }

    rows.push({
      action,
      reasons: Object.freeze(reasons),
      zohoItemId: z.zohoItemId,
      zohoName: z.name,
      sku: z.sku,
      suggestedTarget,
      matchedLumaId: matched?.id ?? null,
      matchedLumaTable: matched?.table ?? null,
    });
  }

  // Surface SKU collisions Luma will care about during ZOHO-3.
  for (const [sku, count] of zohoSkuCounts) {
    if (count > 1) warnings.push(`Zoho has ${count} items sharing SKU "${sku}".`);
  }

  return { rows, warnings };
}

/** Pure: diff Zoho customers against the Luma customers table. */
export function diffZohoCustomersAgainstLuma(
  zohoCustomers: readonly NormalizedZohoCustomer[],
  luma: LumaCustomerSnapshot,
): { rows: DryRunCustomerRow[]; warnings: string[] } {
  const warnings: string[] = [];

  const byZohoId = new Map<string, { id: string; name: string }>();
  for (const c of luma.customers) {
    if (c.zohoCustomerId) byZohoId.set(c.zohoCustomerId, { id: c.id, name: c.name });
  }

  const zohoIdCounts = new Map<string, number>();
  for (const z of zohoCustomers) {
    zohoIdCounts.set(z.zohoCustomerId, (zohoIdCounts.get(z.zohoCustomerId) ?? 0) + 1);
  }

  const rows: DryRunCustomerRow[] = [];
  for (const z of zohoCustomers) {
    const reasons: DryRunReason[] = [];
    let action: DryRunAction = "CREATE_CANDIDATE";

    if ((zohoIdCounts.get(z.zohoCustomerId) ?? 0) > 1) {
      reasons.push("customer_duplicate_in_zoho");
      action = "CONFLICT";
    }

    const matched = byZohoId.get(z.zohoCustomerId);
    if (matched) {
      reasons.push("local_already_mapped");
      action = action === "CONFLICT" ? "CONFLICT" : "NO_CHANGE";
      if (matched.name !== z.customerName) {
        reasons.push("mapping_present_name_changed");
        action = action === "CONFLICT" ? "CONFLICT" : "UPDATE_CANDIDATE";
      } else if (action !== "CONFLICT") {
        reasons.push("mapping_present_no_change");
      }
    } else {
      if (deriveZohoCustomerLumaTarget(z) === "UNKNOWN") {
        reasons.push("luma_target_unknown");
        action = action === "CONFLICT" ? "CONFLICT" : "NEEDS_REVIEW";
      }
      if (!z.customerCodeSuggestion) {
        reasons.push("missing_customer_code");
        action = action === "CONFLICT" ? "CONFLICT" : "NEEDS_REVIEW";
      }
      if (!z.active) {
        reasons.push("inactive_in_zoho");
        action = action === "CONFLICT" ? "CONFLICT" : "NEEDS_REVIEW";
      }
    }

    rows.push({
      action,
      reasons: Object.freeze(reasons),
      zohoCustomerId: z.zohoCustomerId,
      zohoName: z.customerName,
      customerCodeSuggestion: z.customerCodeSuggestion,
      matchedLumaId: matched?.id ?? null,
    });
  }

  return { rows, warnings };
}

/** Pure: roll up counts from a row list. */
export function countDryRunRows(
  rows: ReadonlyArray<{ action: DryRunAction }>,
): DryRunCounts {
  let createCandidates = 0;
  let updateCandidates = 0;
  let noChange = 0;
  let needsReview = 0;
  let conflicts = 0;
  for (const r of rows) {
    switch (r.action) {
      case "CREATE_CANDIDATE":
        createCandidates++;
        break;
      case "UPDATE_CANDIDATE":
        updateCandidates++;
        break;
      case "NO_CHANGE":
        noChange++;
        break;
      case "NEEDS_REVIEW":
        needsReview++;
        break;
      case "CONFLICT":
        conflicts++;
        break;
    }
  }
  return {
    scanned: rows.length,
    createCandidates,
    updateCandidates,
    noChange,
    needsReview,
    conflicts,
  };
}

// ─── Orchestrator ─────────────────────────────────────────────────────────

export type RunZohoDryRunSyncOpts = {
  loadLumaItems?: () => Promise<LumaItemSnapshot>;
  loadLumaCustomers?: () => Promise<LumaCustomerSnapshot>;
  fetchItems?: typeof fetchZohoItemsDryRun;
  fetchCustomers?: typeof fetchZohoCustomersDryRun;
  /** Override readiness probes (test seam). */
  probeReadiness?: () => Promise<ZohoReadiness>;
  /** Override the audit-row persister (test seam). */
  persistRun?: (input: PersistRunInput) => Promise<string>;
  actorUserId?: string | null;
  source?: string;
};

export type PersistRunInput = {
  syncType: "ITEMS" | "CUSTOMERS";
  status: "SUCCESS" | "PARTIAL" | "FAILED";
  source: string;
  summary: Record<string, unknown>;
  error: string | null;
  actorUserId: string | null;
};

export async function runZohoDryRunSync(
  opts: RunZohoDryRunSyncOpts = {},
): Promise<DryRunResult> {
  const probeReadiness =
    opts.probeReadiness ??
    (async () => {
      const health = await checkZohoGatewayHealth();
      const brand =
        health.status === "CONNECTED" ? await fetchZohoBrandStatus() : null;
      return deriveZohoReadiness({ health, brand }).readiness;
    });
  const persistRun = opts.persistRun ?? defaultPersistRun;
  const source = opts.source ?? "manual";
  const actorUserId = opts.actorUserId ?? null;

  const readiness = await probeReadiness();

  if (readiness !== "READY_FOR_DRY_RUN") {
    const reason = readinessBlockedMessage(readiness);
    // Write one PARTIAL ITEMS row (we choose ITEMS as the head row so
    // the operator-visible "Last items dry-run" reflects the gating
    // state). Customers row is not written when blocked — there's no
    // sense pretending we tried.
    const itemRunId = await persistRun({
      syncType: "ITEMS",
      status: "PARTIAL",
      source,
      summary: {
        readiness,
        blocked: true,
        message: reason,
        note: "ZOHO-2A dry-run blocked. No /items or /contacts_inv call attempted.",
      },
      error: reason,
      actorUserId,
    });
    return {
      kind: "BLOCKED",
      readiness,
      reason,
      itemRunId,
      customerRunId: null,
    };
  }

  // Ready — fetch + diff.
  const fetchItems = opts.fetchItems ?? fetchZohoItemsDryRun;
  const fetchCustomers = opts.fetchCustomers ?? fetchZohoCustomersDryRun;
  const loadLumaItems = opts.loadLumaItems ?? defaultLoadLumaItems;
  const loadLumaCustomers = opts.loadLumaCustomers ?? defaultLoadLumaCustomers;

  const [itemsResp, customersResp, lumaItems, lumaCustomers] = await Promise.all([
    fetchItems(),
    fetchCustomers(),
    loadLumaItems(),
    loadLumaCustomers(),
  ]);

  if (itemsResp.kind !== "OK" || customersResp.kind !== "OK") {
    const msg =
      itemsResp.kind !== "OK"
        ? `items: ${itemsResp.kind} — ${itemsResp.kind === "UNAUTHORIZED" ? itemsResp.message : "message" in itemsResp ? itemsResp.message : ""}`
        : `customers: ${customersResp.kind} — ${customersResp.kind === "UNAUTHORIZED" ? customersResp.message : "message" in customersResp ? customersResp.message : ""}`;
    return { kind: "ERROR", readiness, message: msg };
  }

  const itemDiff = diffZohoItemsAgainstLuma(itemsResp.items, lumaItems);
  const customerDiff = diffZohoCustomersAgainstLuma(customersResp.customers, lumaCustomers);
  const itemCounts = countDryRunRows(itemDiff.rows);
  const customerCounts = countDryRunRows(customerDiff.rows);

  const itemRunId = await persistRun({
    syncType: "ITEMS",
    status: itemCounts.conflicts > 0 ? "PARTIAL" : "SUCCESS",
    source,
    summary: {
      readiness,
      blocked: false,
      counts: itemCounts,
      warnings: itemDiff.warnings,
      rowsPreview: itemDiff.rows.slice(0, 50),
    },
    error: itemCounts.conflicts > 0 ? `${itemCounts.conflicts} conflict(s) need review.` : null,
    actorUserId,
  });
  const customerRunId = await persistRun({
    syncType: "CUSTOMERS",
    status: customerCounts.conflicts > 0 ? "PARTIAL" : "SUCCESS",
    source,
    summary: {
      readiness,
      blocked: false,
      counts: customerCounts,
      warnings: customerDiff.warnings,
      rowsPreview: customerDiff.rows.slice(0, 50),
    },
    error: customerCounts.conflicts > 0 ? `${customerCounts.conflicts} conflict(s) need review.` : null,
    actorUserId,
  });

  return {
    kind: "OK",
    readiness,
    itemRunId,
    customerRunId,
    items: {
      rows: itemDiff.rows,
      counts: itemCounts,
      warnings: itemDiff.warnings,
    },
    customers: {
      rows: customerDiff.rows,
      counts: customerCounts,
      warnings: customerDiff.warnings,
    },
  };
}

/** Pure: explain why a non-READY readiness blocks dry-run. */
export function readinessBlockedMessage(readiness: ZohoReadiness): string {
  switch (readiness) {
    case "READY_FOR_DRY_RUN":
      return "Ready.";
    case "NEEDS_REAUTH":
      return "Zoho gateway is reachable, but haute_brands tokens must be re-authorized before live dry-run can fetch items/customers.";
    case "NEEDS_SELECTION":
      return "Zoho gateway is reachable but no brand is selected. Set ZOHO_BRAND on the LXC before running dry-run.";
    case "CONNECTED_HEALTH_ONLY":
      return "Zoho gateway /health is reachable but /status did not return a brands list.";
    case "UNREACHABLE":
      return "Zoho gateway unreachable.";
    case "ERROR":
      return "Zoho gateway returned an error.";
    case "NOT_CONFIGURED":
      return "Zoho gateway is not configured (ZOHO_INTEGRATION_URL missing).";
  }
}

// ─── Defaults that talk to the real DB ────────────────────────────────────

async function defaultLoadLumaItems(): Promise<LumaItemSnapshot> {
  const { products, tabletTypes, packagingMaterials } = await import("@/lib/db/schema");
  const [p, t, m] = await Promise.all([
    db.select({ id: products.id, sku: products.sku, name: products.name, zohoItemId: products.zohoItemId }).from(products),
    db.select({ id: tabletTypes.id, sku: tabletTypes.sku, name: tabletTypes.name, zohoItemId: tabletTypes.zohoItemId }).from(tabletTypes),
    db.select({ id: packagingMaterials.id, sku: packagingMaterials.sku, name: packagingMaterials.name, zohoItemId: packagingMaterials.zohoItemId }).from(packagingMaterials),
  ]);
  return { products: p, tabletTypes: t, packagingMaterials: m };
}

async function defaultLoadLumaCustomers(): Promise<LumaCustomerSnapshot> {
  const { customers } = await import("@/lib/db/schema");
  const c = await db
    .select({
      id: customers.id,
      customerCode: customers.customerCode,
      name: customers.name,
      zohoCustomerId: customers.zohoCustomerId,
    })
    .from(customers);
  return { customers: c };
}

async function defaultPersistRun(input: PersistRunInput): Promise<string> {
  const inserted = await db
    .insert(zohoSyncRuns)
    .values({
      syncType: input.syncType,
      status: input.status,
      finishedAt: new Date(),
      source: input.source,
      dryRun: true,
      summary: input.summary,
      error: input.error,
      createdByUserId: input.actorUserId,
    })
    .returning({ id: zohoSyncRuns.id });
  return inserted[0]?.id ?? "";
}
