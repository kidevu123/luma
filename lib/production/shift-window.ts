/** Client-safe shift window helpers (no DB). */

export const SHIFT_START_HOUR = 6; // 06:00 local
export const SHIFT_END_HOUR = 16; // 16:00 local (10-hour shift)

export function computeShiftProgress(
  now: Date,
  tz: string,
): {
  minutesElapsed: number;
  minutesRemaining: number;
  shiftStartUtc: Date;
} {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(now).map((p) => [p.type, p.value]),
  );
  const localDate = `${parts["year"]}-${parts["month"]}-${parts["day"]}`;
  const shiftStartLocal = new Date(
    `${localDate}T${String(SHIFT_START_HOUR).padStart(2, "0")}:00:00`,
  );
  const shiftEndLocal = new Date(
    `${localDate}T${String(SHIFT_END_HOUR).padStart(2, "0")}:00:00`,
  );
  const offsetMs =
    now.getTime() -
    new Date(now.toLocaleString("en-US", { timeZone: tz })).getTime();
  const shiftStartUtc = new Date(shiftStartLocal.getTime() - offsetMs);
  const shiftEndUtc = new Date(shiftEndLocal.getTime() - offsetMs);

  const elapsed = Math.max(
    0,
    Math.floor((now.getTime() - shiftStartUtc.getTime()) / 60000),
  );
  const remaining = Math.max(
    0,
    Math.floor((shiftEndUtc.getTime() - now.getTime()) / 60000),
  );

  return { minutesElapsed: elapsed, minutesRemaining: remaining, shiftStartUtc };
}
