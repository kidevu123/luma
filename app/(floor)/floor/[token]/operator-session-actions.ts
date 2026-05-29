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
import { FIRST_OP_COUNT_ACCOUNTABILITY_STATION_KINDS } from "@/lib/production/station-operator-session";

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

const openSchema = z
  .object({
    token: z.string(),
    stationId: z.string().uuid(),
    /** Picker path — stable employees.id even when employee_code is empty. */
    employeeId: z.string().uuid().optional(),
    /** Typed operator code (employees.employee_code lookup). */
    employeeCode: z.string().min(1).max(40).optional(),
    /** Last-resort free text — LEGACY_TEXT, no stable employee_id. */
    freeText: z.string().max(120).optional(),
    notes: z.string().max(400).optional(),
  })
  .refine(
    (d) =>
      (d.employeeId != null && d.employeeId !== "") ||
      (d.employeeCode != null && d.employeeCode !== "") ||
      (d.freeText != null && d.freeText.trim() !== ""),
    { message: "Pick an employee, enter an operator code, or type a name." },
  );

/** Open a new operator session. If one is already open for the
 *  station, it's closed first (operator handoff). Returns the new
 *  session id on success. */
export async function openOperatorSessionAction(
  formData: FormData,
): Promise<{ ok?: true; sessionId?: string; error?: string }> {
  const parsed = openSchema.safeParse({
    token: formData.get("token"),
    stationId: formData.get("stationId"),
    employeeId: formData.get("employeeId") || undefined,
    employeeCode: formData.get("employeeCode") || undefined,
    freeText: formData.get("freeText") || undefined,
    notes: formData.get("notes") || undefined,
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }
  const { token, stationId, employeeId, employeeCode, freeText, notes } =
    parsed.data;

  const station = await resolveStationByToken(token);
  if (!station || station.id !== stationId) {
    return { error: "Invalid station token." };
  }

  const requiresStableEmployee =
    FIRST_OP_COUNT_ACCOUNTABILITY_STATION_KINDS.has(station.kind);
  const hasStableInput = employeeId != null || employeeCode != null;
  if (requiresStableEmployee && freeText && !hasStableInput) {
    return {
      error:
        "Pick an employee from the list or enter a valid operator code. Free-text name alone cannot open a shift on this station.",
    };
  }

  let newSessionId = "";
  try {
    await db.transaction(async (tx) => {
      const r = await resolveAccountableEmployee(tx, {
        ...(employeeId != null ? { employeeId, sourceHint: "EMPLOYEE_PICKER" } : {}),
        ...(employeeCode != null ? { employeeCode } : {}),
        ...(freeText != null && !employeeId && !employeeCode
          ? { freeText, sourceHint: "LEGACY_TEXT" }
          : {}),
      });
      if (!r) {
        throw new Error(
          "Could not resolve operator identity. Pick from the list or type a known operator code.",
        );
      }
      if (requiresStableEmployee && !r.accountableEmployeeId) {
        throw new Error(
          "This station requires a real employee before submitting the first count. Pick from the list or enter a valid operator code.",
        );
      }

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
