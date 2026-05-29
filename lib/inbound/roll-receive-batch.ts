// ROLL-INTAKE-UX-LEGACY-1 — validation helpers for multi-roll receive.

import { ROLL_COUNT_MAX } from "./roll-receive-input";

export type ReceiptType = "NORMAL" | "LEGACY_OPENING_BALANCE";

/** Client payload — weights only; roll numbers assigned server-side. */
export type RollReceiveWeightRowInput = {
  netWeightKg: number;
};

/** After server assigns roll numbers. */
export type RollReceiveRowInput = {
  rollNumber: string;
  netWeightKg: number;
};

export function rollRoleForMaterialKind(kind: string): "PVC" | "FOIL" {
  return kind === "PVC_ROLL" ? "PVC" : "FOIL";
}

export function materialKindShortLabel(kind: string): string {
  return kind === "PVC_ROLL" ? "PVC" : "FOIL";
}

/** Parse rollsJson from the batch form. Returns error message or weight rows. */
export function parseRollReceiveRowsJson(
  rollsJson: string,
): { rows: RollReceiveWeightRowInput[] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rollsJson);
  } catch {
    return { error: "Invalid roll list — please refresh and try again." };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { error: "Enter at least one roll." };
  }
  if (parsed.length > ROLL_COUNT_MAX) {
    return {
      error: `Maximum ${ROLL_COUNT_MAX} rolls per receipt.`,
    };
  }
  const rows: RollReceiveWeightRowInput[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (item == null || typeof item !== "object") {
      return { error: `Roll row ${i + 1} is invalid.` };
    }
    const netWeightKg =
      "netWeightKg" in item && typeof item.netWeightKg === "number"
        ? item.netWeightKg
        : Number.NaN;
    rows.push({ netWeightKg });
  }
  return { rows };
}

/** Validate weight rows from the client (no roll numbers). */
export function validateRollReceiveWeightBatch(
  rows: readonly RollReceiveWeightRowInput[],
): string | null {
  if (rows.length === 0) return "Enter at least one roll.";
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (!(row.netWeightKg > 0)) {
      return `Roll ${i + 1}: Net weight must be greater than 0 kg.`;
    }
  }
  return null;
}

/** Validate assigned rows before insert (duplicate + weight). */
export function validateRollReceiveBatch(
  rows: readonly RollReceiveRowInput[],
): string | null {
  if (rows.length === 0) return "Enter at least one roll.";
  const seen = new Set<string>();
  for (const row of rows) {
    const num = row.rollNumber.trim();
    if (!num) return "Each roll must have a roll number.";
    const key = num.toLowerCase();
    if (seen.has(key)) {
      return `Duplicate roll number in this receipt: "${num}".`;
    }
    seen.add(key);
    if (!(row.netWeightKg > 0)) {
      return `Net weight must be > 0 kg for roll "${num}".`;
    }
  }
  return null;
}
