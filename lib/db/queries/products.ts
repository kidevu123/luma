import { eq, asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { products, productAllowedTablets, tabletTypes } from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import { compact } from "@/lib/db/compact";
import type { CurrentUser } from "@/lib/auth";

export async function listProducts() {
  const rows = await db
    .select({
      product: products,
      allowedCount: db.$count(
        productAllowedTablets,
        eq(productAllowedTablets.productId, products.id),
      ),
    })
    .from(products)
    .orderBy(asc(products.name));
  return rows.map((r) => ({ ...r.product, allowedCount: r.allowedCount }));
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
