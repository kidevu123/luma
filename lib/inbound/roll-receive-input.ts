// ROLL-INTAKE-NUMBER-INPUT-FIX-1 — text-field parsing for roll receive UX.
// Avoids type="number" wheel mutation and forced coercion while typing.

export const ROLL_COUNT_MIN = 1;
export const ROLL_COUNT_MAX = 250;

export type ParseOk<T> = { ok: true; value: T };
export type ParseErr = { ok: false; error: string };

export function parseRollCountInput(text: string): ParseOk<number> | ParseErr {
  const trimmed = text.trim();
  if (trimmed === "") {
    return {
      ok: false,
      error: `Enter the number of rolls (${ROLL_COUNT_MIN}–${ROLL_COUNT_MAX}).`,
    };
  }
  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      error: `Roll count must be a whole number (${ROLL_COUNT_MIN}–${ROLL_COUNT_MAX}).`,
    };
  }
  const n = Number.parseInt(trimmed, 10);
  if (n < ROLL_COUNT_MIN || n > ROLL_COUNT_MAX) {
    return {
      ok: false,
      error: `Roll count must be between ${ROLL_COUNT_MIN} and ${ROLL_COUNT_MAX}.`,
    };
  }
  return { ok: true, value: n };
}

/** Allow empty while typing; strip non-digits. */
export function sanitizeRollCountTyping(raw: string): string {
  return raw.replace(/\D/g, "");
}

export function parseDecimalKgInput(text: string): ParseOk<number> | ParseErr {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { ok: false, error: "Net weight is required." };
  }
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return { ok: false, error: "Enter weight in kg (e.g. 5.2, 8.75)." };
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, error: "Net weight must be greater than 0 kg." };
  }
  return { ok: true, value: n };
}

export function resizeRollRows<T>(prev: readonly T[], count: number, empty: () => T): T[] {
  const n = Math.min(Math.max(ROLL_COUNT_MIN, count), ROLL_COUNT_MAX);
  if (prev.length === n) return [...prev];
  if (prev.length < n) {
    return [...prev, ...Array.from({ length: n - prev.length }, empty)];
  }
  return prev.slice(0, n);
}
