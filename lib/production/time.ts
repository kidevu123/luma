// Date-range helpers for the metric API. Centralised so callers
// don't independently calculate "today" and disagree by a TZ.
//
// Convention: ranges are half-open [from, to). Default tz is UTC
// (the DB stores timestamptz everywhere). Callers needing a
// company-tz "today" pass an IANA tz name; we convert via
// Intl.DateTimeFormat.

import type { DateRange } from "./types";

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/** Today's [00:00, 24:00) in the given IANA timezone. Defaults to
 *  the company tz wired in by the caller; we fall back to UTC if
 *  the caller is reading from a context with no company config. */
export function todayRange(tz = "UTC"): DateRange {
  const now = new Date();
  const ymd = ymdInTz(now, tz);
  const from = new Date(`${ymd}T00:00:00Z`);
  const to = new Date(from.getTime() + MS_PER_DAY);
  return { from, to };
}

/** Last-N-days range, inclusive of today, exclusive end. */
export function lastNDays(days: number, tz = "UTC"): DateRange {
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error("lastNDays: days must be a positive integer");
  }
  const today = todayRange(tz);
  const from = new Date(today.to.getTime() - days * MS_PER_DAY);
  return { from, to: today.to };
}

/** Format a Date as YYYY-MM-DD in the given IANA tz. Locale-stable
 *  via en-CA (always YYYY-MM-DD). */
export function ymdInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
}

/** Difference in seconds between two timestamps, or null if either
 *  is missing. */
export function diffSeconds(a: Date | null, b: Date | null): number | null {
  if (!a || !b) return null;
  return Math.max(0, Math.floor((b.getTime() - a.getTime()) / 1000));
}

/** Format a duration in seconds as "Xh Ym" or "Xm Ys" — used for
 *  display strings inside MetricResult.value when a number isn't
 *  the right unit. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s === 0 ? `${m}m` : `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm === 0 ? `${h}h` : `${h}h ${mm}m`;
}

/** Hours between two timestamps as a fractional number — used by
 *  units-per-hour math. Returns null when input is missing. */
export function diffHours(a: Date | null, b: Date | null): number | null {
  const s = diffSeconds(a, b);
  return s == null ? null : s / 3600;
}

export const TIME_CONSTANTS = {
  MS_PER_HOUR,
  MS_PER_DAY,
} as const;
