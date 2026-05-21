"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  externalSystems,
  externalItemMappings,
  zohoSyncRuns,
  packagingMaterials,
} from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import {
  fetchZohoItemsDryRun,
  deriveZohoItemLumaTarget,
  type NormalizedZohoItem,
} from "@/lib/integrations/zoho/items";

type PackagingKind = typeof packagingMaterials.$inferInsert["kind"];

function derivePackagingKind(item: NormalizedZohoItem): PackagingKind {
  const n = (item.name ?? "").toLowerCase();
  const cat = (item.category ?? "").toLowerCase();
  const u = (item.unit ?? "").toLowerCase();
  const combined = `${n} ${cat} ${u}`;
  if (combined.includes("pvc")) return "PVC_ROLL";
  if (combined.includes("foil roll") || (combined.includes("foil") && combined.includes("roll"))) return "FOIL_ROLL";
  if (combined.includes("blister foil") || combined.includes("blister film")) return "BLISTER_FOIL";
  if (combined.includes("heat seal")) return "HEAT_SEAL_FILM";
  if (combined.includes("shrink")) return "SHRINK_BAND";
  if (combined.includes("bottle")) return "BOTTLE";
  if (combined.includes("cap")) return "CAP";
  if (combined.includes("induction")) return "INDUCTION_SEAL";
  if (combined.includes("label")) return "LABEL";
  if (combined.includes("desiccant")) return "DESICCANT";
  if (combined.includes("cotton")) return "COTTON";
  if (combined.includes("insert")) return "INSERT";
  if (combined.includes("display")) return "DISPLAY";
  if (combined.includes("case") || combined.includes("carton")) return "CASE";
  return "OTHER";
}

function deriveUom(item: NormalizedZohoItem): string {
  const u = (item.unit ?? "").toLowerCase();
  if (u === "kg" || u.includes("kilogram")) return "kg";
  if (u === "g" || u.includes("gram")) return "g";
  if (u.includes("roll")) return "roll";
  return "each";
}

export async function runZohoItemsSyncAction(): Promise<
  | { ok: true; scanned: number; created: number; updated: number; materialsCreated: number }
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
  let materialsCreated = 0;

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

    // Auto-create a packaging_materials record when Zoho classifies
    // this item as packaging and no Luma material is linked yet.
    let materialItemId: string | null = existing[0]?.materialItemId ?? null;
    if (resolvedMappingType === "PACKAGING_MATERIAL" && materialItemId === null) {
      const sku = item.sku ?? item.zohoItemId;
      // Check if a material with this SKU or zohoItemId already exists.
      const [existingMat] = await db
        .select({ id: packagingMaterials.id })
        .from(packagingMaterials)
        .where(sql`${packagingMaterials.sku} = ${sku} OR ${packagingMaterials.zohoItemId} = ${item.zohoItemId}`)
        .limit(1);

      if (existingMat) {
        materialItemId = existingMat.id;
        // Link the existing material back to the mapping.
        await db
          .update(packagingMaterials)
          .set({ zohoItemId: item.zohoItemId })
          .where(eq(packagingMaterials.id, existingMat.id));
      } else {
        const [newMat] = await db
          .insert(packagingMaterials)
          .values({
            sku,
            name: item.name,
            kind: derivePackagingKind(item),
            uom: deriveUom(item),
            zohoItemId: item.zohoItemId,
            isActive: item.active,
          })
          .returning({ id: packagingMaterials.id });
        if (newMat) {
          materialItemId = newMat.id;
          materialsCreated++;
        }
      }
    }

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
        ...(materialItemId ? { materialItemId } : {}),
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
          ...(materialItemId ? { materialItemId } : {}),
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
    summary: { scanned, created, updated, materialsCreated },
    error: null,
  });

  revalidatePath("/settings/integrations/zoho-items");
  revalidatePath("/products");

  return { ok: true, scanned, created, updated, materialsCreated };
}
