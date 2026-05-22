// PT-items: PackTrack -> Luma material pre-registration.
//
// PackTrack is the authority on material_code assignment. Before
// it can push receipts for a code that Luma has never seen, it must
// register the item here so Luma can create:
//   1. A packaging_materials row  (sku = material_code)
//   2. An external_item_mappings row  (materialItemId -> that row)
//
// Without these, the receipts webhook returns HTTP 422 MAPPING_MISSING.
//
// Auth: same x-packtrack-secret header as the receipts webhook.
// Idempotent: calling this multiple times for the same material_code
//   is safe — returns 200 when already registered, 201 on first creation.

import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  packagingMaterials,
  externalSystems,
  externalItemMappings,
} from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Mirrors packagingMaterialKindEnum in schema.ts.
const VALID_KINDS = [
  "BLISTER_CARD",
  "BLISTER_FOIL",
  "HEAT_SEAL_FILM",
  "BOTTLE",
  "CAP",
  "INDUCTION_SEAL",
  "LABEL",
  "DESICCANT",
  "COTTON",
  "DISPLAY",
  "CASE",
  "INSERT",
  "OTHER",
] as const;

const registerItemSchema = z.object({
  /** The material_code assigned by PackTrack (e.g. "PT-00095"). */
  material_code: z.string().min(1).max(120),
  /** Human-readable item name (snapshotted as packaging_materials.name). */
  material_name: z.string().min(1).max(240),
  /** Luma packaging_material kind — PackTrack infers from item name. */
  kind: z.enum(VALID_KINDS).default("OTHER"),
  /** Unit of measure — stored lowercase in Luma (e.g. "each", "box"). */
  unit_of_measure: z
    .string()
    .min(1)
    .max(40)
    .default("each")
    .transform((v) => v.toLowerCase()),
  /** Zoho item id — stored in zoho_item_id for future cross-reference. */
  zoho_item_id: z.string().max(80).optional().nullable(),
});

function unauthorized(reason: string) {
  return NextResponse.json({ ok: false, error: reason }, { status: 401 });
}

export async function POST(req: Request) {
  // ── Auth ──────────────────────────────────────────────────────────
  const expected = process.env.PACKTRACK_INTEGRATION_SECRET;
  if (!expected) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "PACKTRACK_INTEGRATION_SECRET is not configured on Luma. Supervisor must set it.",
      },
      { status: 503 },
    );
  }
  const got = req.headers.get("x-packtrack-secret");
  if (!got || got !== expected) {
    return unauthorized("Missing or invalid x-packtrack-secret.");
  }

  // ── Parse body ────────────────────────────────────────────────────
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Body must be JSON." },
      { status: 400 },
    );
  }

  const parsed = registerItemSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Invalid payload.",
      },
      { status: 400 },
    );
  }

  const { material_code, material_name, kind, unit_of_measure, zoho_item_id } =
    parsed.data;

  // ── Upsert in a single transaction ───────────────────────────────
  try {
    const result = await db.transaction(async (tx) => {
      // 1. Resolve the PACKTRACK external_systems row.
      const [system] = await tx
        .select({ id: externalSystems.id })
        .from(externalSystems)
        .where(eq(externalSystems.code, "PACKTRACK"));
      if (!system) {
        throw new Error(
          "PACKTRACK external_systems row missing — run scripts/register-packtrack.ts first.",
        );
      }

      // 2. Already fully mapped? Return early (idempotent).
      const [existingMapping] = await tx
        .select({
          id: externalItemMappings.id,
          materialItemId: externalItemMappings.materialItemId,
        })
        .from(externalItemMappings)
        .where(
          and(
            eq(externalItemMappings.externalSystemId, system.id),
            eq(externalItemMappings.externalItemId, material_code),
            eq(externalItemMappings.isActive, true),
          ),
        );
      if (existingMapping?.materialItemId) {
        return {
          created: false,
          materialId: existingMapping.materialItemId,
        };
      }

      // 3. Find or create packaging_material (sku is our stable key).
      let materialId: string;
      const [existingMat] = await tx
        .select({ id: packagingMaterials.id })
        .from(packagingMaterials)
        .where(eq(packagingMaterials.sku, material_code));

      if (existingMat) {
        materialId = existingMat.id;
      } else {
        const [inserted] = await tx
          .insert(packagingMaterials)
          .values({
            sku: material_code,
            name: material_name,
            kind,
            category: "PACKAGING",
            uom: unit_of_measure,
            ...(zoho_item_id != null ? { zohoItemId: zoho_item_id } : {}),
          })
          .returning({ id: packagingMaterials.id });
        if (!inserted) {
          throw new Error(
            `packaging_materials insert returned no id for sku=${material_code}.`,
          );
        }
        materialId = inserted.id;
      }

      // 4. Create the external_item_mapping.
      //    If an incomplete (materialItemId=null) mapping already exists,
      //    patch it rather than inserting a duplicate.
      if (existingMapping && !existingMapping.materialItemId) {
        await tx
          .update(externalItemMappings)
          .set({
            materialItemId: materialId,
            externalItemName: material_name,
            isActive: true,
            updatedAt: new Date(),
          })
          .where(eq(externalItemMappings.id, existingMapping.id));
      } else {
        await tx.insert(externalItemMappings).values({
          externalSystemId: system.id,
          externalItemId: material_code,
          externalItemName: material_name,
          materialItemId: materialId,
          mappingType: "PACKAGING_MATERIAL",
          isActive: true,
        });
      }

      return { created: true, materialId };
    });

    console.log(
      "[packtrack.items]",
      JSON.stringify({
        outcome: result.created ? "REGISTERED" : "ALREADY_MAPPED",
        material_code,
        luma_material_id: result.materialId,
      }),
    );

    return NextResponse.json(
      {
        ok: true,
        material_code,
        created: result.created,
        luma_material_id: result.materialId,
      },
      { status: result.created ? 201 : 200 },
    );
  } catch (err) {
    console.error("[packtrack.items] failed:", err);
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Registration failed.",
      },
      { status: 500 },
    );
  }
}

export function GET() {
  return NextResponse.json({ ok: false, error: "POST only." }, { status: 405 });
}
