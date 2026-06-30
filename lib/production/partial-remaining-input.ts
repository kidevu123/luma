// P2-PARTIAL-KEEP — safe coercion for the OPTIONAL operator "tablets remaining"
// estimate captured at bottle packaging close-out.
//
// This value is optional and purely informational (a rough note for the next
// operator); it must NEVER block the packaging close-out. A `type="number"`
// input can still yield strings like "1.5", "1e3", "-2", or "abc", and the
// previous `z.coerce.number().int().min(0)` schema turned any such value into a
// validation failure that rejected the ENTIRE close-out submit. This helper is
// the single source of truth used by both the floor client (before submit) and
// the server action (via z.preprocess): it returns a floored non-negative
// integer in range, or undefined for anything blank / invalid / out of range —
// so a bad estimate is silently dropped instead of failing the run close.

export const PARTIAL_REMAINING_MAX = 100_000;

export function coercePartialRemainingEstimate(
  value: unknown,
): number | undefined {
  if (value == null) return undefined;
  const raw = typeof value === "string" ? value.trim() : value;
  if (raw === "") return undefined;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
  const floored = Math.floor(n);
  if (floored < 0 || floored > PARTIAL_REMAINING_MAX) return undefined;
  return floored;
}
