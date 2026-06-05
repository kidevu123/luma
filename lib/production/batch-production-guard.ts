/** Production consumption rules for internal input lots (`batches` table).
 *
 * Customer-facing trace codes use finished lots / recall passport — not raw
 * input batch numbers. Nexus complaint flows should prefer finished-lot data.
 */

export type BatchProductionStatus =
  | "QUARANTINE"
  | "RELEASED"
  | "ON_HOLD"
  | "RECALLED"
  | "EXPIRED"
  | "DEPLETED";

export const DEFAULT_INTAKE_BATCH_STATUS = "RELEASED" as const;

export type IntakeBatchInitialStatus = "RELEASED" | "QUARANTINE";

export function isBatchAvailableForProduction(
  status: BatchProductionStatus,
): boolean {
  return status === "RELEASED";
}

/** Operator-facing block reason when production cannot consume a lot. */
export function batchProductionBlockReason(
  status: BatchProductionStatus,
  batchNumber?: string | null,
): string {
  const label = batchNumber ? `Lot ${batchNumber}` : "This lot";
  switch (status) {
    case "QUARANTINE":
      return `${label} is blocked for review. Release it or clear the block before production.`;
    case "ON_HOLD":
      return `${label} is on hold.`;
    case "RECALLED":
      return `${label} is recalled and cannot be used.`;
    case "EXPIRED":
      return `${label} is expired.`;
    case "DEPLETED":
      return `${label} has no quantity on hand.`;
    case "RELEASED":
      return "";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

/** Notes suggesting a real QA block — skip auto bulk release. */
const QA_BLOCK_NOTE_PATTERN =
  /\b(do not release|qa fail|failed qa|reject|rejected|blocked|hold|recall|contamin|damage|investigation)\b/i;

export function noteIndicatesQaBlock(notes: string | null | undefined): boolean {
  const trimmed = notes?.trim();
  if (!trimmed) return false;
  return QA_BLOCK_NOTE_PATTERN.test(trimmed);
}
