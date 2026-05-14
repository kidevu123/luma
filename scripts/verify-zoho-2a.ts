// ZOHO-2A — in-container verification harness.
//
// Mirrors runItemCustomerDryRunAction minus the requireAdmin wrapper.
// Calls runZohoDryRunSync against the real gateway. Because
// haute_brands tokens are currently expired on the gateway,
// readiness should resolve to NEEDS_REAUTH and the run should be
// BLOCKED — writing exactly one PARTIAL ITEMS row and NO live
// item/customer fetch.
//
// Run inside the app container:
//   docker compose exec -T app npx tsx /app/scripts/verify-zoho-2a.ts
//
// Does NOT mutate products/customers/tablet_types/packaging_materials.
// Does NOT call Zoho writes.

import { db } from "@/lib/db";
import { zohoSyncRuns } from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";
import { runZohoDryRunSync } from "@/lib/integrations/zoho/sync-dry-run";

async function main() {
  console.log("[zoho-2a] starting verify run");

  // Track fetcher invocations to prove fetch was not called when
  // blocked.
  let itemFetcherCalled = false;
  let customerFetcherCalled = false;

  const result = await runZohoDryRunSync({
    source: "verify-script",
    actorUserId: null,
    fetchItems: async () => {
      itemFetcherCalled = true;
      return { kind: "ERROR", message: "should not be called when blocked" };
    },
    fetchCustomers: async () => {
      customerFetcherCalled = true;
      return { kind: "ERROR", message: "should not be called when blocked" };
    },
    loadLumaItems: async () => ({ products: [], tabletTypes: [], packagingMaterials: [] }),
    loadLumaCustomers: async () => ({ customers: [] }),
  });

  console.log("  result.kind=", result.kind);
  if (result.kind === "BLOCKED") {
    console.log("  readiness=", result.readiness);
    console.log("  reason=", result.reason);
    console.log("  itemRunId=", result.itemRunId);
    console.log("  customerRunId=", result.customerRunId);
  } else if (result.kind === "ERROR") {
    console.log("  message=", result.message);
  } else if (result.kind === "OK") {
    console.log("  items.counts=", result.items.counts);
    console.log("  customers.counts=", result.customers.counts);
  }
  console.log("  itemFetcherCalled=", itemFetcherCalled);
  console.log("  customerFetcherCalled=", customerFetcherCalled);

  // Assert invariants: ZOHO-2A must NEVER hit item/customer endpoints
  // when readiness is non-READY.
  if (result.kind === "BLOCKED") {
    if (itemFetcherCalled || customerFetcherCalled) {
      console.error("  FAIL: fetcher invoked despite BLOCKED outcome");
      process.exit(2);
    }
    if (!result.itemRunId || result.customerRunId !== null) {
      console.error("  FAIL: expected exactly one PARTIAL ITEMS row + no CUSTOMERS row");
      process.exit(2);
    }
  }

  // Read back the latest rows to confirm persistence.
  const recentItems = await db
    .select({
      id: zohoSyncRuns.id,
      status: zohoSyncRuns.status,
      source: zohoSyncRuns.source,
      error: zohoSyncRuns.error,
    })
    .from(zohoSyncRuns)
    .where(eq(zohoSyncRuns.syncType, "ITEMS"))
    .orderBy(desc(zohoSyncRuns.startedAt))
    .limit(3);
  console.log("  recent ITEMS rows:");
  for (const r of recentItems) {
    console.log(
      `    ${r.id.slice(0, 8)} ${r.status.padEnd(8)} ${r.source.padEnd(14)} ${r.error?.slice(0, 60) ?? ""}`,
    );
  }
  const recentCustomers = await db
    .select({
      id: zohoSyncRuns.id,
      status: zohoSyncRuns.status,
      source: zohoSyncRuns.source,
    })
    .from(zohoSyncRuns)
    .where(eq(zohoSyncRuns.syncType, "CUSTOMERS"))
    .orderBy(desc(zohoSyncRuns.startedAt))
    .limit(3);
  console.log("  recent CUSTOMERS rows:");
  for (const r of recentCustomers) {
    console.log(`    ${r.id.slice(0, 8)} ${r.status.padEnd(8)} ${r.source}`);
  }

  console.log("[zoho-2a] verify OK");
  process.exit(0);
}

main().catch((err) => {
  console.error("[zoho-2a] verify FAILED", err);
  process.exit(1);
});
