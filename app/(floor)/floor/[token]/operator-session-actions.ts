"use server";

// OP-1C — open / close station operator session.
//
// Floor PWA is anonymous (auth = URL scan token). The session table
// captures who's at the station so every count submission inherits the
// employee_id. Only one active session per station, enforced by a
// partial unique index.

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  stations,
  stationOperatorSessions,
  employees,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import { resolveAccountableEmployee } from "@/lib/production/accountability";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveStationByToken(token: string) {
  if (!UUID_RE.test(token)) return null;
  const [row] = await db
    .select()
    .from(stations)
    .where(eq(stations.scanToken, token));
  return row ?? null;
}

const openSchema = z.object({
  token: z.string(),
  stationId: z.string().uuid(),
  /** Either employeeCode (active employee) or freeText (legacy fallback)
   *  must be provided. employeeCode wins. */
  employeeCode: z.string().min(1).max(40).optional(),
  freeText: z.string().max(120).optional(),
  notes: z.string().max(400).optional(),
});

/** Open a new operator session. If one is already open for the
 *  station, it's closed first (operator handoff). Returns the new
 *  session id on success. */
export async function openOperatorSessionAction(
  formData: FormData,
): Promise<{ ok?: true; sessionId?: string; error?: string }> {
  const parsed = openSchema.safeParse({
    token: formData.get("token"),
    stationId: formData.get("stationId"),
    employeeCode: formData.get("employeeCode") || undefined,
    freeText: formData.get("freeText") || undefined,
    notes: formData.get("notes") || undefined,
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }
  const { token, stationId, employeeCode, freeText, notes } = parsed.data;
  if (!employeeCode && !freeText) {
    return { error: "Employee code or name is required." };
  }

  const station = await resolveStationByToken(token);
  if (!station || station.id !== stationId) {
    return { error: "Invalid station token." };
  }

  let newSessionId = "";
  try {
    await db.transaction(async (tx) => {
      // Resolve identity. Prefer employeeCode → stable lookup; fall
      // back to freeText (legacy text accountability).
      const r = await resolveAccountableEmployee(tx, {
        employeeCode: employeeCode ?? null,
        freeText: freeText ?? null,
      });
      if (!r) {
        throw new Error(
          "Could not resolve operator identity. Type a known code or full name.",
        );
      }

      // Close any currently-open session for this station first.
      await tx
        .update(stationOperatorSessions)
        .set({
          closedAt: new Date(),
        })
        .where(
          and(
            eq(stationOperatorSessions.stationId, stationId),
            isNull(stationOperatorSessions.closedAt),
          ),
        );

      const [inserted] = await tx
        .insert(stationOperatorSessions)
        .values({
          stationId,
          employeeId: r.accountableEmployeeId,
          employeeNameSnapshot: r.nameSnapshot ?? "Unknown",
          accountabilitySource: r.source,
          notes: notes ?? null,
        })
        .returning({ id: stationOperatorSessions.id });
      if (!inserted) throw new Error("Could not create session.");
      newSessionId = inserted.id;

      await writeAudit(
        {
          actorId: null,
          actorRole: null,
          action: "floor.operator_session_opened",
          targetType: "Station",
          targetId: stationId,
          after: {
            session_id: inserted.id,
            employee_id: r.accountableEmployeeId,
            employee_name: r.nameSnapshot,
            accountability_source: r.source,
          },
        },
        tx,
      );
    });
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Could not open session.",
    };
  }

  revalidatePath(`/floor/${token}`);
  return { ok: true, sessionId: newSessionId };
}

const endSchema = z.object({
  token: z.string(),
  stationId: z.string().uuid(),
});

/** Close any currently-open session for the station. Idempotent: a
 *  no-op when no session is open. */
export async function endOperatorSessionAction(
  formData: FormData,
): Promise<{ ok?: true; error?: string }> {
  const parsed = endSchema.safeParse({
    token: formData.get("token"),
    stationId: formData.get("stationId"),
  });
  if (!parsed.success) return { error: "Invalid input." };
  const { token, stationId } = parsed.data;

  const station = await resolveStationByToken(token);
  if (!station || station.id !== stationId) {
    return { error: "Invalid station token." };
  }

  try {
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(stationOperatorSessions)
        .set({ closedAt: new Date() })
        .where(
          and(
            eq(stationOperatorSessions.stationId, stationId),
            isNull(stationOperatorSessions.closedAt),
          ),
        )
        .returning({ id: stationOperatorSessions.id });

      if (updated.length > 0) {
        await writeAudit(
          {
            actorId: null,
            actorRole: null,
            action: "floor.operator_session_ended",
            targetType: "Station",
            targetId: stationId,
            after: {
              closed_session_ids: updated.map((u) => u.id),
            },
          },
          tx,
        );
      }
    });
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Could not end session.",
    };
  }

  revalidatePath(`/floor/${token}`);
  return { ok: true };
}

// Re-export employees query so the floor page can populate a code-only
// picker without crossing module boundaries.
export async function listActiveEmployeeOptions(): Promise<
  Array<{ id: string; fullName: string; employeeCode: string | null }>
> {
  const rows = await db
    .select({
      id: employees.id,
      fullName: employees.fullName,
      employeeCode: employees.employeeCode,
    })
    .from(employees)
    .where(eq(employees.status, "ACTIVE"));
  return rows;
}
