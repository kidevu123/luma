// P2-QUEUE-1 — honest ETA. Median of recent same-product same-kind
// cycle times minus elapsed upstream time. Under five samples we say
// nothing rather than guessing (UpNextBag.etaMinutes stays null and the
// UI omits the line).
//
// Median, not mean: one bag that sat through a lunch break would drag a
// mean into fiction. Both functions are pure and take `now` as a
// parameter — nothing here reads the clock.

/** The smallest sample count we will publish a median from. Four bags is
 *  one operator's morning; it describes that morning, not the station. */
const MIN_SAMPLES = 5;

export function medianCycleMinutes(samples: readonly number[]): number | null {
  if (samples.length < MIN_SAMPLES) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? sorted[mid]
      : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return median ?? null;
}

export function etaMinutes(args: {
  medianMinutes: number | null;
  upstreamStartedAt: Date | null;
  now: Date;
}): number | null {
  if (args.medianMinutes == null || args.upstreamStartedAt == null) return null;
  const elapsedMin = (args.now.getTime() - args.upstreamStartedAt.getTime()) / 60_000;
  // Clamped at zero: a bag that has already run past the median is "any
  // moment now", never a negative countdown.
  return Math.max(0, Math.round(args.medianMinutes - elapsedMin));
}
