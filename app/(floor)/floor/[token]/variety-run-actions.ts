// VARIETY-RUNS-1 — Floor server actions for variety run lifecycle.
//
// Two actions:
//   • startOrResumeVarietyRunAction — find the OPEN variety run for the
//     scanned token, or create a new one if none exists. The partial
//     unique index variety_runs_one_open_per_token_idx guarantees only
//     one OPEN row per token at a time.
//   • closeVarietyRunAction — close the run. Refuses if any child
//     raw_bag_allocation_sessions are still OPEN. Does NOT touch child
//     sessions, does NOT release child QR cards.

"use server";

import { z } from "zod";
import { eq, and, count } from "drizzle-orm";
import { db } from "@/lib/db";
import { stations, varietyRuns, rawBagAllocationSessions, qrCards } from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import { resolveStationAccountability } from "@/lib/production/station-operator-session";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type StationRow = typeof stations.$inferSelect;

async function authStation(
  token: string,
  stationIdFromForm: string,
): Promise<StationRow> {
  if (!UUID_RE.test(token)) throw new Error("Invalid station token.");
  const [station] = await db
    .select()
    .from(stations)
    .where(eq(stations.scanToken, token));
  if (!station) throw new Error("Invalid station token.");
  if (station.id !== stationIdFromForm) throw new Error("Station mismatch.");
  return station;
}

// ── startOrResumeVarietyRunAction ──────────────────────────────────

const startSchema = z.object({
  token: z.string().regex(UUID_RE),
  stationId: z.string().uuid(),
  parentScanToken: z.string().max(200),
  productId: z.string().uuid().optional().nullable().or(z.literal("")),
  clientEventId: z.string().regex(UUID_RE).optional(),
});

export async function startOrResumeVarietyRunAction(
  formData: FormData,
): Promise<{ ok: true; runId: string; resumed: boolean } | { error: string }> {
  const parsed = startSchema.safeParse({
    token: formData.get("token"),
    stationId: formData.get("stationId"),
    parentScanToken: formData.get("parentScanToken"),
    productId: formData.get("productId") || undefined,
    clientEventId: formData.get("clientEventId") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const d = parsed.data;

  const trimmedToken = (d.parentScanToken ?? "").trim();
  if (!trimmedToken) {
    return { error: "Parent variety scan token is required." };
  }

  try {
    await authStation(d.token, d.stationId);

    // Validate the VARIETY_PACK QR card.
    const [qrCard] = await db
      .select({ id: qrCards.id, cardType: qrCards.cardType, status: qrCards.status })
      .from(qrCards)
      .where(eq(qrCards.scanToken, trimmedToken))
      .limit(1);

    if (!qrCard) {
      return { error: "Variety pack QR card not found." };
    }
    if (qrCard.cardType !== "VARIETY_PACK") {
      return { error: "This is not a variety pack QR card." };
    }
    if (qrCard.status === "RETIRED") {
      return { error: "This variety pack QR card is retired." };
    }

    // Check for an existing OPEN run for this token.
    const existing = await db
      .select({ id: varietyRuns.id })
      .from(varietyRuns)
      .where(
        and(
          eq(varietyRuns.parentScanToken, trimmedToken),
          eq(varietyRuns.status, "OPEN"),
        ),
      )
      .limit(1);

    if (existing[0]) {
      // Resume path — card is already ASSIGNED. Just write audit.
      await db.transaction(async (tx) => {
        const accountability = await resolveStationAccountability(tx, {
          stationId: d.stationId,
        });
        await writeAudit(
          {
            actorId: accountability.enteredByUserId ?? null,
            actorRole: null,
            action: "RESUME_VARIETY_RUN",
            targetType: "variety_run",
            targetId: existing[0]!.id,
          },
          tx,
        );
      });
      return { ok: true, runId: existing[0].id, resumed: true };
    }

    // No OPEN run — verify QR card is IDLE before starting a new one.
    if (qrCard.status !== "IDLE") {
      return { error: "This variety pack QR card is already in use by an open variety run." };
    }

    // Insert a new run.
    let newId = "";
    await db.transaction(async (tx) => {
      const accountability = await resolveStationAccountability(tx, {
        stationId: d.stationId,
      });
      const inserted = await tx
        .insert(varietyRuns)
        .values({
          parentScanToken: trimmedToken,
          varietyQrCardId: qrCard.id,
          ...(d.productId && d.productId !== ""
            ? { productId: d.productId }
            : {}),
          status: "OPEN",
        })
        .returning({ id: varietyRuns.id });
      const newRow = inserted[0];
      if (!newRow) throw new Error("Insert returned no row.");
      newId = newRow.id;

      await tx.update(qrCards).set({ status: "ASSIGNED" }).where(eq(qrCards.id, qrCard.id));
      await writeAudit({
        actorId: accountability.enteredByUserId ?? null,
        actorRole: null,
        action: "VARIETY_QR_ASSIGNED",
        targetType: "qr_card",
        targetId: qrCard.id,
      }, tx);

      await writeAudit(
        {
          actorId: accountability.enteredByUserId ?? null,
          actorRole: null,
          action: "START_VARIETY_RUN",
          targetType: "variety_run",
          targetId: newId,
        },
        tx,
      );
    });
    if (!newId) throw new Error("No run ID after insert.");
    return { ok: true, runId: newId, resumed: false };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Start variety run failed.",
    };
  }
}

// ── closeVarietyRunAction ──────────────────────────────────────────

const closeSchema = z.object({
  token: z.string().regex(UUID_RE),
  stationId: z.string().uuid(),
  varietyRunId: z.string().uuid(),
  clientEventId: z.string().regex(UUID_RE).optional(),
});

export async function closeVarietyRunAction(
  formData: FormData,
): Promise<{ ok: true } | { error: string }> {
  const parsed = closeSchema.safeParse({
    token: formData.get("token"),
    stationId: formData.get("stationId"),
    varietyRunId: formData.get("varietyRunId"),
    clientEventId: formData.get("clientEventId") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const d = parsed.data;

  try {
    await authStation(d.token, d.stationId);

    // Load the variety run.
    const runRows = await db
      .select()
      .from(varietyRuns)
      .where(eq(varietyRuns.id, d.varietyRunId))
      .limit(1);
    const run = runRows[0];
    if (!run) return { error: "Variety run not found." };

    if (run.status === "CLOSED" || run.status === "VOID") {
      return {
        error: `Variety run is already ${run.status.toLowerCase()}.`,
      };
    }

    // Refuse close if any child sessions are still OPEN.
    const openChildRows = await db
      .select({ count: count() })
      .from(rawBagAllocationSessions)
      .where(
        and(
          eq(rawBagAllocationSessions.varietyRunId, d.varietyRunId),
          eq(rawBagAllocationSessions.allocationStatus, "OPEN"),
        ),
      );
    const openCount = openChildRows[0]?.count ?? 0;
    if (openCount > 0) {
      return {
        error: `Cannot close variety run: ${openCount} source bag session(s) still OPEN. Close each source bag first.`,
      };
    }

    // Close the run inside a transaction and write audit.
    await db.transaction(async (tx) => {
      const accountability = await resolveStationAccountability(tx, {
        stationId: d.stationId,
      });

      await tx
        .update(varietyRuns)
        .set({
          status: "CLOSED",
          closedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(varietyRuns.id, d.varietyRunId));

      // Release VARIETY_PACK QR card.
      const [parentCard] = run.varietyQrCardId
        ? await tx
            .select({ id: qrCards.id, status: qrCards.status })
            .from(qrCards)
            .where(eq(qrCards.id, run.varietyQrCardId))
            .limit(1)
        : await tx
            .select({ id: qrCards.id, status: qrCards.status })
            .from(qrCards)
            .where(eq(qrCards.scanToken, run.parentScanToken))
            .limit(1);

      if (parentCard && parentCard.status === "ASSIGNED") {
        await tx.update(qrCards).set({ status: "IDLE" }).where(eq(qrCards.id, parentCard.id));
        await writeAudit({
          actorId: accountability.enteredByUserId ?? null,
          actorRole: null,
          action: "VARIETY_QR_RELEASED",
          targetType: "qr_card",
          targetId: parentCard.id,
        }, tx);
      } else if (!parentCard) {
        // Legacy run with no QR card record — do not crash.
        await writeAudit({
          actorId: accountability.enteredByUserId ?? null,
          actorRole: null,
          action: "VARIETY_QR_RELEASE_SKIPPED_LEGACY",
          targetType: "variety_run",
          targetId: d.varietyRunId,
        }, tx);
      }

      await writeAudit(
        {
          actorId: accountability.enteredByUserId ?? null,
          actorRole: null,
          action: "CLOSE_VARIETY_RUN",
          targetType: "variety_run",
          targetId: d.varietyRunId,
        },
        tx,
      );
    });

    return { ok: true };
  } catch (err) {
    return {
      error:
        err instanceof Error ? err.message : "Close variety run failed.",
    };
  }
}
