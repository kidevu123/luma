"use server";

// PT-7D — admin actions on shortage recommendations.
//
// Two actions, both idempotent and additive:
//   - acknowledgeMaterialRecommendationAction
//       sets acknowledged_at = now() (only if currently null);
//       does not delete; does not call PackTrack; does not create POs.
//
//   - dismissMaterialRecommendationAction
//       sets dismissed_at = now() (only if currently null);
//       optional dismissalReason / dismissalNotes appended to warnings;
//       does not delete; does not call PackTrack.
//
// Strict rules per PT-7D scope:
//   - requireAdmin() — owner or admin only.
//   - Acknowledged / dismissed rows stay visible through status filters.
//   - Active = neither dismissed nor superseded.
//   - No PackTrack call. PT-7E is the outbound integration.
//   - No PO creation.
//   - Audit log written on every transition.

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-guards";
import { readMaterialRecommendations } from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import {
  sendRecommendationToPackTrack,
  validatePackTrackRecommendationConfig,
} from "@/lib/integrations/packtrack/recommendations";
import type { ShortageSignal } from "@/lib/production/packtrack-shortage";

type ActionResult = { ok?: true; error?: string };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const recommendationIdSchema = z
  .string()
  .regex(UUID_RE, "Invalid recommendation id");

const dismissSchema = z.object({
  recommendationId: recommendationIdSchema,
  reason: z
    .string()
    .trim()
    .max(120, "Reason too long")
    .optional()
    .nullable()
    .transform((v) => (v && v.length > 0 ? v : null)),
  notes: z
    .string()
    .trim()
    .max(500, "Notes too long")
    .optional()
    .nullable()
    .transform((v) => (v && v.length > 0 ? v : null)),
});

export async function acknowledgeMaterialRecommendationAction(
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireAdmin();
  const parsed = recommendationIdSchema.safeParse(
    formData.get("recommendationId"),
  );
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const id = parsed.data;

  try {
    await db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(readMaterialRecommendations)
        .where(eq(readMaterialRecommendations.id, id))
        .limit(1);
      if (existing.length === 0) {
        throw new Error("Recommendation not found");
      }
      const row = existing[0]!;
      // Idempotent: if already acknowledged, return ok without writing.
      if (row.acknowledgedAt != null) return;

      const now = new Date();
      await tx
        .update(readMaterialRecommendations)
        .set({ acknowledgedAt: now, updatedAt: now })
        .where(
          and(
            eq(readMaterialRecommendations.id, id),
            isNull(readMaterialRecommendations.acknowledgedAt),
          ),
        );

      await writeAudit(
        {
          actorId: user.id,
          actorRole: user.role,
          action: "material_recommendation.acknowledge",
          targetType: "read_material_recommendations",
          targetId: id,
          before: { acknowledgedAt: row.acknowledgedAt },
          after: { acknowledgedAt: now },
        },
        tx,
      );
    });
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Failed to acknowledge",
    };
  }

  revalidatePath("/material-alerts");
  return { ok: true };
}

export type SendActionResult =
  | { ok: true }
  | { error: string; code?: string };

export async function sendMaterialRecommendationToPackTrackAction(
  formData: FormData,
): Promise<SendActionResult> {
  const user = await requireAdmin();
  const parsed = recommendationIdSchema.safeParse(
    formData.get("recommendationId"),
  );
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const id = parsed.data;

  // Short-circuit on config BEFORE any DB read — UI is supposed to
  // disable the button when unconfigured, but the server enforces.
  const configStatus = validatePackTrackRecommendationConfig();
  if (!configStatus.configured) {
    return {
      error: `PackTrack handoff not configured: missing ${configStatus.missing.join(", ")}.`,
      code: "NOT_CONFIGURED",
    };
  }

  // Load the row outside the transaction (read-only). Network call
  // happens before we open the write tx so a slow PackTrack doesn't
  // hold a DB lock.
  const rows = await db
    .select()
    .from(readMaterialRecommendations)
    .where(eq(readMaterialRecommendations.id, id))
    .limit(1);
  if (rows.length === 0) {
    return { error: "Recommendation not found" };
  }
  const row = rows[0]!;

  // Gates — every one of these is also enforced client-side via
  // disabled-button reasons, but the server is the final word.
  if (row.acknowledgedAt == null) {
    return { error: "Not acknowledged.", code: "NOT_ACKNOWLEDGED" };
  }
  if (row.dismissedAt != null) {
    return { error: "Dismissed recommendations cannot be sent.", code: "DISMISSED" };
  }
  if (!row.sendableToPackTrack) {
    return { error: "Not sendable.", code: "NOT_SENDABLE" };
  }
  if (row.confidence === "MISSING") {
    return {
      error: "MISSING confidence rows must not be sent.",
      code: "BLOCKED_BY_CONFIDENCE",
    };
  }
  const recQty =
    row.recommendedOrderQuantity != null
      ? Number(row.recommendedOrderQuantity)
      : 0;
  if (!Number.isFinite(recQty) || recQty <= 0) {
    return {
      error: "recommended_order_quantity must be > 0.",
      code: "BLOCKED_BY_QUANTITY",
    };
  }

  // Call the outbound client. No DB writes happen in this branch
  // before we hear back from PackTrack.
  const sendResult = await sendRecommendationToPackTrack(
    {
      recommendationId: row.recommendationId,
      materialCode: row.materialCode || null,
      materialName: row.materialName,
      productSku: row.productSku,
      productName: row.productName,
      compatibilityRole: row.compatibilityRole,
      currentOnHand:
        row.currentOnHand != null ? Number(row.currentOnHand) : null,
      acceptedInventory:
        row.acceptedInventory != null ? Number(row.acceptedInventory) : null,
      projectedDemand:
        row.projectedDemand != null ? Number(row.projectedDemand) : null,
      projectedShortageQuantity:
        row.projectedShortageQuantity != null
          ? Number(row.projectedShortageQuantity)
          : null,
      recommendedOrderQuantity: recQty,
      neededByDate: row.neededByDate,
      confidence: row.confidence as
        | "HIGH"
        | "MEDIUM"
        | "LOW"
        | "MISSING",
      severity: row.severity as
        | "CRITICAL"
        | "HIGH"
        | "MEDIUM"
        | "WATCH",
      reason: row.reason,
      sourceSignals:
        (row.sourceSignals as unknown as ShortageSignal[]) ?? [],
      recommendedSupplierHint: row.recommendedSupplierHint,
      generatedAt: row.generatedAt,
    },
    process.env.APP_URL ? { appBaseUrl: process.env.APP_URL } : {},
  );

  const now = new Date();
  try {
    await db.transaction(async (tx) => {
      if (sendResult.ok) {
        await tx
          .update(readMaterialRecommendations)
          .set({
            sentAt: now,
            lastSentResponse:
              sendResult.mapped as unknown as object,
            lastSendError: null,
            updatedAt: now,
          })
          .where(eq(readMaterialRecommendations.id, id));
        await writeAudit(
          {
            actorId: user.id,
            actorRole: user.role,
            action: "material_recommendation.send",
            targetType: "read_material_recommendations",
            targetId: id,
            after: {
              sentAt: now,
              status: sendResult.status,
              mapped: sendResult.mapped,
            },
          },
          tx,
        );
      } else {
        await tx
          .update(readMaterialRecommendations)
          .set({
            lastSendError: sendResult.reason,
            updatedAt: now,
          })
          .where(eq(readMaterialRecommendations.id, id));
        await writeAudit(
          {
            actorId: user.id,
            actorRole: user.role,
            action: "material_recommendation.send_failed",
            targetType: "read_material_recommendations",
            targetId: id,
            after: {
              code: sendResult.code,
              reason: sendResult.reason,
              status:
                "status" in sendResult ? sendResult.status : null,
            },
          },
          tx,
        );
      }
    });
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Persist failed",
    };
  }

  revalidatePath("/material-alerts");
  if (sendResult.ok) return { ok: true };
  return { error: sendResult.reason, code: sendResult.code };
}

export async function dismissMaterialRecommendationAction(
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireAdmin();
  const parsed = dismissSchema.safeParse({
    recommendationId: formData.get("recommendationId"),
    reason: formData.get("reason"),
    notes: formData.get("notes"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { recommendationId: id, reason, notes } = parsed.data;

  try {
    await db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(readMaterialRecommendations)
        .where(eq(readMaterialRecommendations.id, id))
        .limit(1);
      if (existing.length === 0) {
        throw new Error("Recommendation not found");
      }
      const row = existing[0]!;
      // Idempotent: already dismissed → noop.
      if (row.dismissedAt != null) return;

      const now = new Date();
      // Append the dismissal note to warnings[] so it surfaces in the
      // UI without needing a new column. Keep the original warnings.
      const priorWarnings =
        (row.warnings as unknown as string[] | null) ?? [];
      const tag = reason
        ? `[dismissed: ${reason}${notes ? ` — ${notes}` : ""}]`
        : notes
          ? `[dismissed: ${notes}]`
          : "[dismissed]";
      const nextWarnings = [...priorWarnings, tag];

      await tx
        .update(readMaterialRecommendations)
        .set({
          dismissedAt: now,
          warnings: nextWarnings as unknown as object,
          updatedAt: now,
        })
        .where(
          and(
            eq(readMaterialRecommendations.id, id),
            isNull(readMaterialRecommendations.dismissedAt),
          ),
        );

      await writeAudit(
        {
          actorId: user.id,
          actorRole: user.role,
          action: "material_recommendation.dismiss",
          targetType: "read_material_recommendations",
          targetId: id,
          before: { dismissedAt: row.dismissedAt },
          after: { dismissedAt: now, reason, notes },
        },
        tx,
      );
    });
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Failed to dismiss",
    };
  }

  revalidatePath("/material-alerts");
  return { ok: true };
}
