// CLOSEOUT-DRAWER-1 — READ-ONLY per-bag detail aggregate for the PO
// Closeout drawer. Composes existing sources only (per-bag production
// summary, workflow genealogy, PO output comparison, product setup
// readiness, Zoho op, audit trail) — recomputes nothing, creates no new
// ledger, never mutates. Loaded lazily when a drawer opens.

import { eq, inArray, desc } from "drizzle-orm";
import { unstable_noStore as noStore } from "next/cache";
import { db } from "@/lib/db";
import { auditLog, inventoryBags, products, workflowBags } from "@/lib/db/schema";
import { loadBagProductionSummaries } from "@/lib/db/queries/bag-production-summary";
import type { BagProductionSummary } from "@/lib/production/bag-production-summary";
import { deriveBagGenealogy } from "@/lib/production/metrics";
import type { BagGenealogyResult } from "@/lib/production/types";
import {
  derivePoOutputComparison,
  type PoOutputComparisonLine,
} from "@/lib/production/po-reconciliation";
import {
  evaluateProductSetupReadiness,
  type ProductSetupReadiness,
} from "@/lib/production/product-setup-readiness";
import { getActiveZohoProductionOutputOpForLot } from "@/lib/db/queries/zoho-production-output";
import { listAuditLogsForInventoryBags } from "@/lib/db/queries/audit-log";
import {
  deriveApplicableBagActions,
  type BagDrawerActionKey,
} from "@/lib/production/bag-closeout-actions";

const TIMELINE_EVENT_CAP = 50;
const ADMIN_ACTION_CAP = 30;

/** Audit actions relevant to closeout — spec-pinned prefixes. */
const AUDIT_ACTION_PREFIXES = [
  "finished_lot.",
  "raw_bag_allocation.",
  "workflow_submissions.",
  "inventory_bag.",
  "qr_card.",
  "live_ops_repair.",
] as const;

function isCloseoutRelevantAction(action: string): boolean {
  return AUDIT_ACTION_PREFIXES.some((p) => action.startsWith(p));
}

export type BagCloseoutAdminAction = {
  createdAt: Date;
  action: string;
  targetType: string;
  actorEmail: string | null;
  actorRole: string | null;
};

export type BagCloseoutDetail = {
  summary: BagProductionSummary | null;
  /** Latest workflow's genealogy, events capped at TIMELINE_EVENT_CAP. */
  timeline: BagGenealogyResult | null;
  /** This bag's flavor line from the PO ordered/received/produced view. */
  crossCheck: PoOutputComparisonLine | null;
  zohoReadiness: {
    setup: ProductSetupReadiness | null;
    op: { id: string; status: string } | null;
  };
  adminActions: BagCloseoutAdminAction[];
  applicableActions: BagDrawerActionKey[];
  evaluatedAt: Date;
};

export type BagCloseoutRowFacts = {
  status: string;
  action: string;
  zoho: string;
  workflowBagId: string | null;
  finishedLotId: string | null;
  lotStatus: string | null;
  receiveId: string | null;
};

export async function loadBagCloseoutDetail(args: {
  inventoryBagId: string;
  row: BagCloseoutRowFacts;
  poId: string;
}): Promise<BagCloseoutDetail> {
  // Live on every drawer open — never served from any framework cache.
  noStore();
  const { inventoryBagId, row, poId } = args;

  const summaries = await loadBagProductionSummaries({
    inventoryBagIds: [inventoryBagId],
  });
  const summary = summaries.get(inventoryBagId) ?? null;

  // Timeline — latest workflow's event genealogy (capped for display).
  let timeline: BagGenealogyResult | null = null;
  if (row.workflowBagId) {
    const genealogy = await deriveBagGenealogy(row.workflowBagId);
    timeline = {
      ...genealogy,
      events: genealogy.events.slice(0, TIMELINE_EVENT_CAP),
    };
  }

  // Cross-check — the PO's ordered/received/produced line for this bag's
  // tablet type. Fails soft to null (drawer shows "no PO line"), never
  // takes down the whole drawer.
  let crossCheck: PoOutputComparisonLine | null = null;
  try {
    const [bagRow] = await db
      .select({ tabletTypeId: inventoryBags.tabletTypeId })
      .from(inventoryBags)
      .where(eq(inventoryBags.id, inventoryBagId));
    if (bagRow?.tabletTypeId) {
      const lines = await derivePoOutputComparison(poId);
      crossCheck =
        lines.find((l) => l.tabletTypeId === bagRow.tabletTypeId) ?? null;
    }
  } catch {
    crossCheck = null;
  }

  // Zoho readiness — exact product-setup blockers + the active op.
  let setup: ProductSetupReadiness | null = null;
  if (row.workflowBagId) {
    const [productRow] = await db
      .select({
        productId: products.id,
        tabletsPerUnit: products.tabletsPerUnit,
        unitsPerDisplay: products.unitsPerDisplay,
        displaysPerCase: products.displaysPerCase,
        defaultShelfLifeDays: products.defaultShelfLifeDays,
        zohoItemIdUnit: products.zohoItemIdUnit,
        zohoItemIdDisplay: products.zohoItemIdDisplay,
        zohoItemIdCase: products.zohoItemIdCase,
      })
      .from(workflowBags)
      .innerJoin(products, eq(products.id, workflowBags.productId))
      .where(eq(workflowBags.id, row.workflowBagId));
    if (productRow) {
      setup = evaluateProductSetupReadiness({
        productId: productRow.productId,
        tabletsPerUnit: productRow.tabletsPerUnit,
        unitsPerDisplay: productRow.unitsPerDisplay,
        displaysPerCase: productRow.displaysPerCase,
        defaultShelfLifeDays: productRow.defaultShelfLifeDays,
        zohoItemIdUnit: productRow.zohoItemIdUnit,
        zohoItemIdDisplay: productRow.zohoItemIdDisplay,
        zohoItemIdCase: productRow.zohoItemIdCase,
      });
    }
  }
  let op: { id: string; status: string } | null = null;
  if (row.finishedLotId) {
    const activeOp = await getActiveZohoProductionOutputOpForLot(row.finishedLotId);
    op = activeOp ? { id: activeOp.id, status: activeOp.status } : null;
  }

  // Admin action trail — audit rows for the bag itself plus its workflow /
  // lot targets, filtered to closeout-relevant prefixes.
  const bagAudits = await listAuditLogsForInventoryBags([inventoryBagId], 500);
  const relatedTargetIds = [row.workflowBagId, row.finishedLotId].filter(
    (v): v is string => v != null,
  );
  const relatedAudits = relatedTargetIds.length
    ? await db
        .select({
          createdAt: auditLog.createdAt,
          action: auditLog.action,
          targetType: auditLog.targetType,
        })
        .from(auditLog)
        .where(inArray(auditLog.targetId, relatedTargetIds))
        .orderBy(desc(auditLog.createdAt))
        .limit(200)
    : [];
  const adminActions: BagCloseoutAdminAction[] = [
    ...bagAudits.map((a) => ({
      createdAt: a.createdAt,
      action: a.action,
      targetType: a.targetType,
      actorEmail: a.actorEmail,
      actorRole: a.actorRole,
    })),
    ...relatedAudits.map((a) => ({
      createdAt: a.createdAt,
      action: a.action,
      targetType: a.targetType,
      actorEmail: null,
      actorRole: null,
    })),
  ]
    .filter((a) => isCloseoutRelevantAction(a.action))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, ADMIN_ACTION_CAP);

  const applicableActions = deriveApplicableBagActions({
    rowStatus: row.status,
    rowAction: row.action,
    zoho: row.zoho,
    hasWorkflow: row.workflowBagId != null,
    hasFinishedLot: row.finishedLotId != null,
    lotStatus: row.lotStatus,
    allocationOpen: summary?.allocation?.isOpen ?? false,
  });

  return {
    summary,
    timeline,
    crossCheck,
    zohoReadiness: { setup, op },
    adminActions,
    applicableActions,
    evaluatedAt: new Date(),
  };
}
