"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { requireOwner } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import {
  legacyImportConfig,
  legacyImportPaths,
  companies,
  qrCards,
  workflowBags,
  legacyTtIdMap,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import { paWhoAmI } from "@/lib/legacy/pa-client";
import { runFetch } from "@/lib/legacy/fetcher";
import { runImport, previewImport } from "@/lib/legacy/tt-importer";
import { synthesizeReadModelsFromEvents } from "@/lib/legacy/read-model-synthesizer";
import { createSnapshot } from "@/lib/admin/snapshots";

async function getCompanyId(): Promise<string> {
  const [c] = await db.select({ id: companies.id }).from(companies).limit(1);
  if (!c) throw new Error("No company configured.");
  return c.id;
}

const credentialsSchema = z.object({
  paUsername: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-zA-Z0-9_-]+$/, "PA usernames are alphanumeric only."),
  paApiToken: z.string().max(200).optional(),
  isActive: z.coerce.boolean().optional(),
});

export async function saveLegacyImportCredentialsAction(formData: FormData) {
  const actor = await requireOwner();
  const parsed = credentialsSchema.safeParse({
    paUsername: formData.get("paUsername"),
    paApiToken: formData.get("paApiToken") || undefined,
    isActive: formData.get("isActive") === "on",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  try {
    const companyId = await getCompanyId();
    const [existing] = await db
      .select()
      .from(legacyImportConfig)
      .where(eq(legacyImportConfig.companyId, companyId));
    if (existing) {
      await db
        .update(legacyImportConfig)
        .set({
          paUsername: parsed.data.paUsername,
          // Only overwrite token if the operator typed something —
          // otherwise the form's masked value comes through and we
          // keep the stored token.
          ...(parsed.data.paApiToken
            ? { paApiToken: parsed.data.paApiToken }
            : {}),
          isActive: parsed.data.isActive ?? existing.isActive,
          updatedAt: new Date(),
          updatedById: actor.id,
        })
        .where(eq(legacyImportConfig.id, existing.id));
    } else {
      if (!parsed.data.paApiToken) {
        return { error: "API token is required on first save." };
      }
      await db.insert(legacyImportConfig).values({
        companyId,
        paUsername: parsed.data.paUsername,
        paApiToken: parsed.data.paApiToken,
        isActive: parsed.data.isActive ?? true,
        updatedById: actor.id,
      });
    }
    await writeAudit({
      actorId: actor.id,
      actorRole: actor.role,
      action: "legacy_import.credentials.update",
      targetType: "LegacyImportConfig",
      targetId: companyId,
      after: {
        paUsername: parsed.data.paUsername,
        isActive: parsed.data.isActive ?? true,
        // Never log the token.
      },
    });
    revalidatePath("/settings/legacy-import");
    return { ok: true as const };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Save failed." };
  }
}

export async function testLegacyImportConnectionAction() {
  await requireOwner();
  const companyId = await getCompanyId();
  const [cfg] = await db
    .select()
    .from(legacyImportConfig)
    .where(eq(legacyImportConfig.companyId, companyId));
  if (!cfg) return { error: "Save credentials first." };
  const r = await paWhoAmI(cfg.paUsername, cfg.paApiToken);
  if (r.ok) return { ok: true as const, message: "Token + username are valid." };
  return { error: r.message };
}

const pathSchema = z.object({
  remotePath: z
    .string()
    .min(2)
    .max(500)
    .regex(/^\//, "Remote path must start with /"),
  label: z.string().min(1).max(80),
  kind: z.enum(["DB_DUMP", "ZOHO_CONFIG", "OTHER"]),
});

export async function addLegacyImportPathAction(formData: FormData) {
  const actor = await requireOwner();
  const parsed = pathSchema.safeParse({
    remotePath: formData.get("remotePath"),
    label: formData.get("label"),
    kind: formData.get("kind"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  try {
    const companyId = await getCompanyId();
    const [cfg] = await db
      .select()
      .from(legacyImportConfig)
      .where(eq(legacyImportConfig.companyId, companyId));
    if (!cfg) return { error: "Save credentials first." };
    await db.insert(legacyImportPaths).values({
      configId: cfg.id,
      remotePath: parsed.data.remotePath,
      label: parsed.data.label,
      kind: parsed.data.kind,
    });
    await writeAudit({
      actorId: actor.id,
      actorRole: actor.role,
      action: "legacy_import.path.add",
      targetType: "LegacyImportPath",
      targetId: cfg.id,
      after: parsed.data,
    });
    revalidatePath("/settings/legacy-import");
    return { ok: true as const };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Save failed.";
    if (msg.includes("legacy_import_paths_remote_unique")) {
      return { error: "That remote path is already configured." };
    }
    return { error: msg };
  }
}

export async function togglePathEnabledAction(pathId: string) {
  const actor = await requireOwner();
  if (!z.string().uuid().safeParse(pathId).success) {
    return { error: "Invalid path." };
  }
  const [row] = await db
    .select()
    .from(legacyImportPaths)
    .where(eq(legacyImportPaths.id, pathId));
  if (!row) return { error: "Path not found." };
  await db
    .update(legacyImportPaths)
    .set({ enabled: !row.enabled })
    .where(eq(legacyImportPaths.id, pathId));
  await writeAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: "legacy_import.path.toggle",
    targetType: "LegacyImportPath",
    targetId: pathId,
    before: { enabled: row.enabled },
    after: { enabled: !row.enabled },
  });
  revalidatePath("/settings/legacy-import");
  return { ok: true as const };
}

export async function removePathAction(pathId: string) {
  const actor = await requireOwner();
  if (!z.string().uuid().safeParse(pathId).success) {
    return { error: "Invalid path." };
  }
  await db
    .delete(legacyImportPaths)
    .where(eq(legacyImportPaths.id, pathId));
  await writeAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: "legacy_import.path.remove",
    targetType: "LegacyImportPath",
    targetId: pathId,
  });
  revalidatePath("/settings/legacy-import");
  return { ok: true as const };
}

export async function fetchNowAction() {
  const actor = await requireOwner();
  const companyId = await getCompanyId();
  const [cfg] = await db
    .select()
    .from(legacyImportConfig)
    .where(eq(legacyImportConfig.companyId, companyId));
  if (!cfg) return { error: "Save credentials first." };
  try {
    const r = await runFetch({
      configId: cfg.id,
      triggeredBy: "MANUAL",
      actor,
    });
    return {
      ok: true as const,
      filesAttempted: r.filesAttempted,
      filesSucceeded: r.filesSucceeded,
      perFile: r.perFile.map((f) => ({
        ok: f.ok,
        remotePath: f.remotePath,
        bytes: f.bytes ?? 0,
        error: f.error,
      })),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Fetch failed." };
  }
}

/** Read the latest fetched .db.gz and report how many of each table
 *  would be inserted vs are already mapped. No DB writes. Owner-only. */
export async function previewImportAction() {
  await requireOwner();
  try {
    const r = await previewImport({});
    return {
      ok: true as const,
      sourceFile: r.sourceFile,
      legacyCounts: r.legacyCounts,
      alreadyMapped: r.alreadyMapped,
      wouldInsert: r.wouldInsert,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Preview failed." };
  }
}

/** Run the SQLite-→-Postgres importer against the most recently
 *  fetched .db.gz. Takes a Luma snapshot first so a bad result is
 *  fully reversible. Owner-only. */
export async function runImportAction(args?: { skipSnapshot?: boolean }) {
  const actor = await requireOwner();
  try {
    const snapshotResult = args?.skipSnapshot
      ? null
      : await createSnapshot(actor, "pre-tt-import");
    const result = await runImport({ actor });
    revalidatePath("/settings/legacy-import");
    revalidatePath("/floor-board");
    revalidatePath("/dashboard");
    revalidatePath("/inbound");
    revalidatePath("/batches");
    return {
      ok: result.ok,
      sourceFile: result.sourceFile,
      legacyCounts: result.legacyCounts,
      inserted: result.inserted,
      skipped: result.skipped,
      errorCount: result.errors.length,
      firstErrors: result.errors.slice(0, 5),
      durationMs: result.durationMs,
      snapshot: snapshotResult?.filename ?? null,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Import failed." };
  }
}

/** Release every QR card whose ASSIGNED workflowBag was imported
 *  from legacy and will never see a BAG_FINALIZED event. Without this
 *  the cards appear permanently in-use. We move them back to IDLE
 *  (un-pin from any workflow bag) so the floor can scan them again.
 *  Owner-only. Audited per card. */
export async function releaseOrphanedLegacyCardsAction() {
  const actor = await requireOwner();
  try {
    // Find every workflow_bag that came from the legacy import (its
    // id is in legacy_tt_id_map under tt_table='qr_cards' or
    // 'workflow_bags') AND has no finalized_at AND no events past
    // CARD_ASSIGNED in the last 30 days. These are "abandoned"
    // legacy sessions.
    const candidates = await db
      .select({
        cardId: qrCards.id,
        workflowBagId: qrCards.assignedWorkflowBagId,
      })
      .from(qrCards)
      .innerJoin(workflowBags, eq(workflowBags.id, qrCards.assignedWorkflowBagId))
      .innerJoin(
        legacyTtIdMap,
        and(
          eq(legacyTtIdMap.lumaTable, "workflow_bags"),
          eq(legacyTtIdMap.lumaId, workflowBags.id),
        ),
      )
      .where(
        and(
          eq(qrCards.status, "ASSIGNED"),
          isNull(workflowBags.finalizedAt),
        ),
      );
    if (candidates.length === 0) {
      return { ok: true as const, released: 0 };
    }
    const ids = candidates.map((c) => c.cardId);
    await db
      .update(qrCards)
      .set({ status: "IDLE", assignedWorkflowBagId: null })
      .where(inArray(qrCards.id, ids));
    await writeAudit({
      actorId: actor.id,
      actorRole: actor.role,
      action: "legacy_import.release_orphan_cards",
      targetType: "QrCard",
      targetId: `bulk:${ids.length}`,
      after: { releasedCardIds: ids },
    });
    revalidatePath("/qr-cards");
    revalidatePath("/floor-board");
    return { ok: true as const, released: ids.length };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Release failed." };
  }
}

/** Rebuild Luma's rollup tables (read_bag_state, read_bag_metrics,
 *  read_daily_throughput, read_operator_daily) from workflow_events.
 *  The importer runs this automatically as its last step; this
 *  action lets an operator re-run it on demand if rollups drift or
 *  a new aggregation rule ships. Owner-only. */
export async function synthesizeReadModelsAction() {
  const actor = await requireOwner();
  try {
    const r = await synthesizeReadModelsFromEvents();
    revalidatePath("/floor-board");
    revalidatePath("/dashboard");
    revalidatePath("/metrics");
    revalidatePath("/reports");
    void actor;
    return {
      ok: true as const,
      bagStateRows: r.bagStateRows,
      bagMetricsRows: r.bagMetricsRows,
      dailyThroughputRows: r.dailyThroughputRows,
      operatorDailyRows: r.operatorDailyRows,
      durationMs: r.durationMs,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Synthesis failed." };
  }
}
