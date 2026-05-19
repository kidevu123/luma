"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { externalSystems, externalItemMappings, zohoSyncRuns } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import {
  fetchZohoItemsDryRun,
  deriveZohoItemLumaTarget,
} from "@/lib/integrations/zoho/items";

export async function runZohoItemsSyncAction(): Promise<
  | { ok: true; scanned: number; created: number; updated: number }
  | { error: string }
> {
  await requireAdmin();

  const result = await fetchZohoItemsDryRun();

  if (result.kind !== "OK") {
    const message: string =
      result.kind === "UNAUTHORIZED" || result.kind === "UNREACHABLE" || result.kind === "ERROR"
        ? result.message
        : result.kind === "NOT_CONFIGURED"
          ? result.message
          : `Zoho fetch failed: ${result.kind}`;

    await db.insert(zohoSyncRuns).values({
      syncType: "ITEMS",
      status: "FAILED",
      dryRun: false,
      source: "manual",
      finishedAt: new Date(),
      summary: { kind: result.kind },
      error: message,
    });

    return { error: message };
  }

  const [zohoSystem] = await db
    .select({ id: externalSystems.id })
    .from(externalSystems)
    .where(eq(externalSystems.code, "ZOHO"))
    .limit(1);

  if (!zohoSystem) {
    return { error: "Zoho external_system row missing. Run migration 0014." };
  }

  const zohoSystemId = zohoSystem.id;
  let created = 0;
  let updated = 0;

  for (const item of result.items) {
    const mappingType = deriveZohoItemLumaTarget(item);

    const existing = await db
      .select({
        id: externalItemMappings.id,
        mappingType: externalItemMappings.mappingType,
        lumaItemId: externalItemMappings.lumaItemId,
        lumaProductId: externalItemMappings.lumaProductId,
        materialItemId: externalItemMappings.materialItemId,
      })
      .from(externalItemMappings)
      .where(
        sql`${externalItemMappings.externalSystemId} = ${zohoSystemId}::uuid
          AND ${externalItemMappings.externalItemId} = ${item.zohoItemId}`,
      )
      .limit(1);

    const isNew = existing.length === 0;

    const resolvedMappingType =
      isNew
        ? mappingType
        : existing[0]?.mappingType === "UNKNOWN"
          ? mappingType
          : (existing[0]?.mappingType ?? mappingType);

    const metadataPayload = {
      rate: item.rate,
      purchaseRate: item.purchaseRate,
      unit: item.unit,
      category: item.category,
      active: item.active,
      itemType: item.itemType,
      raw: item.raw,
    };

    await db
      .insert(externalItemMappings)
      .values({
        externalSystemId: zohoSystemId,
        externalItemId: item.zohoItemId,
        externalItemCode: item.sku,
        externalItemName: item.name,
        mappingType: resolvedMappingType,
        isActive: item.active,
        lastSyncedAt: new Date(),
        payload: metadataPayload,
      })
      .onConflictDoUpdate({
        target: [externalItemMappings.externalSystemId, externalItemMappings.externalItemId],
        set: {
          externalItemName: item.name,
          externalItemCode: item.sku,
          lastSyncedAt: new Date(),
          isActive: item.active,
          payload: metadataPayload,
          mappingType: sql`CASE WHEN ${externalItemMappings.mappingType} = 'UNKNOWN' THEN ${resolvedMappingType}::text ELSE ${externalItemMappings.mappingType} END`,
          updatedAt: new Date(),
        },
      });

    if (isNew) {
      created++;
    } else {
      updated++;
    }
  }

  const scanned = result.items.length;

  await db.insert(zohoSyncRuns).values({
    syncType: "ITEMS",
    status: "SUCCESS",
    dryRun: false,
    source: "manual",
    finishedAt: new Date(),
    summary: {
      scanned,
      created,
      updated,
    },
    error: null,
  });

  revalidatePath("/settings/integrations/zoho-items");

  return { ok: true, scanned, created, updated };
}
