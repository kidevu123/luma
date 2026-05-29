// ROLL-INTAKE-AUTO-NUMBER-INTEGRATION-1 — roll number format + batch assignment.

import type { ReceiptType } from "./roll-receive-batch";

export type RollNumberFormatInput = {
  materialKind: string;
  materialName?: string;
  receiptType: ReceiptType;
  receiptReference?: string | null;
};

export type AssignRollNumbersInput = RollNumberFormatInput & {
  count: number;
  existingRollNumbers: readonly string[];
};

function normalizeToken(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function rollNumberPrefixForMaterial(input: {
  materialKind: string;
  materialName?: string;
}): string {
  const kind = input.materialKind.toUpperCase();
  if (kind.includes("PVC")) return "PVC";
  if (kind.includes("FOIL")) return "FOIL";

  const fallback = normalizeToken(input.materialName ?? input.materialKind)
    .replace(/-?ROLL$/, "")
    .replace(/^ROLL-?/, "");
  return fallback || "ROLL";
}

function formatSequence(sequence: number): string {
  return String(sequence).padStart(Math.max(3, String(sequence).length), "0");
}

/** Prefix shared by all roll numbers in a receipt group (for collision scan). */
export function rollNumberGroupPrefix(input: RollNumberFormatInput): string | null {
  const prefix = rollNumberPrefixForMaterial(input);
  if (input.receiptType === "LEGACY_OPENING_BALANCE") {
    return `Legacy ${prefix}-`;
  }
  const reference = normalizeToken(input.receiptReference ?? "");
  if (!reference) return null;
  return `${prefix}-${reference}-`;
}

export function formatRollNumber(
  input: RollNumberFormatInput,
  sequence: number,
): string | null {
  const groupPrefix = rollNumberGroupPrefix(input);
  if (!groupPrefix) return null;
  return `${groupPrefix}${formatSequence(sequence)}`;
}

export function parseSequenceInGroup(
  rollNumber: string,
  groupPrefix: string,
): number | null {
  const upperRoll = rollNumber.trim().toUpperCase();
  const upperPrefix = groupPrefix.toUpperCase();
  if (!upperRoll.startsWith(upperPrefix)) return null;
  const suffix = rollNumber.trim().slice(groupPrefix.length);
  if (!/^\d+$/.test(suffix)) return null;
  return Number.parseInt(suffix, 10);
}

export function maxSequenceInGroup(
  existingRollNumbers: readonly string[],
  groupPrefix: string,
): number {
  let max = 0;
  for (const rollNumber of existingRollNumbers) {
    const seq = parseSequenceInGroup(rollNumber, groupPrefix);
    if (seq != null && seq > max) max = seq;
  }
  return max;
}

/** Assign the next `count` roll numbers in a group, skipping occupied sequences. */
export function assignRollNumbersForBatch(
  input: AssignRollNumbersInput,
): { rollNumbers: string[] } | { error: string } {
  const groupPrefix = rollNumberGroupPrefix(input);
  if (!groupPrefix) {
    return {
      error:
        input.receiptType === "NORMAL"
          ? "PO / receipt reference is required for normal receipts."
          : "Could not determine roll number group.",
    };
  }
  if (input.count < 1) {
    return { error: "Enter at least one roll." };
  }

  const start = maxSequenceInGroup(input.existingRollNumbers, groupPrefix) + 1;
  const rollNumbers: string[] = [];
  for (let i = 0; i < input.count; i++) {
    const formatted = formatRollNumber(input, start + i);
    if (!formatted) {
      return { error: "Could not generate roll number." };
    }
    rollNumbers.push(formatted);
  }
  return { rollNumbers };
}
