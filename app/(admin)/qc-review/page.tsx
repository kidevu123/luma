// QC-4 — Admin QC review page.
//
// Three sections:
//   1. Pending QC actions    — unresolved PACKAGING_DAMAGE_RETURN rows
//   2. Rework in flight      — REWORK_SENT with received_total < sent
//   3. Recent QC events      — last 50 events across all five types
//
// Two supervisor flows:
//   - Convert damage to scrap or rework from the pending list
//   - Correct any recent submission (replays original/corrected
//     values into SUBMISSION_CORRECTED, preserving accountable
//     employee from the original event)
//
// Accountability rendering is honest: "By {accountable_employee}" for
// the person responsible, "Entered by {entered_by_email}" for the
// supervisor/operator who actually pressed the button. The two are
// only ever the same when an admin acts as themselves on an ad-hoc
// scrap/correction.
//
// Material decrement on scrap stays deferred to QC-5. Genealogy /
// operator productivity / PT-6 surfaces are not touched here.

import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-guards";
import { PageHeader, EmptyState, StatusPill } from "@/components/ui/page-header";
import { ProductionSection } from "@/components/production/ui";
import { ShieldAlert, Inbox, Activity } from "lucide-react";
import {
  loadPendingDamage,
  loadReworkInFlight,
  loadRecentQcEvents,
} from "@/lib/production/qc-review-loaders";
import { DamageActionsRow } from "./_damage-actions-row";
import { ReceiveReworkRow } from "./_receive-rework-row";
import { CorrectionTrigger } from "./_correction-trigger";

export const dynamic = "force-dynamic";

const QC_EVENT_LABELS: Record<string, string> = {
  PACKAGING_DAMAGE_RETURN: "Damage return",
  REWORK_SENT: "Rework sent",
  REWORK_RECEIVED: "Rework received",
  SCRAP_RECORDED: "Scrap recorded",
  SUBMISSION_CORRECTED: "Submission corrected",
};

const QC_EVENT_PILL: Record<string, "warn" | "info" | "danger" | "neutral"> = {
  PACKAGING_DAMAGE_RETURN: "warn",
  REWORK_SENT: "info",
  REWORK_RECEIVED: "info",
  SCRAP_RECORDED: "danger",
  SUBMISSION_CORRECTED: "neutral",
};

export default async function QcReviewPage() {
  await requireAdmin();

  const [pending, reworkInFlight, recent] = await Promise.all([
    loadPendingDamage(db, { limit: 200 }),
    loadReworkInFlight(db, { limit: 200 }),
    loadRecentQcEvents(db, { limit: 50 }),
  ]);

  return (
    <div>
      <PageHeader
        title="QC review"
        description="Unresolved damage, in-flight rework, and recent QC events. Convert damage to scrap or rework; correct any submission. Accountable employee on each event is preserved from the original; supervisor is recorded separately."
      />

      <ProductionSection
        title="Pending QC actions"
        subtitle={`${pending.length} unresolved damage event${pending.length === 1 ? "" : "s"}`}
        tone={pending.length > 0 ? "WARN" : "MUTED"}
        className="mb-8"
      >
        {pending.length === 0 ? (
          <EmptyState
            icon={ShieldAlert}
            title="No pending QC actions"
            description="Damage events from the floor will appear here once an operator reports one."
          />
        ) : (
          <ul className="space-y-2">
            {pending.map((row) => (
              <li
                key={row.id}
                className="rounded-xl border border-amber-200 bg-amber-50/60 p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1 text-sm">
                    <div className="flex items-baseline gap-2">
                      <StatusPill kind="warn">{row.reasonCode}</StatusPill>
                      <span className="font-semibold">
                        {row.quantity} {row.unit || "units"}
                      </span>
                      <span className="text-xs text-text-muted">
                        {row.occurredAt.toLocaleString()}
                      </span>
                    </div>
                    <p className="text-xs text-text-muted">
                      Bag <span className="font-mono">{row.workflowBagId.slice(0, 8)}</span>
                      {row.stationLabel ? ` · ${row.stationLabel}` : ""}
                      {row.machineName ? ` · ${row.machineName}` : ""}
                      {row.productSku ? ` · ${row.productSku}` : ""}
                    </p>
                    <p className="text-xs">
                      <span className="text-text-muted">By </span>
                      <span className="font-semibold">
                        {row.accountableEmployeeName ?? "unattributed"}
                      </span>
                      <span className="text-text-muted">
                        {" · entered by "}
                        {row.enteredByEmail ?? "floor PWA"}
                      </span>
                    </p>
                    {row.dispositionSuggestion ? (
                      <p className="text-[11px] text-text-muted">
                        Operator suggested:{" "}
                        <span className="font-semibold">{row.dispositionSuggestion}</span>
                      </p>
                    ) : null}
                    {row.notes ? (
                      <p className="text-[11px] text-text-muted italic">
                        “{row.notes}”
                      </p>
                    ) : null}
                  </div>
                  <DamageActionsRow
                    eventId={row.id}
                    workflowBagId={row.workflowBagId}
                    quantity={row.quantity}
                    unit={row.unit || "cards"}
                    reasonCode={row.reasonCode || "BAD_SEAL"}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </ProductionSection>

      <ProductionSection
        title="Rework in flight"
        subtitle={`${reworkInFlight.length} open rework${reworkInFlight.length === 1 ? "" : "s"}`}
        tone={reworkInFlight.length > 0 ? "INFO" : "MUTED"}
        className="mb-8"
      >
        {reworkInFlight.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="No rework in flight"
            description="REWORK_SENT events will appear here until received quantity matches sent quantity."
          />
        ) : (
          <ul className="space-y-2">
            {reworkInFlight.map((row) => (
              <li
                key={row.id}
                className="rounded-xl border border-sky-200 bg-sky-50/60 p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1 text-sm">
                    <div className="flex items-baseline gap-2">
                      <StatusPill kind="info">{row.reasonCode || "REWORK"}</StatusPill>
                      <span className="font-semibold">
                        {row.receivedQuantity} / {row.sentQuantity}{" "}
                        {row.unit || "units"} received · {row.remainingQuantity} remaining
                      </span>
                      <span className="text-xs text-text-muted">
                        {row.occurredAt.toLocaleString()}
                      </span>
                    </div>
                    <p className="text-xs text-text-muted">
                      Bag <span className="font-mono">{row.workflowBagId.slice(0, 8)}</span>
                      {row.fromStationLabel ? ` · from ${row.fromStationLabel}` : ""}
                      {row.toStationLabel ? ` → ${row.toStationLabel}` : ""}
                    </p>
                    <p className="text-xs">
                      <span className="text-text-muted">By </span>
                      <span className="font-semibold">
                        {row.accountableEmployeeName ?? "unattributed"}
                      </span>
                      <span className="text-text-muted">
                        {" · entered by "}
                        {row.enteredByEmail ?? "floor PWA"}
                      </span>
                    </p>
                  </div>
                  <ReceiveReworkRow
                    linkedEventId={row.id}
                    sentQuantity={row.sentQuantity}
                    priorReceivedSum={row.receivedQuantity}
                    remaining={row.remainingQuantity}
                    unit={row.unit || "cards"}
                    reasonCode={row.reasonCode || "BAD_SEAL"}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </ProductionSection>

      <ProductionSection
        title="Recent QC events"
        subtitle={`last ${recent.length}`}
        className="mb-8"
      >
        {recent.length === 0 ? (
          <EmptyState
            icon={Activity}
            title="No QC events yet"
            description="Once damage, rework, scrap, or correction events fire, they appear here newest-first."
          />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-xs">
              <thead className="bg-surface-2/60 text-[11px] uppercase tracking-wide text-text-subtle">
                <tr>
                  <th className="px-3 py-2 text-left">When</th>
                  <th className="px-3 py-2 text-left">Event</th>
                  <th className="px-3 py-2 text-left">Bag</th>
                  <th className="px-3 py-2 text-left">Qty</th>
                  <th className="px-3 py-2 text-left">Reason</th>
                  <th className="px-3 py-2 text-left">Accountable</th>
                  <th className="px-3 py-2 text-left">Entered by</th>
                  <th className="px-3 py-2 text-left">Linked</th>
                  <th className="px-3 py-2 text-left">Actions</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((row) => (
                  <tr key={row.id} className="border-t border-border/60">
                    <td className="px-3 py-2 align-top text-text-muted">
                      {row.occurredAt.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <StatusPill kind={QC_EVENT_PILL[row.eventType] ?? "neutral"}>
                        {QC_EVENT_LABELS[row.eventType] ?? row.eventType}
                      </StatusPill>
                    </td>
                    <td className="px-3 py-2 align-top font-mono">
                      {row.workflowBagId.slice(0, 8)}
                    </td>
                    <td className="px-3 py-2 align-top">
                      {row.quantity != null ? `${row.quantity} ${row.unit ?? ""}` : "—"}
                    </td>
                    <td className="px-3 py-2 align-top">{row.reasonCode ?? "—"}</td>
                    <td className="px-3 py-2 align-top">
                      {row.accountableEmployeeName ?? "—"}
                    </td>
                    <td className="px-3 py-2 align-top">
                      {row.enteredByEmail ?? "—"}
                    </td>
                    <td className="px-3 py-2 align-top font-mono text-text-subtle">
                      {row.linkedEventId ? row.linkedEventId.slice(0, 8) : "—"}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <CorrectionTrigger
                        eventId={row.id}
                        eventType={row.eventType}
                        originalValueJson={JSON.stringify({
                          quantity: row.quantity,
                          unit: row.unit,
                          reason_code: row.reasonCode,
                          linked_event_id: row.linkedEventId,
                        })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ProductionSection>

      <p className="text-[11px] text-text-subtle">
        Material decrement on scrap (with affects_packaging_material + material_lot_id)
        lands in QC-5. Genealogy and operator-productivity QC columns also QC-5.
        Photo capture deferred — text notes only.
      </p>
    </div>
  );
}
