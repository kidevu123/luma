import type { ReceiptType } from "./roll-receive-batch";

export type GenerateRollNumberInput = {
  materialKind: string;
  materialName?: string;
  receiptType: ReceiptType;
  receiptReference?: string | null;
  sequence: number;
};

export type AutoRollNumberRow = {
  rollNumber: string;
  rollNumberSource: "auto" | "manual";
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

export function generateRollNumber(input: GenerateRollNumberInput): string | null {
  const prefix = rollNumberPrefixForMaterial(input);
  const sequence = String(input.sequence).padStart(3, "0");

  if (input.receiptType === "LEGACY_OPENING_BALANCE") {
    return `Legacy ${prefix}-${sequence}`;
  }

  const reference = normalizeToken(input.receiptReference ?? "");
  if (!reference) return null;
  return `${prefix}-${reference}-${sequence}`;
}

export function applyGeneratedRollNumbers<T extends AutoRollNumberRow>(
  rows: readonly T[],
  input: Omit<GenerateRollNumberInput, "sequence">,
): T[] {
  return rows.map((row, index) => {
    if (row.rollNumberSource === "manual") return { ...row };
    const generated = generateRollNumber({ ...input, sequence: index + 1 });
    return { ...row, rollNumber: generated ?? "" };
  });
}
