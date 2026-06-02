import {
  floorReadinessBadgeClass,
  floorReadinessLabel,
  type FloorReadinessEvaluation,
} from "@/lib/production/floor-readiness";

export function FloorReadinessBadge({
  evaluation,
  showAction = false,
}: {
  evaluation: FloorReadinessEvaluation;
  showAction?: boolean;
}) {
  return (
    <div className="space-y-1">
      <span
        className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium ${floorReadinessBadgeClass(evaluation)}`}
      >
        {floorReadinessLabel(evaluation)}
      </span>
      {showAction && evaluation.adminAction ? (
        <p className="text-xs text-text-muted max-w-xs">{evaluation.adminAction}</p>
      ) : null}
    </div>
  );
}
