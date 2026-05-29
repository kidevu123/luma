// ROLL-INTAKE-UX-LEGACY-1 — validation helpers for multi-roll receive.

export type ReceiptType = "NORMAL" | "LEGACY_OPENING_BALANCE";

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

/** Parse rollsJson from the batch form. Returns error message or rows. */
export function parseRollReceiveRowsJson(
  rollsJson: string,
): { rows: RollReceiveRowInput[] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rollsJson);
  } catch {
    return { error: "Invalid roll list — please refresh and try again." };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { error: "Enter at least one roll." };
  }
  if (parsed.length > 50) {
    return { error: "Maximum 50 rolls per receipt." };
  }
  const rows: RollReceiveRowInput[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (item == null || typeof item !== "object") {
      return { error: `Roll row ${i + 1} is invalid.` };
    }
    const rollNumber =
      "rollNumber" in item && typeof item.rollNumber === "string"
        ? item.rollNumber.trim()
        : "";
    const netWeightKg =
      "netWeightKg" in item && typeof item.netWeightKg === "number"
        ? item.netWeightKg
        : Number.NaN;
    rows.push({ rollNumber, netWeightKg });
  }
  return { rows };
}

/** Client-side + server-side batch validation. Returns first error or null. */
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
