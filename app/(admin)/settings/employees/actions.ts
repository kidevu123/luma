"use server";

// P5-SUPERVISOR Task 2 — admin PIN setter + is_supervisor toggle.
//
// The employees table pre-dates a dedicated admin CRUD surface —
// grep across app/(admin) shows only operator-productivity reads it,
// so this is the first employees-editing screen. Kept minimal on
// purpose: the plan calls for exactly "PIN set + is_supervisor
// toggle" under existing admin conventions, not a full employees
// editor. When Nexus/HR eventually wants full employee CRUD it can
// hang beside these two actions rather than replacing them.
//
// AUDIT SHAPE. Both actions write audit rows. SUPERVISOR_PIN_SET
// carries the target employee id + who set it, and DELIBERATELY
// omits the hash — a hash rewind still lets an offline attacker
// grind against the argon2id parameters, and the audit trail's job
// is to say who set the PIN, not to snapshot the secret material.
// The plan explicitly requires "no hash in the payload."

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { employees } from "@/lib/db/schema";
import { hashPassword } from "@/lib/auth";
import { requireAdmin } from "@/lib/auth-guards";
import { writeAudit } from "@/lib/db/audit";

const setPinSchema = z.object({
  employeeId: z.string().uuid(),
  // Numeric PIN, 4-12 digits — long enough to resist the ~10^4 brute
  // force on a 4-digit space, short enough that operators can key it
  // on a tablet under supervision. The engine's verify accepts any
  // string; this is the SETTER's policy, not a hash-time constraint.
  pin: z
    .string()
    .regex(/^\d{4,12}$/, "PIN must be 4 to 12 digits."),
});

export async function setEmployeeSupervisorPinAction(
  formData: FormData,
): Promise<{ error: string } | { ok: true }> {
  // Decision: ADMIN tier may set supervisor PINs, matching every other
  // settings/* surface. PIN-setting grants floor-side escalation, so if
  // role granularity ever tightens, this is the first candidate for
  // OWNER-only.
  const me = await requireAdmin();
  const parsed = setPinSchema.safeParse({
    employeeId: formData.get("employeeId"),
    pin: formData.get("pin"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const [target] = await db
    .select({
      id: employees.id,
      fullName: employees.fullName,
      status: employees.status,
    })
    .from(employees)
    .where(eq(employees.id, parsed.data.employeeId));
  if (!target) return { error: "Employee not found." };
  if (target.status !== "ACTIVE") {
    return { error: "Only ACTIVE employees may have a supervisor PIN." };
  }

  // Hash via lib/auth.ts's argon2id helper — the SAME hash/verify
  // pair the engine's openSupervisorSession uses. Never inline
  // parameters here.
  const hash = await hashPassword(parsed.data.pin);
  await db
    .update(employees)
    .set({
      supervisorPinHash: hash,
      updatedAt: new Date(),
    })
    .where(eq(employees.id, parsed.data.employeeId));

  await writeAudit({
    actorId: me.id,
    actorRole: me.role,
    action: "SUPERVISOR_PIN_SET",
    targetType: "Employee",
    targetId: parsed.data.employeeId,
    // Deliberately no `hash` or `pin` field. See module header.
    after: {
      employee_id: parsed.data.employeeId,
      employee_name: target.fullName,
    },
  });

  revalidatePath("/settings/employees");
  return { ok: true };
}

const toggleSchema = z.object({
  employeeId: z.string().uuid(),
  isSupervisor: z.enum(["true", "false"]),
});

export async function toggleEmployeeIsSupervisorAction(
  formData: FormData,
): Promise<{ error: string } | { ok: true }> {
  const me = await requireAdmin();
  const parsed = toggleSchema.safeParse({
    employeeId: formData.get("employeeId"),
    isSupervisor: formData.get("isSupervisor"),
  });
  if (!parsed.success) return { error: "Invalid input." };

  const [target] = await db
    .select({
      id: employees.id,
      fullName: employees.fullName,
      isSupervisor: employees.isSupervisor,
      supervisorPinHash: employees.supervisorPinHash,
      status: employees.status,
    })
    .from(employees)
    .where(eq(employees.id, parsed.data.employeeId));
  if (!target) return { error: "Employee not found." };
  if (target.status !== "ACTIVE") {
    return { error: "Only ACTIVE employees may be marked as supervisors." };
  }

  const next = parsed.data.isSupervisor === "true";
  if (next && target.supervisorPinHash == null) {
    // Marking someone a supervisor without a PIN gives them a
    // capability they cannot actually exercise — openSupervisorSession
    // will still refuse. Refuse in the SET path instead so admins
    // don't see a green toggle that unlocks nothing.
    return {
      error:
        "Set a supervisor PIN before marking this employee as a supervisor.",
    };
  }

  await db
    .update(employees)
    .set({ isSupervisor: next, updatedAt: new Date() })
    .where(eq(employees.id, parsed.data.employeeId));

  await writeAudit({
    actorId: me.id,
    actorRole: me.role,
    action: "SUPERVISOR_FLAG_UPDATED",
    targetType: "Employee",
    targetId: parsed.data.employeeId,
    before: { is_supervisor: target.isSupervisor },
    after: { is_supervisor: next },
  });

  revalidatePath("/settings/employees");
  return { ok: true };
}
