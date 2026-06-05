/**
 * Luma display conventions — plant timezone (EST/EDT) and kg for weights.
 * DB stores grams and UTC timestamps; UI always shows kg and America/New_York.
 */

import { formatGramsAsKg } from "@/lib/inbound/roll-weight";

/** Eastern Time — handles EST/EDT automatically. */
export const LUMA_TIMEZONE = "America/New_York" as const;

export function formatDateTimeEst(
  value: Date | string | number | null | undefined,
): string {
  if (value == null) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: LUMA_TIMEZONE,
    month: "numeric",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(d);
}

export function formatDateEst(
  value: Date | string | number | null | undefined,
): string {
  if (value == null) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: LUMA_TIMEZONE,
    month: "numeric",
    day: "numeric",
    year: "numeric",
  }).format(d);
}

/** Integer grams from DB → display kg (rolls are received in kg). */
export function formatWeightKg(
  grams: number | null | undefined,
): string {
  return formatGramsAsKg(grams);
}

/** Material used per machine cycle — always kg, never g. */
export function formatKgPerCycle(
  gramsPerCycle: number | null | undefined,
): string {
  if (gramsPerCycle == null || !Number.isFinite(gramsPerCycle)) return "—";
  const kg = gramsPerCycle / 1000;
  if (kg >= 0.01) return `${kg.toFixed(4)} kg/cycle`;
  return `${kg.toFixed(6)} kg/cycle`;
}

export function formatBlistersPerKg(
  gramsPerCycle: number | null | undefined,
): string {
  if (gramsPerCycle == null || gramsPerCycle <= 0) return "—";
  return `${(1000 / gramsPerCycle).toFixed(1)} blisters/kg`;
}
