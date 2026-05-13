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
