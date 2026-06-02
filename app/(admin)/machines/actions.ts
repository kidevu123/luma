"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guards";
import {
  createMachine,
  createStation,
  rotateStationToken,
  setMachineActive,
  setStationActive,
  updateMachineCardsPerTurn,
  updateMachineName,
  updateStationLabel,
} from "@/lib/db/queries/machines";

const machineSchema = z.object({
  name: z.string().min(1).max(60),
  kind: z.enum([
    "BLISTER",
    "SEALING",
    "PACKAGING",
    "BOTTLE_HANDPACK",
    "BOTTLE_CAP_SEAL",
    "BOTTLE_STICKER",
    "COMBINED",
  ]),
  cardsPerTurn: z.coerce.number().int().min(1).max(50).optional(),
});

export async function createMachineAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const actor = await requireAdmin();
  const parsed = machineSchema.safeParse({
    name: formData.get("name"),
    kind: formData.get("kind"),
    cardsPerTurn: formData.get("cardsPerTurn") || 1,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  try {
    await createMachine(parsed.data, actor);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Save failed." };
  }
  revalidatePath("/machines");
  return { ok: true };
}

const updateCardsPerTurnSchema = z.object({
  machineId: z.string().uuid(),
  cardsPerTurn: z.coerce.number().int().min(1).max(50),
});

export async function updateMachineCardsPerTurnAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const actor = await requireAdmin();
  const parsed = updateCardsPerTurnSchema.safeParse({
    machineId: formData.get("machineId"),
    cardsPerTurn: formData.get("cardsPerTurn"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  try {
    await updateMachineCardsPerTurn(
      parsed.data.machineId,
      parsed.data.cardsPerTurn,
      actor,
    );
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Save failed." };
  }
  revalidatePath("/machines");
  return { ok: true };
}

const stationSchema = z.object({
  label: z.string().min(1).max(60),
  kind: z.enum([
    "BLISTER",
    "HANDPACK_BLISTER",
    "SEALING",
    "PACKAGING",
    "BOTTLE_HANDPACK",
    "BOTTLE_CAP_SEAL",
    "BOTTLE_STICKER",
    "COMBINED",
  ]),
  machineId: z.union([z.string().uuid(), z.literal("").transform(() => null)]).nullable(),
});

export async function createStationAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const actor = await requireAdmin();
  const parsed = stationSchema.safeParse({
    label: formData.get("label"),
    kind: formData.get("kind"),
    machineId: formData.get("machineId") || "",
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  try {
    await createStation(parsed.data, actor);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Save failed." };
  }
  revalidatePath("/machines");
  return { ok: true };
}

export async function rotateTokenAction(
  stationId: string,
): Promise<{ error?: string; ok?: true; token?: string } | void> {
  const actor = await requireAdmin();
  if (!z.string().uuid().safeParse(stationId).success) return { error: "Invalid station." };
  try {
    const updated = await rotateStationToken(stationId, actor);
    revalidatePath("/machines");
    return { ok: true, token: updated.scanToken };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Rotate failed." };
  }
}

const updateMachineNameSchema = z.object({
  machineId: z.string().uuid(),
  name: z.string().min(1).max(60),
});

export async function updateMachineNameAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const actor = await requireAdmin();
  const parsed = updateMachineNameSchema.safeParse({
    machineId: formData.get("machineId"),
    name: formData.get("name"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  try {
    await updateMachineName(parsed.data.machineId, parsed.data.name, actor);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Save failed." };
  }
  revalidatePath("/machines");
  return { ok: true };
}

const updateStationLabelSchema = z.object({
  stationId: z.string().uuid(),
  label: z.string().min(1).max(60),
});

export async function updateStationLabelAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const actor = await requireAdmin();
  const parsed = updateStationLabelSchema.safeParse({
    stationId: formData.get("stationId"),
    label: formData.get("label"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  try {
    await updateStationLabel(parsed.data.stationId, parsed.data.label, actor);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Save failed." };
  }
  revalidatePath("/machines");
  return { ok: true };
}

const setActiveSchema = z.object({
  id: z.string().uuid(),
  active: z.enum(["true", "false"]),
});

export async function setMachineActiveAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const actor = await requireAdmin();
  const parsed = setActiveSchema.safeParse({
    id: formData.get("id"),
    active: formData.get("active"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  try {
    await setMachineActive(
      parsed.data.id,
      parsed.data.active === "true",
      actor,
    );
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Update failed." };
  }
  revalidatePath("/machines");
  return { ok: true };
}

export async function setStationActiveAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const actor = await requireAdmin();
  const parsed = setActiveSchema.safeParse({
    id: formData.get("id"),
    active: formData.get("active"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  try {
    await setStationActive(
      parsed.data.id,
      parsed.data.active === "true",
      actor,
    );
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Update failed." };
  }
  revalidatePath("/machines");
  return { ok: true };
}
