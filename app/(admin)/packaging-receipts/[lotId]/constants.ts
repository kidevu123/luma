// Plain TS constants for the cycle-count form. Lives outside the
// "use server" actions file because that file may only export async
// functions (Next 15 server-actions constraint).

export const ADJUST_REASON_OPTIONS = [
  "PHYSICAL_COUNT_CORRECTION",
  "SUPPLIER_SHORTAGE_DISCOVERED",
  "DAMAGED_PACKAGING",
  "MANUAL_ADJUSTMENT",
  "FOUND_INVENTORY",
  "DATA_CORRECTION",
  "OTHER",
] as const;

export type AdjustReason = (typeof ADJUST_REASON_OPTIONS)[number];

export const ADJUST_REASON_LABELS: Record<AdjustReason, string> = {
  PHYSICAL_COUNT_CORRECTION: "Physical count correction",
  SUPPLIER_SHORTAGE_DISCOVERED: "Supplier shortage discovered",
  DAMAGED_PACKAGING: "Damaged packaging",
  MANUAL_ADJUSTMENT: "Manual adjustment",
  FOUND_INVENTORY: "Found inventory",
  DATA_CORRECTION: "Data correction",
  OTHER: "Other",
};
