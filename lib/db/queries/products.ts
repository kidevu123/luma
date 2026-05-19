import { eq, and, asc } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  products,
  productAllowedTablets,
  productPackagingSpecs,
  packagingMaterials,
  tabletTypes,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import { compact } from "@/lib/db/compact";
import type { CurrentUser } from "@/lib/auth";

export async function listProducts() {
  const [rows, allAllowed] = await Promise.all([
    db
      .select({
        product: products,
        allowedCount: db.$count(
          productAllowedTablets,
          eq(productAllowedTablets.productId, products.id),
        ),
      })
      .from(products)
      .orderBy(asc(products.name)),
    db
      .select({
        productId: productAllowedTablets.productId,
        tabletTypeId: productAllowedTablets.tabletTypeId,
      })
      .from(productAllowedTablets),
  ]);
  const allowedByProduct = new Map<string, string[]>();
  for (const a of allAllowed) {
    const arr = allowedByProduct.get(a.productId) ?? [];
    arr.push(a.tabletTypeId);
    allowedByProduct.set(a.productId, arr);
  }
  return rows.map((r) => ({
    ...r.product,
    allowedCount: r.allowedCount,
    allowedTabletIds: allowedByProduct.get(r.product.id) ?? [],
  }));
}

export async function getProductWithAllowed(id: string) {
  const [product] = await db.select().from(products).where(eq(products.id, id));
  if (!product) return null;
  const allowed = await db
    .select({
      productId: productAllowedTablets.productId,
      tabletTypeId: productAllowedTablets.tabletTypeId,
      isPrimary: productAllowedTablets.isPrimary,
      tabletName: tabletTypes.name,
    })
    .from(productAllowedTablets)
    .innerJoin(tabletTypes, eq(productAllowedTablets.tabletTypeId, tabletTypes.id))
    .where(eq(productAllowedTablets.productId, id));
  return { ...product, allowed };
}

export type ProductInput = {
  sku: string;
  name: string;
  kind: "CARD" | "BOTTLE" | "VARIETY";
  tabletsPerUnit?: number | null | undefined;
  unitsPerDisplay?: number | null | undefined;
  displaysPerCase?: number | null | undefined;
  defaultShelfLifeDays?: number | null | undefined;
  zohoItemId?: string | null | undefined;
  /** ZOHO-ASSY-1 — composite-item IDs for each packaging level. */
  zohoItemIdUnit?: string | null | undefined;
  zohoItemIdDisplay?: string | null | undefined;
  zohoItemIdCase?: string | null | undefined;
  isActive?: boolean | undefined;
};

export async function createProduct(input: ProductInput, actor: CurrentUser) {
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(products).values(compact(input)).returning();
    if (!row) throw new Error("createProduct: insert empty");
    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: "product.create",
        targetType: "Product",
        targetId: row.id,
        after: row,
      },
      tx,
    );
    return row;
  });
}

export async function updateProduct(
  id: string,
  patch: Partial<ProductInput>,
  actor: CurrentUser,
) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(products).where(eq(products.id, id));
    if (!before) throw new Error("updateProduct: not found");
    const [row] = await tx
      .update(products)
      .set(compact(patch))
      .where(eq(products.id, id))
      .returning();
    if (!row) throw new Error("updateProduct: update empty");
    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: "product.update",
        targetType: "Product",
        targetId: id,
        before,
        after: row,
      },
      tx,
    );
    return row;
  });
}

/** Get a product with both allowed-tablets and packaging-spec rows so
 *  the BOM editor can render in one fetch. */
export async function getProductWithBom(id: string) {
  const [product] = await db.select().from(products).where(eq(products.id, id));
  if (!product) return null;
  const [allowed, specs] = await Promise.all([
    db
      .select({
        tabletTypeId: productAllowedTablets.tabletTypeId,
        isPrimary: productAllowedTablets.isPrimary,
        tabletName: tabletTypes.name,
      })
      .from(productAllowedTablets)
      .innerJoin(tabletTypes, eq(productAllowedTablets.tabletTypeId, tabletTypes.id))
      .where(eq(productAllowedTablets.productId, id))
      .orderBy(asc(tabletTypes.name)),
    db
      .select({
        packagingMaterialId: productPackagingSpecs.packagingMaterialId,
        qtyPerUnit: productPackagingSpecs.qtyPerUnit,
        perScope: productPackagingSpecs.perScope,
        notes: productPackagingSpecs.notes,
        materialSku: packagingMaterials.sku,
        materialName: packagingMaterials.name,
        materialKind: packagingMaterials.kind,
        materialUom: packagingMaterials.uom,
      })
      .from(productPackagingSpecs)
      .innerJoin(
        packagingMaterials,
        eq(productPackagingSpecs.packagingMaterialId, packagingMaterials.id),
      )
      .where(eq(productPackagingSpecs.productId, id))
      .orderBy(asc(packagingMaterials.name)),
  ]);
  return { ...product, allowed, specs };
}

export async function setAllowedTablets(
  productId: string,
  tabletTypeIds: string[],
  actor: CurrentUser,
) {
  return db.transaction(async (tx) => {
    await tx
      .delete(productAllowedTablets)
      .where(eq(productAllowedTablets.productId, productId));
    if (tabletTypeIds.length > 0) {
      await tx.insert(productAllowedTablets).values(
        tabletTypeIds.map((tabletTypeId) => ({ productId, tabletTypeId, isPrimary: false })),
      );
    }
    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: "product.allowed.set",
        targetType: "Product",
        targetId: productId,
        after: { tabletTypeIds },
      },
      tx,
    );
  });
}

export async function setAllowedTablet(
  args: { productId: string; tabletTypeId: string; enabled: boolean; isPrimary?: boolean },
  actor: CurrentUser,
) {
  return db.transaction(async (tx) => {
    if (args.enabled) {
      // If marking primary, demote any existing primary first.
      if (args.isPrimary) {
        await tx
          .update(productAllowedTablets)
          .set({ isPrimary: false })
          .where(eq(productAllowedTablets.productId, args.productId));
      }
      await tx
        .insert(productAllowedTablets)
        .values({
          productId: args.productId,
          tabletTypeId: args.tabletTypeId,
          isPrimary: args.isPrimary ?? false,
        })
        .onConflictDoUpdate({
          target: [productAllowedTablets.productId, productAllowedTablets.tabletTypeId],
          set: { isPrimary: args.isPrimary ?? false },
        });
    } else {
      await tx
        .delete(productAllowedTablets)
        .where(
          and(
            eq(productAllowedTablets.productId, args.productId),
            eq(productAllowedTablets.tabletTypeId, args.tabletTypeId),
          ),
        );
    }
    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: args.enabled ? "product.allowed.add" : "product.allowed.remove",
        targetType: "Product",
        targetId: args.productId,
        after: { tabletTypeId: args.tabletTypeId, isPrimary: !!args.isPrimary },
      },
      tx,
    );
  });
}

export type PackagingSpecInput = {
  productId: string;
  packagingMaterialId: string;
  qtyPerUnit: number;
  perScope: "UNIT" | "DISPLAY" | "CASE";
  notes?: string | null;
};

export async function upsertPackagingSpec(input: PackagingSpecInput, actor: CurrentUser) {
  return db.transaction(async (tx) => {
    await tx
      .insert(productPackagingSpecs)
      .values(compact(input))
      .onConflictDoUpdate({
        target: [
          productPackagingSpecs.productId,
          productPackagingSpecs.packagingMaterialId,
          productPackagingSpecs.perScope,
        ],
        set: {
          qtyPerUnit: input.qtyPerUnit,
          notes: input.notes ?? null,
        },
      });
    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: "product.spec.upsert",
        targetType: "Product",
        targetId: input.productId,
        after: input,
      },
      tx,
    );
  });
}

export async function deleteProduct(id: string, actor: CurrentUser) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(products).where(eq(products.id, id));
    if (!before) throw new Error("Product not found.");
    await tx.delete(products).where(eq(products.id, id));
    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: "product.delete",
        targetType: "Product",
        targetId: id,
        before,
      },
      tx,
    );
  });
}

export async function deletePackagingSpec(
  args: { productId: string; packagingMaterialId: string; perScope: string },
  actor: CurrentUser,
) {
  return db.transaction(async (tx) => {
    await tx
      .delete(productPackagingSpecs)
      .where(
        and(
          eq(productPackagingSpecs.productId, args.productId),
          eq(productPackagingSpecs.packagingMaterialId, args.packagingMaterialId),
          eq(productPackagingSpecs.perScope, args.perScope),
        ),
      );
    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: "product.spec.remove",
        targetType: "Product",
        targetId: args.productId,
        after: args,
      },
      tx,
    );
  });
}
