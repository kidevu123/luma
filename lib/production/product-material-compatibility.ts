// PBOM-2 — product ↔ packaging-material compatibility helpers.
//
// PBOM-1 filters dropdowns by KIND (PVC roll can never be a master
// case). PBOM-2 narrows further by PRODUCT (Mango Peach can never use
// Blue Raz's printed card). Together they form the gate the BOM page
// + savePackagingBomLineAction enforce.
//
// The helpers below take a Db/Tx handle so server-side validation in
// admin actions can reuse them. The functions return well-shaped
// results that make the "Compatibility missing" / "Not approved"
// distinctions explicit — never a silent fall-through.

import { and, eq, sql } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import {
  packagingMaterials,
  productMaterialCompatibility,
} from "@/lib/db/schema";
import {
  isKindAllowedAtScope,
  isMachineConsumableKind,
  type PackagingBomScope,
  type PackagingMaterialKind,
} from "./packaging-bom-kinds";

type DbLike = typeof Db | Parameters<Parameters<typeof Db.transaction>[0]>[0];

/** Compatibility roles the matrix tracks. CARD_MATERIAL covers
 *  printed cards. BOTTLE/CAP/LABEL/INDUCTION_SEAL are bottle-route
 *  per-unit roles. DISPLAY_BOX and MASTER_CASE are scope-anchored.
 *  INSERT/SHRINK_BAND/OTHER catch the rest. */
export const COMPATIBILITY_ROLES = [
  "CARD_MATERIAL",
  "DISPLAY_BOX",
  "MASTER_CASE",
  "BOTTLE",
  "CAP",
  "LABEL",
  "INDUCTION_SEAL",
  "INSERT",
  "SHRINK_BAND",
  "OTHER",
] as const;

export type CompatibilityRole = (typeof COMPATIBILITY_ROLES)[number];

export type CompatibleMaterialRow = {
  materialId: string;
  materialSku: string;
  materialName: string;
  materialKind: PackagingMaterialKind;
  uom: string;
  compatibilityRole: CompatibilityRole;
  required: boolean;
  defaultForProduct: boolean;
  /** True when the source compatibility row matches the supplied
   *  routeId exactly. False when it's a route-agnostic row (route_id
   *  IS NULL) — still compatible, but lower-priority for defaults. */
  routeMatched: boolean;
};

/** Load every ACTIVE compatibility row for (product, scope) and
 *  resolve the material join. Route filter is permissive: rows with
 *  the matching routeId AND rows with route_id IS NULL both qualify
 *  (a route-agnostic row is "applies to any route"). Rows are
 *  ordered with route-matched + default rows first so the UI can
 *  pre-select sensibly. */
export async function getCompatibleMaterialsForProduct(
  db: DbLike,
  productId: string,
  routeId: string | null,
  scope: PackagingBomScope,
): Promise<CompatibleMaterialRow[]> {
  const rows = (await db.execute(sql`
    SELECT
      pmc.material_id         AS "materialId",
      pm.sku                  AS "materialSku",
      pm.name                 AS "materialName",
      pm.kind::text           AS "materialKind",
      pm.uom                  AS "uom",
      pmc.compatibility_role  AS "compatibilityRole",
      pmc.required            AS "required",
      pmc.default_for_product AS "defaultForProduct",
      (pmc.route_id IS NOT DISTINCT FROM ${routeId}) AS "routeMatched"
    FROM product_material_compatibility pmc
    INNER JOIN packaging_materials pm ON pm.id = pmc.material_id
    WHERE pmc.product_id = ${productId}
      AND pmc.scope = ${scope}
      AND pmc.active = true
      AND pm.is_active = true
      AND (pmc.route_id = ${routeId} OR pmc.route_id IS NULL)
      AND (pmc.effective_to IS NULL OR pmc.effective_to > now())
    ORDER BY
      (pmc.route_id IS NOT DISTINCT FROM ${routeId}) DESC,
      pmc.default_for_product DESC,
      pm.name ASC
  `)) as unknown as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    materialId: String(r.materialId),
    materialSku: String(r.materialSku),
    materialName: String(r.materialName),
    materialKind: String(r.materialKind) as PackagingMaterialKind,
    uom: String(r.uom),
    compatibilityRole: String(r.compatibilityRole) as CompatibilityRole,
    required: Boolean(r.required),
    defaultForProduct: Boolean(r.defaultForProduct),
    routeMatched: Boolean(r.routeMatched),
  }));
}

export type CompatibilityCheck =
  | { ok: true; row: CompatibleMaterialRow }
  | { ok: false; reason: string; code: CompatibilityRejectionCode };

export type CompatibilityRejectionCode =
  | "KIND_NOT_ALLOWED_AT_SCOPE"
  | "MACHINE_CONSUMABLE"
  | "MATERIAL_NOT_FOUND"
  | "MATERIAL_INACTIVE"
  | "COMPATIBILITY_MISSING"
  | "NOT_COMPATIBLE_WITH_PRODUCT";

/** Single-material predicate. Used by the UI to gray out a
 *  manually-typed material id and by the server action as the final
 *  guard before persisting a BOM line. */
export async function isMaterialCompatibleWithProduct(
  db: DbLike,
  productId: string,
  routeId: string | null,
  materialId: string,
  scope: PackagingBomScope,
): Promise<CompatibilityCheck> {
  const matRows = (await db
    .select({
      id: packagingMaterials.id,
      kind: packagingMaterials.kind,
      isActive: packagingMaterials.isActive,
      sku: packagingMaterials.sku,
      name: packagingMaterials.name,
      uom: packagingMaterials.uom,
    })
    .from(packagingMaterials)
    .where(eq(packagingMaterials.id, materialId))) as Array<{
    id: string;
    kind: PackagingMaterialKind;
    isActive: boolean;
    sku: string;
    name: string;
    uom: string;
  }>;
  const mat = matRows[0];
  if (!mat) {
    return {
      ok: false,
      reason: "Packaging material not found.",
      code: "MATERIAL_NOT_FOUND",
    };
  }
  if (!mat.isActive) {
    return {
      ok: false,
      reason: `${mat.sku} is inactive.`,
      code: "MATERIAL_INACTIVE",
    };
  }
  if (isMachineConsumableKind(mat.kind)) {
    return {
      ok: false,
      reason: `${mat.kind} is a blister-machine consumable — configure it under blister material standards, not Packaging BOM or compatibility.`,
      code: "MACHINE_CONSUMABLE",
    };
  }
  if (!isKindAllowedAtScope(mat.kind, scope)) {
    return {
      ok: false,
      reason: `${mat.kind} is not a valid material kind at scope ${scope}.`,
      code: "KIND_NOT_ALLOWED_AT_SCOPE",
    };
  }

  const matchRows = (await db.execute(sql`
    SELECT
      pmc.compatibility_role  AS "compatibilityRole",
      pmc.required            AS "required",
      pmc.default_for_product AS "defaultForProduct",
      (pmc.route_id IS NOT DISTINCT FROM ${routeId}) AS "routeMatched"
    FROM product_material_compatibility pmc
    WHERE pmc.product_id = ${productId}
      AND pmc.material_id = ${materialId}
      AND pmc.scope = ${scope}
      AND pmc.active = true
      AND (pmc.route_id = ${routeId} OR pmc.route_id IS NULL)
      AND (pmc.effective_to IS NULL OR pmc.effective_to > now())
    LIMIT 1
  `)) as unknown as Array<Record<string, unknown>>;
  const row = matchRows[0];
  if (!row) {
    // Distinguish "no rows at all for this scope" (missing config)
    // from "rows exist but this material isn't approved" (rejection).
    const anyRows = (await db.execute(sql`
      SELECT 1
      FROM product_material_compatibility
      WHERE product_id = ${productId}
        AND scope = ${scope}
        AND active = true
      LIMIT 1
    `)) as unknown as Array<unknown>;
    if (anyRows.length === 0) {
      return {
        ok: false,
        reason: `Product material compatibility missing for ${scope} scope.`,
        code: "COMPATIBILITY_MISSING",
      };
    }
    return {
      ok: false,
      reason: `${mat.sku} (${mat.name}) is not approved for this product at ${scope} scope.`,
      code: "NOT_COMPATIBLE_WITH_PRODUCT",
    };
  }
  return {
    ok: true,
    row: {
      materialId: mat.id,
      materialSku: mat.sku,
      materialName: mat.name,
      materialKind: mat.kind,
      uom: mat.uom,
      compatibilityRole: String(row.compatibilityRole) as CompatibilityRole,
      required: Boolean(row.required),
      defaultForProduct: Boolean(row.defaultForProduct),
      routeMatched: Boolean(row.routeMatched),
    },
  };
}

/** Action-layer entry point. Identical to isMaterialCompatibleWith
 *  Product but pre-narrows the error to the operator-facing strings
 *  the BOM page renders. */
export async function validateProductBomMaterial(
  db: DbLike,
  args: {
    productId: string;
    routeId: string | null;
    materialId: string;
    scope: PackagingBomScope;
  },
): Promise<CompatibilityCheck> {
  return isMaterialCompatibleWithProduct(
    db,
    args.productId,
    args.routeId,
    args.materialId,
    args.scope,
  );
}

export function explainCompatibilityRejection(
  check: CompatibilityCheck,
): string | null {
  if (check.ok) return null;
  return check.reason;
}

/** Returns true when a candidate compatibility row would be valid to
 *  insert. Used by the admin /settings/product-material-compatibility
 *  page before issuing the INSERT. Refuses machine consumables (PVC /
 *  FOIL / BLISTER_FOIL) outright — those don't belong in compatibility
 *  at all. */
export function canRegisterCompatibility(
  materialKind: PackagingMaterialKind,
  scope: PackagingBomScope,
):
  | { ok: true }
  | { ok: false; reason: string } {
  if (isMachineConsumableKind(materialKind)) {
    return {
      ok: false,
      reason: `${materialKind} is a blister-machine consumable — track usage under blister material standards, not Packaging BOM compatibility.`,
    };
  }
  if (!isKindAllowedAtScope(materialKind, scope)) {
    return {
      ok: false,
      reason: `${materialKind} is not a valid material kind at scope ${scope}.`,
    };
  }
  return { ok: true };
}

/** Map a material kind + scope to the most sensible default role.
 *  The admin page pre-fills the role select with this guess; admin
 *  can override. */
export function suggestRole(
  materialKind: PackagingMaterialKind,
  scope: PackagingBomScope,
): CompatibilityRole {
  if (scope === "DISPLAY" && materialKind === "DISPLAY") return "DISPLAY_BOX";
  if (scope === "CASE" && materialKind === "CASE") return "MASTER_CASE";
  if (materialKind === "BOTTLE") return "BOTTLE";
  if (materialKind === "CAP") return "CAP";
  if (materialKind === "LABEL") return "LABEL";
  if (materialKind === "INDUCTION_SEAL") return "INDUCTION_SEAL";
  if (materialKind === "INSERT") return "INSERT";
  if (materialKind === "SHRINK_BAND") return "SHRINK_BAND";
  if (materialKind === "HEAT_SEAL_FILM") return "OTHER";
  // CARD_MATERIAL doesn't map to a pgEnum kind today — admins pick
  // from products' printed cards (kind=OTHER or kind=INSERT depending
  // on catalog convention). UI offers CARD_MATERIAL explicitly when
  // scope=UNIT and a kind-OTHER material is chosen.
  if (scope === "UNIT") return "OTHER";
  return "OTHER";
}
