import type { PoCloseoutRowStatus, PoCloseoutOverallStatus } from "@/lib/production/po-closeout";
import { StatusPill } from "@/components/ui/page-header";

const ROW: Record<PoCloseoutRowStatus, { kind: "ok" | "warn" | "danger" | "neutral" | "info"; label: string }> = {
  DONE: { kind: "ok", label: "Done" },
  READY_FOR_ACTION: { kind: "info", label: "Ready for action" },
  NEEDS_REVIEW: { kind: "warn", label: "Needs review" },
  BLOCKED: { kind: "danger", label: "Blocked" },
};

const OVERALL: Record<PoCloseoutOverallStatus, { kind: "ok" | "warn" | "danger" | "neutral" | "info"; label: string }> = {
  DONE: { kind: "ok", label: "Done" },
  ACTION_READY: { kind: "info", label: "Action ready" },
  NEEDS_REVIEW: { kind: "warn", label: "Needs review" },
  BLOCKED: { kind: "danger", label: "Blocked" },
};

export function RowStatusBadge({ status }: { status: PoCloseoutRowStatus }) {
  const m = ROW[status];
  return <StatusPill kind={m.kind}>{m.label}</StatusPill>;
}

export function OverallStatusBadge({ status }: { status: PoCloseoutOverallStatus }) {
  const m = OVERALL[status];
  return <StatusPill kind={m.kind}>{m.label}</StatusPill>;
}
