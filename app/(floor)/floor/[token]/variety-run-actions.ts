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
import { stations, varietyRuns, rawBagAllocationSessions } from "@/lib/db/schema";

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
      return { ok: true, runId: existing[0].id, resumed: true };
    }

    // No OPEN run — insert a new one.
    const inserted = await db
      .insert(varietyRuns)
      .values({
        parentScanToken: trimmedToken,
        ...(d.productId && d.productId !== ""
          ? { productId: d.productId }
          : {}),
        status: "OPEN",
      })
      .returning({ id: varietyRuns.id });

    const newRow = inserted[0];
    if (!newRow) throw new Error("Insert returned no row.");

    return { ok: true, runId: newRow.id, resumed: false };
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

    // Close the run.
    await db
      .update(varietyRuns)
      .set({
        status: "CLOSED",
        closedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(varietyRuns.id, d.varietyRunId));

    return { ok: true };
  } catch (err) {
    return {
      error:
        err instanceof Error ? err.message : "Close variety run failed.",
    };
  }
}
