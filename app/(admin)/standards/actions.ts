"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { compact } from "@/lib/db/compact";
import { requireAdmin } from "@/lib/auth-guards";
import {
  productionCalendars,
  stationStandards,
  laborRates,
  dueTargets,
} from "@/lib/db/schema";

// ─── Production calendars ────────────────────────────────────────

const calendarSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(120),
  effectiveFrom: z.string().date(),
  effectiveTo: z.string().date().optional().nullable(),
  shiftStart: z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM 24-hour format"),
  shiftEnd: z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM 24-hour format"),
  plannedBreakMinutes: z.coerce.number().int().min(0).max(720),
  daysOfWeekMask: z.coerce.number().int().min(1).max(127),
  notes: z.string().max(500).optional().nullable(),
});

export async function saveCalendarAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  await requireAdmin();
  const parsed = calendarSchema.safeParse({
    id: formData.get("id") || undefined,
    name: formData.get("name"),
    effectiveFrom: formData.get("effectiveFrom"),
    effectiveTo: formData.get("effectiveTo") || null,
    shiftStart: formData.get("shiftStart"),
    shiftEnd: formData.get("shiftEnd"),
    plannedBreakMinutes: formData.get("plannedBreakMinutes") || 0,
    daysOfWeekMask: formData.get("daysOfWeekMask") || 127,
    notes: formData.get("notes") || null,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const { id, ...rest } = parsed.data;
  try {
    if (id) {
      await db
        .update(productionCalendars)
        .set({ ...compact(rest), updatedAt: new Date() })
        .where(eq(productionCalendars.id, id));
    } else {
      await db.insert(productionCalendars).values(compact(rest));
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Save failed." };
  }
  revalidatePath("/standards/calendars");
  return { ok: true };
}

export async function deleteCalendarAction(id: string) {
  await requireAdmin();
  await db.delete(productionCalendars).where(eq(productionCalendars.id, id));
  revalidatePath("/standards/calendars");
}

// ─── Station standards ──────────────────────────────────────────

const stationStandardSchema = z
  .object({
    id: z.string().uuid().optional(),
    stationId: z.string().uuid().optional().nullable(),
    machineId: z.string().uuid().optional().nullable(),
    productId: z.string().uuid().optional().nullable(),
    idealCycleSeconds: z.coerce.number().min(0).max(100000).optional().nullable(),
    targetUnitsPerHour: z.coerce.number().min(0).max(1000000).optional().nullable(),
    expectedYieldPct: z.coerce.number().min(0).max(100).optional().nullable(),
    outputUnit: z.enum(["BAG", "DISPLAY", "CASE", "TABLET", "BOTTLE", "CARD"]),
    effectiveFrom: z.string().date(),
    effectiveTo: z.string().date().optional().nullable(),
    isActive: z.coerce.boolean().optional(),
    notes: z.string().max(500).optional().nullable(),
  })
  .refine((d) => d.stationId || d.machineId, {
    message: "Pick at least one of station or machine.",
    path: ["machineId"],
  })
  .refine(
    (d) => d.idealCycleSeconds || d.targetUnitsPerHour,
    {
      message: "Set either ideal cycle seconds or target units per hour.",
      path: ["idealCycleSeconds"],
    },
  );

export async function saveStationStandardAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const actor = await requireAdmin();
  const parsed = stationStandardSchema.safeParse({
    id: formData.get("id") || undefined,
    stationId: formData.get("stationId") || null,
    machineId: formData.get("machineId") || null,
    productId: formData.get("productId") || null,
    idealCycleSeconds: formData.get("idealCycleSeconds") || null,
    targetUnitsPerHour: formData.get("targetUnitsPerHour") || null,
    expectedYieldPct: formData.get("expectedYieldPct") || null,
    outputUnit: formData.get("outputUnit"),
    effectiveFrom: formData.get("effectiveFrom"),
    effectiveTo: formData.get("effectiveTo") || null,
    isActive: formData.get("isActive") === "on",
    notes: formData.get("notes") || null,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const { id, ...rest } = parsed.data;
  // Drizzle needs string for numerics
  const valuesForDb = {
    ...rest,
    idealCycleSeconds:
      rest.idealCycleSeconds != null ? String(rest.idealCycleSeconds) : null,
    targetUnitsPerHour:
      rest.targetUnitsPerHour != null ? String(rest.targetUnitsPerHour) : null,
    expectedYieldPct:
      rest.expectedYieldPct != null ? String(rest.expectedYieldPct) : null,
  };
  try {
    if (id) {
      await db
        .update(stationStandards)
        .set({ ...compact(valuesForDb), updatedAt: new Date() })
        .where(eq(stationStandards.id, id));
    } else {
      await db
        .insert(stationStandards)
        .values({ ...compact(valuesForDb), createdById: actor.id });
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Save failed." };
  }
  revalidatePath("/standards/station-standards");
  return { ok: true };
}

export async function deleteStationStandardAction(id: string) {
  await requireAdmin();
  await db.delete(stationStandards).where(eq(stationStandards.id, id));
  revalidatePath("/standards/station-standards");
}

// ─── Labor rates ────────────────────────────────────────────────

const laborSchema = z.object({
  id: z.string().uuid().optional(),
  role: z.string().min(1).max(80),
  hourlyRateCents: z.coerce.number().int().min(0).max(100_000_00),
  burdenMultiplier: z.coerce.number().min(0).max(99.999),
  effectiveFrom: z.string().date(),
  effectiveTo: z.string().date().optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
});

export async function saveLaborRateAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const actor = await requireAdmin();
  const parsed = laborSchema.safeParse({
    id: formData.get("id") || undefined,
    role: formData.get("role"),
    // UI shows dollars; convert to cents server-side.
    hourlyRateCents: Math.round(
      Number(formData.get("hourlyRateDollars") || 0) * 100,
    ),
    burdenMultiplier: formData.get("burdenMultiplier") || "1.0",
    effectiveFrom: formData.get("effectiveFrom"),
    effectiveTo: formData.get("effectiveTo") || null,
    notes: formData.get("notes") || null,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const { id, ...rest } = parsed.data;
  const valuesForDb = {
    ...rest,
    burdenMultiplier: String(rest.burdenMultiplier),
  };
  try {
    if (id) {
      await db
        .update(laborRates)
        .set({ ...compact(valuesForDb), updatedAt: new Date() })
        .where(eq(laborRates.id, id));
    } else {
      await db
        .insert(laborRates)
        .values({ ...compact(valuesForDb), createdById: actor.id });
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Save failed." };
  }
  revalidatePath("/standards/labor-rates");
  return { ok: true };
}

export async function deleteLaborRateAction(id: string) {
  await requireAdmin();
  await db.delete(laborRates).where(eq(laborRates.id, id));
  revalidatePath("/standards/labor-rates");
}

// ─── Due targets ────────────────────────────────────────────────

const dueSchema = z.object({
  id: z.string().uuid().optional(),
  referenceKind: z.string().min(1).max(40),
  referenceId: z.string().min(1).max(120),
  productId: z.string().uuid().optional().nullable(),
  targetQuantity: z.coerce.number().int().min(1).max(10_000_000),
  targetUnit: z.enum(["BAG", "DISPLAY", "CASE", "TABLET", "BOTTLE", "CARD"]),
  dueAt: z.string().datetime({ offset: true }).or(z.string().min(10)),
  priority: z.coerce.number().int().min(1).max(100),
  notes: z.string().max(500).optional().nullable(),
});

export async function saveDueTargetAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const actor = await requireAdmin();
  // dueAt arrives as datetime-local "YYYY-MM-DDTHH:MM" — append seconds + Z
  const dueAtRaw = String(formData.get("dueAt") ?? "");
  const dueAtIso = dueAtRaw.length === 16 ? `${dueAtRaw}:00Z` : dueAtRaw;
  const parsed = dueSchema.safeParse({
    id: formData.get("id") || undefined,
    referenceKind: formData.get("referenceKind"),
    referenceId: formData.get("referenceId"),
    productId: formData.get("productId") || null,
    targetQuantity: formData.get("targetQuantity"),
    targetUnit: formData.get("targetUnit"),
    dueAt: dueAtIso,
    priority: formData.get("priority") || 50,
    notes: formData.get("notes") || null,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const { id, ...rest } = parsed.data;
  const valuesForDb = { ...rest, dueAt: new Date(rest.dueAt) };
  try {
    if (id) {
      await db
        .update(dueTargets)
        .set({ ...compact(valuesForDb), updatedAt: new Date() })
        .where(eq(dueTargets.id, id));
    } else {
      await db
        .insert(dueTargets)
        .values({ ...compact(valuesForDb), createdById: actor.id });
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Save failed." };
  }
  revalidatePath("/standards/due-targets");
  return { ok: true };
}

export async function markDueTargetCompleteAction(id: string) {
  await requireAdmin();
  await db
    .update(dueTargets)
    .set({ completedAt: new Date(), updatedAt: new Date() })
    .where(eq(dueTargets.id, id));
  revalidatePath("/standards/due-targets");
}

export async function deleteDueTargetAction(id: string) {
  await requireAdmin();
  await db.delete(dueTargets).where(eq(dueTargets.id, id));
  revalidatePath("/standards/due-targets");
}
