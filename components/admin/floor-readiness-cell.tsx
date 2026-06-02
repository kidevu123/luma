import {
  floorReadinessAdminLabel,
  floorReadinessBadgeClass,
  floorReadinessDetailLines,
  type FloorReadinessEvaluation,
} from "@/lib/production/floor-readiness";

export function FloorReadinessCell({
  evaluation,
  showAdminAction = false,
}: {
  evaluation: FloorReadinessEvaluation;
  /** Show primary adminAction from evaluator when set. */
  showAdminAction?: boolean;
}) {
  const details = floorReadinessDetailLines(evaluation);
  return (
    <div className="space-y-1 max-w-[220px]">
      <span
        className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium ${floorReadinessBadgeClass(evaluation)}`}
      >
        {floorReadinessAdminLabel(evaluation)}
      </span>
      {evaluation.level === "READY_FOR_FLOOR" && details.readyDetail ? (
        <p className="text-[11px] text-text-muted leading-snug">
          {details.readyDetail}
        </p>
      ) : null}
      {details.blocked.length > 0 ? (
        <ul className="text-[11px] text-red-800 leading-snug list-disc pl-3.5 space-y-0.5">
          {details.blocked.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {details.warnings.length > 0 ? (
        <ul className="text-[11px] text-amber-900 leading-snug list-disc pl-3.5 space-y-0.5">
          {details.warnings.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {showAdminAction && evaluation.adminAction ? (
        <p className="text-[11px] text-text-muted leading-snug">
          {evaluation.adminAction}
        </p>
      ) : null}
    </div>
  );
}
