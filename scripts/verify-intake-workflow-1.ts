// INTAKE-WORKFLOW-1 — in-container end-to-end verification.
//
// Seeds a QA PO + PO line + tablet type, calls
// createRawBagIntakeAtomic to receive 10 bags with QA-R1001 .. QA-R1010
// receipt numbers + QR codes, asserts the bags landed with the right
// links, queries findRawBagByReceiptOrQr to confirm receipt + QR
// lookup both resolve to the same bag with PO/vendor/product/supplier
// lot context, then cleans up the QA rows (audit log entries stay as
// forensic record).
//
// Run inside the staging app container:
//   docker compose exec -T app npx tsx /app/scripts/verify-intake-workflow-1.ts
//
// Does NOT create finished_lots / customer trace codes. Does NOT call
// Zoho or Nexus.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  batches,
  finishedLots,
  inventoryBags,
  poLines,
  purchaseOrders,
  receives,
  smallBoxes,
  tabletTypes,
  users,
} from "@/lib/db/schema";
import {
  createRawBagIntakeAtomic,
  findRawBagByReceiptOrQr,
} from "@/lib/db/queries/raw-bag-intake";

const QA_PO_NUMBER = "QA-PO-1234";
const QA_VENDOR = "QA Vendor X";
const QA_TABLET_SKU = "QA-MANGO-PEACH";
const QA_TABLET_NAME = "QA Mango Peach";
const QA_SUPPLIER_LOT = "QA-1243";
const RECEIPT_START = "QA-R1001";

async function main() {
  console.log("[intake-1] starting verify run");

  // Pick the seeded owner / admin user for the actor.
  const [actor] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.email, "admin@luma"))
    .limit(1);
  if (!actor) {
    console.error("[intake-1] no admin@luma user found");
    process.exit(2);
  }
  console.log("  actor=", actor.id);

  // ── Seed QA tablet type + PO + PO line ────────────────────────────
  await cleanupQaRows(); // idempotent — wipe any prior QA leftover first

  const [tablet] = await db
    .insert(tabletTypes)
    .values({ sku: QA_TABLET_SKU, name: QA_TABLET_NAME, isActive: true })
    .returning();
  if (!tablet) throw new Error("[intake-1] failed to seed tablet type");

  const [po] = await db
    .insert(purchaseOrders)
    .values({
      poNumber: QA_PO_NUMBER,
      vendorName: QA_VENDOR,
      status: "OPEN" as const,
      notes: "QA — INTAKE-WORKFLOW-1 verify",
    })
    .returning();
  if (!po) throw new Error("[intake-1] failed to seed PO");

  const [line] = await db
    .insert(poLines)
    .values({
      poId: po.id,
      tabletTypeId: tablet.id,
      qtyOrdered: 200_000,
      notes: "QA",
    })
    .returning();
  if (!line) throw new Error("[intake-1] failed to seed PO line");
  console.log("  seeded PO=", po.id, "line=", line.id, "tablet=", tablet.id);

  // ── Call the intake action with 10 bags ───────────────────────────
  const result = await createRawBagIntakeAtomic(
    {
      poMode: "LOCAL_PO",
      poId: po.id,
      poLineId: line.id,
      poNumberManual: null,
      vendorNameManual: null,
      orderedQuantity: 200_000,
      tabletTypeId: tablet.id,
      supplierLotNumber: QA_SUPPLIER_LOT,
      rows: Array.from({ length: 10 }, (_, i) => ({
        bagSequence: i + 1,
        receiptNumber: `QA-R${1001 + i}`,
        bagQrCode: `QA-QR-${1001 + i}`,
        declaredCount: 20_000,
      })),
    },
    { id: actor.id, role: actor.role } as never,
  );
  if (!result.ok) {
    console.error("[intake-1] createRawBagIntakeAtomic failed:", result.error);
    process.exit(2);
  }
  console.log("  result.ok receive=", result.receiveId, "bags=", result.bagCount);

  if (result.bagCount !== 10) {
    console.error("[intake-1] expected 10 bags, got", result.bagCount);
    process.exit(2);
  }
  if (result.receivedQuantity !== 200_000) {
    console.error("[intake-1] receivedQuantity mismatch:", result.receivedQuantity);
    process.exit(2);
  }
  if (result.variance !== 0) {
    console.error("[intake-1] variance should be 0, got:", result.variance);
    process.exit(2);
  }
  if (result.receiptRange?.first !== "QA-R1001" || result.receiptRange?.last !== "QA-R1010") {
    console.error("[intake-1] receipt range mismatch:", result.receiptRange);
    process.exit(2);
  }
  console.log("  ✓ variance EXACT @ 200,000");
  console.log("  ✓ receipt range QA-R1001 → QA-R1010");

  // ── Lookup by receipt number QA-R1004 ─────────────────────────────
  const byReceipt = await findRawBagByReceiptOrQr("QA-R1004");
  if (!byReceipt.found) {
    console.error("[intake-1] receipt lookup did not find QA-R1004");
    process.exit(2);
  }
  if (byReceipt.po.poNumber !== QA_PO_NUMBER) {
    console.error("[intake-1] receipt → PO mismatch:", byReceipt.po.poNumber);
    process.exit(2);
  }
  if (byReceipt.po.vendorName !== QA_VENDOR) {
    console.error("[intake-1] receipt → vendor mismatch:", byReceipt.po.vendorName);
    process.exit(2);
  }
  if (byReceipt.product.tabletTypeName !== QA_TABLET_NAME) {
    console.error("[intake-1] receipt → product mismatch:", byReceipt.product.tabletTypeName);
    process.exit(2);
  }
  if (byReceipt.supplierLot.batchNumber !== QA_SUPPLIER_LOT) {
    console.error("[intake-1] receipt → supplier lot mismatch:", byReceipt.supplierLot.batchNumber);
    process.exit(2);
  }
  if (byReceipt.bag.bagSequence !== 4) {
    console.error("[intake-1] receipt → bag sequence mismatch:", byReceipt.bag.bagSequence);
    process.exit(2);
  }
  console.log("  ✓ receipt QA-R1004 →", byReceipt.po.poNumber, "·", byReceipt.po.vendorName, "·", byReceipt.product.tabletTypeName, "· lot", byReceipt.supplierLot.batchNumber, "· bag", byReceipt.bag.bagSequence);

  // ── Lookup by QR code QA-QR-1004 ──────────────────────────────────
  const byQr = await findRawBagByReceiptOrQr("QA-QR-1004");
  if (!byQr.found) {
    console.error("[intake-1] qr lookup did not find QA-QR-1004");
    process.exit(2);
  }
  if (byQr.bag.id !== byReceipt.bag.id) {
    console.error("[intake-1] qr lookup returned different bag than receipt lookup");
    process.exit(2);
  }
  console.log("  ✓ qr QA-QR-1004 resolves to the same bag as receipt QA-R1004");

  // ── Assert no finished_lots created ───────────────────────────────
  const fl = await db.select().from(finishedLots).where(eq(finishedLots.productId, tablet.id));
  if (fl.length !== 0) {
    console.error("[intake-1] raw intake unexpectedly created finished_lots:", fl.length);
    process.exit(2);
  }
  console.log("  ✓ no finished_lots created during raw intake");

  // ── Cleanup ────────────────────────────────────────────────────────
  await cleanupQaRows();
  console.log("  cleanup ok");
  console.log("[intake-1] verify OK");
  process.exit(0);
}

async function cleanupQaRows() {
  // Delete in FK-safe order. Soft-deletes aren't used here because
  // these are QA-only rows. The audit_log entries remain.
  const [po] = await db
    .select({ id: purchaseOrders.id })
    .from(purchaseOrders)
    .where(eq(purchaseOrders.poNumber, QA_PO_NUMBER));
  if (po) {
    // Find receives → boxes → bags chain and delete bottom-up.
    const recs = await db
      .select({ id: receives.id })
      .from(receives)
      .where(eq(receives.poId, po.id));
    for (const r of recs) {
      const boxes = await db
        .select({ id: smallBoxes.id })
        .from(smallBoxes)
        .where(eq(smallBoxes.receiveId, r.id));
      for (const b of boxes) {
        await db.delete(inventoryBags).where(eq(inventoryBags.smallBoxId, b.id));
      }
      await db.delete(smallBoxes).where(eq(smallBoxes.receiveId, r.id));
    }
    await db.delete(receives).where(eq(receives.poId, po.id));
    await db.delete(poLines).where(eq(poLines.poId, po.id));
    await db.delete(purchaseOrders).where(eq(purchaseOrders.id, po.id));
  }
  await db.delete(batches).where(eq(batches.batchNumber, QA_SUPPLIER_LOT));
  await db.delete(tabletTypes).where(eq(tabletTypes.sku, QA_TABLET_SKU));
}

main().catch((err) => {
  console.error("[intake-1] verify FAILED", err);
  process.exit(1);
});
