// Floor station landing — what an operator sees on a tablet at a
// production station after scanning the station QR. The URL token is the
// station's scan_token (cryptographic identifier; rotated from
// /machines admin).
//
// P4b Task 5 — THE CUTOVER. This file used to run roughly fifteen
// sequential resolution queries (fresh cards, eligible pickups, started
// resumes, partial packaging resumes, sealing-final-close bags, sealing
// segment state, product mapping, tablet compatibility, packaging BOMs,
// station prerequisites, active rolls, idle roll lots, QC/rework,
// allocations, timers) and rendered every one of those concepts as its
// own panel. All of it was the state machine leaking onto the tablet.
//
// It is now: resolve the station, ONE engine read (getStationView), and
// one component that renders the engine's NextAction. Every decision —
// what to show, which fields to ask for, why the operator is stuck —
// belongs to lib/production/engine. Anything this file re-derives would
// be a second answer to a question the engine has already answered.
//
// What deliberately survives the cutover:
//   FloorLiveRefresh   — mounted on BOTH branches, including the
//                        inactive-station one, so a station re-activated
//                        from /machines recovers on its own instead of
//                        stranding a tablet on a dead screen.
//   IdleOperatorGuard  — OP-1C shift hygiene, unchanged.
//   ReportProblem      — Task 4's single exception workflow, passed as a
//                        REQUIRED prop.
//   QcPanel            — QC-3 plus [ Release hold ], the only escape
//                        from a QA hold. Surfaced under More; P5 moves
//                        it behind supervisor unlock wholesale.
// The rolls page keeps its More-sheet link today (operatorMaterialLinks
// / floorSupervisorToolsForStation returns exactly one entry — "rolls"
// — and only at BLISTER / COMBINED). Bag-allocation and variety-pack
// entry points are NOT surfaced from More right now; they still live on
// their own admin routes. If those sub-flows need floor entry points
// again, extend floorSupervisorToolsForStation — this file already
// renders whatever it returns.

import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { stations, workflowEvents } from "@/lib/db/schema";
import { eq, and, inArray, sql, desc } from "drizzle-orm";
import {
  getStationView,
  resolveStationByToken,
  STATION_INACTIVE_FLOOR_MESSAGE,
  getActiveStationSession,
  shouldRenderQcPanel,
} from "@/lib/production/engine";
import { FloorLiveRefresh } from "./floor-live-refresh";
import { IdleOperatorGuard } from "./idle-operator-guard";
import { OperatorScreen } from "./operator-screen";
import { QcPanel, type PendingReworkRow } from "./qc-panel";
import { ReportProblem } from "./report-problem";
import { listActiveEmployeeOptions } from "./operator-session-actions";

export const dynamic = "force-dynamic";

export default async function FloorStationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const station = await resolveStationByToken(token);
  if (!station) notFound();

  if (!station.isActive) {
    // FloorLiveRefresh here is not decoration. A station deactivated by
    // mistake is re-activated from /machines, and without a subscriber
    // this tablet would sit on the dead screen until somebody walked
    // over and pulled to refresh. The stream 404s while the station is
    // inactive, which the component treats like any other failure: it
    // falls back to 60s polling and retries SSE on the same cadence, so
    // the screen recovers within about a minute of re-activation.
    return (
      <main className="min-h-dvh bg-surface flex flex-col items-center justify-center p-6 text-center">
        <FloorLiveRefresh token={token} />
        <h1 className="text-xl font-semibold text-text mb-2">{station.label}</h1>
        <p className="text-sm text-text-muted max-w-md">
          {STATION_INACTIVE_FLOOR_MESSAGE}
        </p>
        <p className="text-xs text-text-subtle mt-4">{station.kind}</p>
      </main>
    );
  }

  const [view, employeeOptions, activeSession] = await Promise.all([
    getStationView(station.id),
    listActiveEmployeeOptions(),
    getActiveStationSession(db, station.id),
  ]);

  const currentBagId = view.current?.workflowBagId ?? null;
  // read_bag_state.is_on_hold, taken from the view's own blockers rather
  // than a second query: evaluateChecks already turned that column into
  // the BAG_ON_HOLD blocker, and re-reading the row could disagree with
  // the screen the operator is looking at.
  const isOnHold =
    view.nextAction.kind === "BLOCKED" &&
    view.nextAction.blockers.some((b) => b.code === "BAG_ON_HOLD");

  const qcPanel =
    shouldRenderQcPanel(station.kind) && currentBagId ? (
      <QcPanel
        token={token}
        stationId={station.id}
        stationKind={station.kind}
        workflowBagId={currentBagId}
        currentOperatorName={view.operator?.name ?? null}
        accountabilitySource={activeSession?.accountabilitySource ?? null}
        pendingRework={await loadPendingRework(currentBagId)}
        isOnHold={isOnHold}
      />
    ) : null;

  return (
    <>
      <FloorLiveRefresh token={token} />
      {view.operator ? (
        <IdleOperatorGuard token={token} stationId={station.id} />
      ) : null}
      <OperatorScreen
        view={view}
        token={token}
        employeeOptions={employeeOptions}
        activeSession={activeSession}
        reportProblem={
          <ReportProblem
            token={token}
            stationId={station.id}
            workflowBagId={currentBagId}
          />
        }
        qcPanel={qcPanel}
      />
    </>
  );
}

/** QC-3 — pending REWORK_SENT events for the current bag that have
 *  not yet been fully received. "Pending" today = any REWORK_SENT
 *  for this bag with no paired REWORK_RECEIVED row (full or partial
 *  doesn't matter — QC-3 only surfaces "Mark fully received"; partial
 *  receive lands in QC-4). The receiving station's operator marks
 *  them received from the QC panel.
 *
 *  Kept in this file across the cutover, unchanged: it feeds the ONE
 *  legacy panel the cutover keeps, and moving it into the engine would
 *  put a QC concern in the production engine's contract for no gain. */
async function loadPendingRework(workflowBagId: string): Promise<PendingReworkRow[]> {
  const sent = await db
    .select({
      id: workflowEvents.id,
      occurredAt: workflowEvents.occurredAt,
      payload: workflowEvents.payload,
      stationId: workflowEvents.stationId,
    })
    .from(workflowEvents)
    .where(
      and(
        eq(workflowEvents.workflowBagId, workflowBagId),
        eq(workflowEvents.eventType, "REWORK_SENT"),
      ),
    )
    .orderBy(desc(workflowEvents.occurredAt));
  if (sent.length === 0) return [];

  // Any REWORK_SENT whose id appears in a REWORK_RECEIVED's
  // payload->>linked_event_id is considered fully received for QC-3
  // purposes. Partial receives that don't fully close the sent
  // quantity are intentionally out of QC-3 scope — they'd show as
  // "received" here even if a remainder remains. QC-4 surfaces the
  // remainder math.
  const receivedRows = (await db.execute(
    sql`SELECT payload->>'linked_event_id' AS linked_id
        FROM workflow_events
        WHERE workflow_bag_id = ${workflowBagId}
          AND event_type = 'REWORK_RECEIVED'
          AND payload ? 'linked_event_id'`,
  )) as unknown as Array<{ linked_id: string }>;
  const receivedSet = new Set(receivedRows.map((r) => r.linked_id));

  // Resolve from-station labels in one round trip.
  const stationIds = Array.from(
    new Set(sent.map((r) => r.stationId).filter((x): x is string => x != null)),
  );
  const stationRows =
    stationIds.length === 0
      ? []
      : await db
          .select({ id: stations.id, label: stations.label })
          .from(stations)
          .where(inArray(stations.id, stationIds));
  const stationLabel = new Map(stationRows.map((s) => [s.id, s.label]));

  return sent
    .filter((row) => !receivedSet.has(row.id))
    .map((row) => {
      const p = (row.payload ?? {}) as Record<string, unknown>;
      const qty = Number(p.quantity ?? 0);
      const unit = typeof p.unit === "string" ? p.unit : "cards";
      const reasonCode =
        typeof p.reason_code === "string" ? p.reason_code : "OTHER";
      const accountableEmployeeName =
        typeof p.accountable_employee_name_snapshot === "string"
          ? p.accountable_employee_name_snapshot
          : null;
      return {
        id: row.id,
        occurredAt: new Date(row.occurredAt as unknown as string).toISOString(),
        quantity: qty,
        unit,
        reasonCode,
        fromStationLabel:
          row.stationId != null ? stationLabel.get(row.stationId) ?? null : null,
        accountableEmployeeName,
      };
    });
}
