// DASHBOARD-PREDICTION-DATE-COPY-1 — calendar-aware owner prediction detail text.

export type DashboardPredictionCopyInput = {
  dailyAvg7: number;
  predictedExtra: number;
  businessDaysRemaining: number;
  /** 1=Mon … 7=Sun in company timezone */
  weekdayEt: number;
};

/** Plain operational detail line for the blue prediction panel. */
export function buildWeeklyPredictionDetail(
  input: DashboardPredictionCopyInput,
): string {
  const { dailyAvg7, predictedExtra, businessDaysRemaining, weekdayEt } =
    input;

  if (dailyAvg7 <= 0) {
    return "Limited recent finalize data — weekly prediction is directional only.";
  }

  const pace = `Pace is about ${dailyAvg7} bag${dailyAvg7 === 1 ? "" : "s"}/day`;

  if (weekdayEt >= 6) {
    return `${pace}. This week's Mon–Fri window is closed; totals update again Monday.`;
  }

  if (weekdayEt === 5 || businessDaysRemaining === 0) {
    return `${pace}. Today is the last production day in this weekly window — additional finalized bags today improve this week's total.`;
  }

  if (predictedExtra <= 0) {
    return `${pace} — on track for the current weekly projection.`;
  }

  const add = predictedExtra;

  // Mon–Wed: tomorrow is still before Friday — safe to mention the rest of the week.
  if (weekdayEt <= 3 && businessDaysRemaining >= 2) {
    return `${pace}. Steady output from tomorrow through Friday could add about ${add} more bag${add === 1 ? "" : "s"}.`;
  }

  // Thu: tomorrow is Friday (the target) — do not say "tomorrow … by Friday".
  return `${pace}. About ${add} more bag${add === 1 ? "" : "s"} expected by Friday if output holds steady.`;
}
