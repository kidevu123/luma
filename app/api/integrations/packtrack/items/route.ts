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

  // Normalised — null/blank ↔ "no value". Lets us treat "" and null the
  // same, which Drizzle and Postgres do not.
  const incomingZohoId =
    typeof zoho_item_id === "string" && zoho_item_id.trim() !== ""
      ? zoho_item_id.trim()
      : null;

  type Outcome =
    | "REGISTERED" // first time we saw this material_code
    | "UPDATED" // existed but we filled in a missing zoho_item_id
    | "ALREADY_MAPPED" // no changes needed
    | "ZOHO_ID_CONFLICT_REVIEW_REQUIRED"; // incoming vs existing differ — operator review

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

      // 2. Look up the existing mapping (if any). We no longer short-
      //    circuit here — we still need to inspect the linked
      //    packaging_materials row so we can backfill a missing
      //    zoho_item_id without leaving stale state in Luma.
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

      // 3. Find or create the packaging_material row (sku is our stable key).
      let materialId: string;
      let existingZohoId: string | null = null;
      let createdMaterial = false;

      const [existingMat] = await tx
        .select({ id: packagingMaterials.id, zohoItemId: packagingMaterials.zohoItemId })
        .from(packagingMaterials)
        .where(eq(packagingMaterials.sku, material_code));

      if (existingMat) {
        materialId = existingMat.id;
        existingZohoId =
          typeof existingMat.zohoItemId === "string" &&
          existingMat.zohoItemId.trim() !== ""
            ? existingMat.zohoItemId.trim()
            : null;
      } else {
        const [inserted] = await tx
          .insert(packagingMaterials)
          .values({
            sku: material_code,
            name: material_name,
            kind,
            category: "PACKAGING",
            uom: unit_of_measure,
            ...(incomingZohoId != null ? { zohoItemId: incomingZohoId } : {}),
          })
          .returning({ id: packagingMaterials.id });
        if (!inserted) {
          throw new Error(
            `packaging_materials insert returned no id for sku=${material_code}.`,
          );
        }
        materialId = inserted.id;
        existingZohoId = incomingZohoId;
        createdMaterial = true;
      }

      // 4. zoho_item_id reconciliation on an existing packaging_material.
      //    Rules (PT identity is owned by material_code, NOT zoho_item_id):
      //      • incoming null  → leave existing alone, no-op
      //      • existing null  → backfill from incoming
      //      • equal          → no-op
      //      • different      → CONFLICT, never silently overwrite
      let zohoOutcome:
        | "UPDATED"
        | "ALREADY_SET"
        | "CONFLICT"
        | "NO_INCOMING"
        | "JUST_CREATED" = "NO_INCOMING";
      if (createdMaterial) {
        zohoOutcome = incomingZohoId != null ? "JUST_CREATED" : "NO_INCOMING";
      } else if (incomingZohoId == null) {
        zohoOutcome = "NO_INCOMING";
      } else if (existingZohoId == null) {
        await tx
          .update(packagingMaterials)
          .set({ zohoItemId: incomingZohoId })
          .where(eq(packagingMaterials.id, materialId));
        zohoOutcome = "UPDATED";
      } else if (existingZohoId === incomingZohoId) {
        zohoOutcome = "ALREADY_SET";
      } else {
        zohoOutcome = "CONFLICT";
      }

      // 5. Mapping side — either nothing exists, or an incomplete
      //    mapping was left behind by an older bug. Both are upserted
      //    in the same transaction.
      let createdMapping = false;
      if (!existingMapping) {
        await tx.insert(externalItemMappings).values({
          externalSystemId: system.id,
          externalItemId: material_code,
          externalItemName: material_name,
          materialItemId: materialId,
          mappingType: "PACKAGING_MATERIAL",
          isActive: true,
        });
        createdMapping = true;
      } else if (!existingMapping.materialItemId) {
        await tx
          .update(externalItemMappings)
          .set({
            materialItemId: materialId,
            externalItemName: material_name,
            isActive: true,
            updatedAt: new Date(),
          })
          .where(eq(externalItemMappings.id, existingMapping.id));
      }

      const outcome: Outcome =
        zohoOutcome === "CONFLICT"
          ? "ZOHO_ID_CONFLICT_REVIEW_REQUIRED"
          : createdMaterial || createdMapping
            ? "REGISTERED"
            : zohoOutcome === "UPDATED"
              ? "UPDATED"
              : "ALREADY_MAPPED";

      return {
        outcome,
        materialId,
        existingZohoId,
        incomingZohoId,
      };
    });

    const {
      outcome,
      materialId,
      existingZohoId: existingZohoIdAfter,
      incomingZohoId: incomingZohoIdEcho,
    } = result;

    console.log(
      "[packtrack.items]",
      JSON.stringify({
        outcome,
        material_code,
        luma_material_id: materialId,
        existing_zoho_item_id: existingZohoIdAfter,
        incoming_zoho_item_id: incomingZohoIdEcho,
      }),
    );

    if (outcome === "ZOHO_ID_CONFLICT_REVIEW_REQUIRED") {
      return NextResponse.json(
        {
          ok: false,
          outcome,
          error: "ZOHO_ID_CONFLICT_REVIEW_REQUIRED",
          material_code,
          luma_material_id: materialId,
          existing_zoho_item_id: existingZohoIdAfter,
          incoming_zoho_item_id: incomingZohoIdEcho,
        },
        { status: 409 },
      );
    }

    return NextResponse.json(
      {
        ok: true,
        outcome,
        // Backwards-compat: PackTrack today reads ``created`` to decide
        // whether to log "registered" vs "already mapped".
        created: outcome === "REGISTERED",
        material_code,
        luma_material_id: materialId,
      },
      { status: outcome === "REGISTERED" ? 201 : 200 },
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
