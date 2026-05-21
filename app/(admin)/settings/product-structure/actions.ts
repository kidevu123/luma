"use server";

// Phase H.x0.5 — Product structure server actions.
//
// Validates and persists item_conversions rows. Generic — no
// product-kind branches. Refuses zero/negative quantities, missing
// items, and duplicate active rows for the same (product, parent,
// child) tuple.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq, and, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { itemConversions } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { compact } from "@/lib/db/compact";

const PACK_LEVELS = [
  "RAW",
  "COMPONENT",
  "INTERMEDIATE",
  "UNIT",
  "INNER_PACK",
  "DISPLAY",
  "CASE",
  "PALLET",
  "FINISHED_GOOD",
  "SELLABLE",
] as const;

const conversionSchema = z
  .object({
    productId: z.string().uuid(),
    parentItemId: z.string().uuid(),
    childItemId: z.string().uuid(),
    parentQty: z.coerce.number().positive(),
    parentUom: z.string().min(1).max(40),
    parentPackLevel: z.enum(PACK_LEVELS),
    childQty: z.coerce.number().positive(),
    childUom: z.string().min(1).max(40),
    childPackLevel: z.enum(PACK_LEVELS),
    routeId: z.string().uuid().optional().nullable().or(z.literal("")),
    effectiveFrom: z.string().date(),
  })
  .refine((d) => d.parentItemId !== d.childItemId, {
    message: "Parent and child must be different items.",
    path: ["childItemId"],
  });

export async function saveItemConversionAction(formData: FormData) {
  await requireAdmin();
  const parsed = conversionSchema.safeParse({
    productId: formData.get("productId"),
    parentItemId: formData.get("parentItemId"),
    childItemId: formData.get("childItemId"),
    parentQty: formData.get("parentQty"),
    parentUom: formData.get("parentUom"),
    parentPackLevel: formData.get("parentPackLevel"),
    childQty: formData.get("childQty"),
    childUom: formData.get("childUom"),
    childPackLevel: formData.get("childPackLevel"),
    routeId: formData.get("routeId"),
    effectiveFrom: formData.get("effectiveFrom"),
  });
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => i.message).join("; "));
  }
  const d = parsed.data;
  const routeId = d.routeId && d.routeId !== "" ? d.routeId : null;

  // Refuse to insert a duplicate ACTIVE conversion row for the same
  // (product, route, parent, child) tuple. Mirrors the partial unique
  // index defined in the migration.
  const existing = await db
    .select({ id: itemConversions.id })
    .from(itemConversions)
    .where(
      and(
        eq(itemConversions.productId, d.productId),
        eq(itemConversions.parentItemId, d.parentItemId),
        eq(itemConversions.childItemId, d.childItemId),
        eq(itemConversions.isActive, true),
        isNull(itemConversions.effectiveTo),
        routeId ? eq(itemConversions.routeId, routeId) : isNull(itemConversions.routeId),
      ),
    )
    .limit(1);
  if (existing[0]) {
    throw new Error("An active conversion for this parent → child already exists. Deactivate it first.");
  }

  await db.insert(itemConversions).values(
    compact({
      productId: d.productId,
      routeId,
      parentItemId: d.parentItemId,
      childItemId: d.childItemId,
      parentQuantity: String(d.parentQty),
      parentUnitOfMeasure: d.parentUom,
      parentPackLevel: d.parentPackLevel,
      childQuantity: String(d.childQty),
      childUnitOfMeasure: d.childUom,
      childPackLevel: d.childPackLevel,
      effectiveFrom: d.effectiveFrom,
      isActive: true,
    }),
  );

  revalidatePath(`/settings/product-structure?productId=${d.productId}`);
}

export async function deactivateItemConversionAction(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const productId = String(formData.get("productId") ?? "");
  if (!id) throw new Error("Conversion id is required.");
  await db.execute(sql`
    UPDATE item_conversions
       SET is_active = false,
           effective_to = COALESCE(effective_to, CURRENT_DATE),
           updated_at = now()
     WHERE id = ${id}
  `);
  revalidatePath(`/settings/product-structure?productId=${productId}`);
}
