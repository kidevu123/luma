import { eq, asc, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { packagingMaterials } from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import { compact } from "@/lib/db/compact";
import type { CurrentUser } from "@/lib/auth";

export async function listPackagingMaterials() {
  return db
    .select()
    .from(packagingMaterials)
    .orderBy(asc(packagingMaterials.name));
}

export type PackagingMaterialInput = {
  sku: string;
  name: string;
  kind:
    | "BLISTER_FOIL"
    | "HEAT_SEAL_FILM"
    | "BOTTLE"
    | "CAP"
    | "INDUCTION_SEAL"
    | "LABEL"
    | "DESICCANT"
    | "COTTON"
    | "DISPLAY"
    | "CASE"
    | "INSERT"
    | "OTHER";
  uom: string;
  parLevel?: number | null | undefined;
  zohoItemId?: string | null | undefined;
  isActive?: boolean | undefined;
};

export async function createPackagingMaterial(input: PackagingMaterialInput, actor: CurrentUser) {
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(packagingMaterials).values(compact(input)).returning();
    if (!row) throw new Error("createPackagingMaterial: insert empty");
    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: "packaging_material.create",
        targetType: "PackagingMaterial",
        targetId: row.id,
        after: row,
      },
      tx,
    );
    return row;
  });
}

export async function updatePackagingMaterial(
  id: string,
  patch: Partial<PackagingMaterialInput>,
  actor: CurrentUser,
) {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(packagingMaterials)
      .where(eq(packagingMaterials.id, id));
    if (!before) throw new Error("updatePackagingMaterial: not found");
    const [row] = await tx
      .update(packagingMaterials)
      .set(compact(patch))
      .where(eq(packagingMaterials.id, id))
      .returning();
    if (!row) throw new Error("updatePackagingMaterial: update empty");
    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: "packaging_material.update",
        targetType: "PackagingMaterial",
        targetId: id,
        before,
        after: row,
      },
      tx,
    );
    return row;
  });
}
