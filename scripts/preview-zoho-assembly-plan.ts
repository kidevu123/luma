// ZOHO-ASSY-2 — Dev/debug script: print the dry-run assembly plan for a lot.
//
// Usage:
//   DATABASE_URL=postgres://... tsx scripts/preview-zoho-assembly-plan.ts <finishedLotId>
//
// Read-only. No DB writes. No Zoho calls. No enqueue.
// Useful for verifying source resolution before enabling Phase 3.

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/lib/db/schema";
import {
  computeZohoAssemblyPlan,
  type PlannerRawInputs,
  type PlannerLedgerRow,
  type PlannerFallbackRow,
  type PlannerBomRow,
} from "@/lib/zoho/assembly-planner";
import { eq, and, inArray } from "drizzle-orm";

const {
  finishedLots, products,
  rawBagAllocationSessions, inventoryBags, tabletTypes,
  smallBoxes, receives, poLines, purchaseOrders,
  finishedLotInputs, batches,
  productPackagingSpecs, packagingMaterials,
} = schema;

async function main() {
  const finishedLotId = process.argv[2];
  if (!finishedLotId) {
    console.error("Usage: tsx scripts/preview-zoho-assembly-plan.ts <finishedLotId>");
    process.exit(1);
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set");

  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  // Load lot + product
  const [lotRow] = await db
    .select({ lot: finishedLots, product: products })
    .from(finishedLots)
    .leftJoin(products, eq(finishedLots.productId, products.id))
    .where(eq(finishedLots.id, finishedLotId));

  if (!lotRow) {
    console.error(`No finished lot found for id: ${finishedLotId}`);
    await client.end();
    process.exit(1);
  }

  const { lot, product } = lotRow;

  // LEDGER path
  const rawLedgerRows = await db
    .select({
      inventoryBagId:   rawBagAllocationSessions.inventoryBagId,
      consumedQty:      rawBagAllocationSessions.consumedQty,
      tabletTypeId:     inventoryBags.tabletTypeId,
      tabletZohoItemId: tabletTypes.zohoItemId,
      tabletName:       tabletTypes.name,
      receivePoLineId:  receives.poLineId,
      zohoLineItemId:   poLines.zohoLineItemId,
      zohoPoId:         purchaseOrders.zohoPoId,
      componentRole:    rawBagAllocationSessions.componentRole,
    })
    .from(rawBagAllocationSessions)
    .innerJoin(inventoryBags,  eq(rawBagAllocationSessions.inventoryBagId, inventoryBags.id))
    .innerJoin(tabletTypes,    eq(inventoryBags.tabletTypeId, tabletTypes.id))
    .innerJoin(smallBoxes,     eq(inventoryBags.smallBoxId, smallBoxes.id))
    .innerJoin(receives,       eq(smallBoxes.receiveId, receives.id))
    .leftJoin(poLines,         eq(receives.poLineId, poLines.id))
    .leftJoin(purchaseOrders,  eq(rawBagAllocationSessions.poId, purchaseOrders.id))
    .where(
      and(
        eq(rawBagAllocationSessions.finishedLotId, finishedLotId),
        inArray(rawBagAllocationSessions.allocationStatus, ["CLOSED", "DEPLETED"]),
      ),
    );

  // FALLBACK path (only when LEDGER empty)
  const rawFallbackRows = rawLedgerRows.length > 0
    ? []
    : await db
        .select({
          batchId:          finishedLotInputs.batchId,
          qtyConsumed:      finishedLotInputs.qtyConsumed,
          tabletTypeId:     batches.tabletTypeId,
          tabletName:       tabletTypes.name,
          tabletZohoItemId: tabletTypes.zohoItemId,
        })
        .from(finishedLotInputs)
        .innerJoin(batches,    eq(finishedLotInputs.batchId, batches.id))
        .leftJoin(tabletTypes, eq(batches.tabletTypeId, tabletTypes.id))
        .where(
          and(
            eq(finishedLotInputs.finishedLotId, finishedLotId),
            eq(batches.kind, "TABLET"),
          ),
        );

  // BOM specs
  const rawBomRows = product
    ? await db
        .select({
          perScope:           productPackagingSpecs.perScope,
          materialId:         packagingMaterials.id,
          materialName:       packagingMaterials.name,
          materialZohoItemId: packagingMaterials.zohoItemId,
          qtyPerUnit:         productPackagingSpecs.qtyPerUnit,
        })
        .from(productPackagingSpecs)
        .innerJoin(
          packagingMaterials,
          eq(productPackagingSpecs.packagingMaterialId, packagingMaterials.id),
        )
        .where(eq(productPackagingSpecs.productId, product.id))
    : [];

  const inputs: PlannerRawInputs = {
    finishedLotId,
    finishedLotNumber: lot.finishedLotNumber,
    unitsProduced:     lot.unitsProduced,
    displaysProduced:  lot.displaysProduced,
    casesProduced:     lot.casesProduced,
    product: product
      ? {
          id:                product.id,
          name:              product.name,
          sku:               product.sku,
          kind:              product.kind,
          zohoItemIdUnit:    product.zohoItemIdUnit    ?? null,
          zohoItemIdDisplay: product.zohoItemIdDisplay ?? null,
          zohoItemIdCase:    product.zohoItemIdCase    ?? null,
        }
      : null,
    ledgerRows: rawLedgerRows.map((r): PlannerLedgerRow => ({
      inventoryBagId:   r.inventoryBagId,
      consumedQty:      r.consumedQty,
      tabletTypeId:     r.tabletTypeId,
      tabletZohoItemId: r.tabletZohoItemId ?? null,
      tabletName:       r.tabletName,
      receivePoLineId:  r.receivePoLineId  ?? null,
      zohoLineItemId:   r.zohoLineItemId   ?? null,
      zohoPoId:         r.zohoPoId         ?? null,
      componentRole:    r.componentRole    ?? null,
    })),
    fallbackRows: rawFallbackRows.map((r): PlannerFallbackRow => ({
      batchId:          r.batchId,
      qtyConsumed:      r.qtyConsumed,
      tabletTypeId:     r.tabletTypeId     ?? null,
      tabletName:       r.tabletName       ?? null,
      tabletZohoItemId: r.tabletZohoItemId ?? null,
    })),
    bomRows: rawBomRows.map((r): PlannerBomRow => ({
      perScope:           r.perScope,
      materialId:         r.materialId,
      materialName:       r.materialName,
      materialZohoItemId: r.materialZohoItemId ?? null,
      qtyPerUnit:         r.qtyPerUnit,
    })),
  };

  const plan = computeZohoAssemblyPlan(inputs);

  console.log("\n=== Zoho Assembly Plan (dry run) ===\n");
  console.log(`Lot:          ${plan.finishedLotNumber} (${plan.finishedLotId})`);
  console.log(`Product:      ${plan.product?.name ?? "none"} (${plan.product?.sku ?? "—"})`);
  console.log(`Source:       ${plan.sourceMethod}`);
  console.log(`Overall:      ${plan.overallStatus}`);
  if (plan.issues.length > 0) {
    console.log(`\nIssues:`);
    for (const i of plan.issues) console.log(`  ! ${i}`);
  }
  console.log(`\nOps (${plan.ops.length}):`);
  for (const op of plan.ops) {
    const label = `  [${op.opSequence}] ${op.opKind.padEnd(20)} qty=${op.quantity.toLocaleString().padStart(6)}  ${op.statusPreview}`;
    console.log(label);
    if (op.statusReason) console.log(`       reason: ${op.statusReason}`);
    if (op.opKind === "TABLET_RECEIVE") {
      if (op.componentRole)  console.log(`       role:   ${op.componentRole}`);
      if (op.zohoPoId)       console.log(`       po:     ${op.zohoPoId}`);
      if (op.zohoLineItemId) console.log(`       line:   ${op.zohoLineItemId}`);
    }
    if (op.opKind !== "TABLET_RECEIVE" && op.bomLines.length > 0) {
      for (const bl of op.bomLines) {
        const issueFlag = bl.issue ? " [MISSING ZOHO ID]" : "";
        console.log(`       bom:    ${bl.materialName} × ${bl.expectedQty}${issueFlag}`);
      }
    }
  }
  console.log(`\nFull plan JSON:\n`);
  console.log(JSON.stringify(plan, null, 2));

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
