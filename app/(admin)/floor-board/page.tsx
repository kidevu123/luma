// Phase E — Luma Production Command Center.
//
// Single source of truth: lib/production/metrics.ts. UI computes
// nothing; it formats values and arranges them. Honest by default —
// every metric flows through MetricResult, every empty surfaces with
// the canonical missing-data label.
//
// The legacy 12-tile strip + lifeline cards live at
// _legacy-page.tsx.bak for rollback. Components in _components/ are
// dead code on disk; nothing imports them now.

import Link from "next/link";
import { db } from "@/lib/db";
import { eq, desc, isNotNull, and, isNull } from "drizzle-orm";
import {
  machines,
  stations,
  workflowBags,
  readBagState,
  readMaterialReconciliation,
  products,
} from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import {
  deriveDashboardMetrics,
  deriveBottleneck,
  deriveQueueAging,
  deriveMachineMetrics,
  derivePackagingMetrics,
  deriveDamageAndReworkMetrics,
  deriveBagGenealogy,
} from "@/lib/production/metrics";
import {
  deriveWorkflowHealth,
  deriveActivitySignals,
  deriveBlockedMetrics,
} from "@/lib/production/diagnostics";
import { todayRange } from "@/lib/production/time";
import { MetricCard } from "@/components/production/metric-card";
import { ConfidenceBadge } from "@/components/production/confidence-badge";
import { MissingState } from "@/components/production/missing-state";
import { LiveRefresh } from "./live-refresh";
import {
  type StageKey,
  type MetricResult,
  STAGE_KEYS,
} from "@/lib/production/types";
import { ok } from "@/lib/production/confidence";

export const dynamic = "force-dynamic";

// Process map — two lanes laid out as the floor walks them. Each
// node renders a stage's queue snapshot; the order is the order
// bags travel.
const CARD_LANE: ReadonlyArray<{ key: StageKey; label: string }> = [
  { key: "BLISTER_QUEUE", label: "Blister" },
  { key: "POST_BLISTER_STAGING", label: "Post-blister stage" },
  { key: "SEALING_QUEUE", label: "Sealing" },
  { key: "POST_SEAL_STAGING", label: "Post-seal stage" },
  { key: "PACKAGING_QUEUE", label: "Packaging" },
  { key: "FINISHED_GOODS_QUEUE", label: "Finished goods" },
];

const BOTTLE_LANE: ReadonlyArray<{ key: StageKey; label: string }> = [
  { key: "BOTTLE_FILL_QUEUE", label: "Bottle filling" },
  { key: "BOTTLE_STICKER_QUEUE", label: "Stickering" },
  { key: "BOTTLE_INDUCTION_QUEUE", label: "Induction sealing" },
  { key: "FINISHED_GOODS_QUEUE", label: "Finished goods" },
];

export default async function FloorBoardPage() {
  await requireSession();

  // Pull every panel's data in parallel. All reads go through the
  // metric API or simple lookups for visual scaffolding (machine
  // names, recent bag IDs).
  const [
    dashboard,
    bottleneck,
    queues,
    packaging,
    damage,
    machinesList,
    recentActiveBag,
    reconAlerts,
    health,
    activity,
    blocked,
  ] = await Promise.all([
    deriveDashboardMetrics(),
    deriveBottleneck(),
    deriveQueueAging(),
    derivePackagingMetrics(),
    deriveDamageAndReworkMetrics(),
    db
      .select({
        id: machines.id,
        name: machines.name,
        kind: machines.kind,
      })
      .from(machines)
      .orderBy(machines.name),
    db
      .select({
        id: readBagState.workflowBagId,
        productName: products.name,
        productSku: products.sku,
        stage: readBagState.stage,
        currentOperator: readBagState.currentOperatorCode,
        lastEventAt: readBagState.lastEventAt,
      })
      .from(readBagState)
      .leftJoin(products, eq(products.id, readBagState.productId))
      .where(
        and(
          eq(readBagState.isFinalized, false),
          isNotNull(readBagState.lastEventAt),
        ),
      )
      .orderBy(desc(readBagState.lastEventAt))
      .limit(1),
    db
      .select({
        bagId: readMaterialReconciliation.workflowBagId,
        variancePct: readMaterialReconciliation.variancePct,
        varianceQty: readMaterialReconciliation.varianceQty,
        isEstimated: readMaterialReconciliation.isEstimated,
        productName: products.name,
      })
      .from(readMaterialReconciliation)
      .leftJoin(workflowBags, eq(workflowBags.id, readMaterialReconciliation.workflowBagId))
      .leftJoin(products, eq(products.id, workflowBags.productId))
      .orderBy(desc(readMaterialReconciliation.updatedAt))
      .limit(50),
    deriveWorkflowHealth(),
    deriveActivitySignals(),
    deriveBlockedMetrics(),
  ]);

  // Pull live machine snapshots in parallel — one round trip per
  // machine, but bounded (10 or so) and used for the wall.
  const machineSnapshots = await Promise.all(
    machinesList.map(async (m) => ({
      machine: m,
      metrics: await deriveMachineMetrics(m.id),
    })),
  );

  // Bag genealogy preview pulls only the most recently active bag's
  // event timeline. If no bag in flight, render the empty-state.
  const genealogy = recentActiveBag[0]
    ? await deriveBagGenealogy(recentActiveBag[0].id)
    : null;

  const today = todayRange();
  const fmtTime = (d: Date) =>
    d.toISOString().replace("T", " ").slice(0, 19) + " UTC";

  // Recon alert thresholds (pure UI filter on a live read).
  const highVariance = reconAlerts.filter(
    (r) => Math.abs(Number(r.variancePct ?? 0)) > 5,
  );
  const estimatedRows = reconAlerts.filter((r) => r.isEstimated).slice(0, 8);

  return (
    <div className="space-y-4 -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8 py-4 bg-slate-950 min-h-dvh text-slate-200">
      {/* HEADER */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-slate-100">
            Luma — Production Command Center
          </h1>
          <p className="text-[11px] text-slate-500">
            Source: lib/production/metrics.ts · Window: today {today.from.toISOString().slice(0, 10)} UTC
          </p>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-slate-400">
          <ConfidenceBadge confidence="HIGH" />
          <span>Last refresh: {fmtTime(new Date())}</span>
          <LiveRefresh />
        </div>
      </header>

      {/* WORKFLOW HEALTH — diagnostic strip. Surfaces the gap
          between activity and finalization. Always visible. */}
      <section aria-label="Workflow health">
        <SectionHeader
          title="Workflow health"
          subtitle={
            health.lastEventAt
              ? `Last event ${new Date(health.lastEventAt).toISOString().replace("T", " ").slice(0, 19)} UTC`
              : "No events recorded yet"
          }
        />
        <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
          <DiagTile label="Total events" value={health.totalEvents} accent="default" />
          <DiagTile label="Total bags" value={health.totalBags} accent="default" />
          <DiagTile label="Active" value={health.activeBags} accent="default" />
          <DiagTile
            label="Finalized"
            value={health.finalizedBags}
            accent={health.finalizedBags === 0 && health.totalBags > 0 ? "rose" : "default"}
          />
          <DiagTile
            label="Missing finalize"
            value={health.bagsMissingFinalization}
            accent={health.bagsMissingFinalization > 0 ? "amber" : "default"}
          />
          <DiagTile
            label="Completion rate"
            value={
              health.completionRatePct == null
                ? "—"
                : `${health.completionRatePct}%`
            }
            accent={
              health.completionRatePct != null && health.completionRatePct < 50
                ? "rose"
                : "default"
            }
          />
          <DiagTile
            label="Operator capture"
            value={
              health.activeBags === 0
                ? "—"
                : `${health.operatorCodeCaptureCount} / ${health.activeBags}`
            }
            accent={
              health.activeBags > 0 && health.operatorCodeCaptureCount === 0
                ? "rose"
                : "default"
            }
          />
        </div>
        <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
          <DiagTile label="Stuck @ start" value={health.bagsStuckAtStart} accent="amber" />
          <DiagTile label="Stuck @ blister" value={health.bagsStuckAtBlister} accent="amber" />
          <DiagTile label="Stuck @ seal" value={health.bagsStuckAtSeal} accent="amber" />
          <DiagTile label="Packaged, not finalized" value={health.bagsPackagedNotFinalized} accent="amber" />
          <DiagTile label="Force releases" value={health.forceReleaseCount} />
          <DiagTile label="Submission corrections" value={health.submissionCorrectionCount} />
          <DiagTile label="Paused bags" value={health.pausedBags} />
        </div>
      </section>

      {/* WHY ARE METRICS EMPTY? — only shows when activity exists
          but no bags have finalized. This is a diagnostic, not a
          status report. The wording is intentionally direct. */}
      {health.totalEvents > 0 && health.finalizedBags === 0 && (
        <section
          aria-label="Why are metrics empty"
          className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3"
        >
          <h2 className="text-[11px] uppercase tracking-[0.10em] text-amber-300 font-semibold">
            Why are output metrics empty?
          </h2>
          <p className="mt-1.5 text-[13px] text-amber-100 leading-relaxed">
            Production activity exists ({health.totalEvents} events across{" "}
            {health.totalBags} bags), but <strong>no bags have reached BAG_FINALIZED</strong>.
            Output metrics (good units, displays, cases, yield, OEE,
            material reconciliation) are blocked until bags are finalized
            on the floor or until legacy activity is mapped into canonical
            completion states via the legacy synthesizer.
          </p>
          <p className="mt-1.5 text-[12px] text-amber-200/80">
            Action: complete the full floor flow on the station —{" "}
            <span className="font-mono">CARD_ASSIGNED → BLISTER_COMPLETE → SEALING_COMPLETE → PACKAGING_COMPLETE → BAG_FINALIZED</span>.
            The Finalize button on the packaging station fires
            BAG_FINALIZED, which writes read_bag_metrics and unlocks
            every output KPI.
          </p>
        </section>
      )}

      {/* BLOCKED METRICS — list every blocked KPI, why, and what to do. */}
      {blocked.length > 0 && (
        <section aria-label="Blocked metrics">
          <SectionHeader
            title="Blocked metrics"
            subtitle={`${blocked.length} KPI${blocked.length === 1 ? "" : "s"} cannot compute today`}
          />
          <div className="mt-2 grid grid-cols-1 lg:grid-cols-2 gap-2">
            {blocked.map((b) => (
              <div
                key={b.metric}
                className="rounded-md border border-slate-700/60 bg-slate-900/60 p-3 space-y-1.5"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold text-slate-100">{b.metric}</h3>
                  <ConfidenceBadge confidence="MISSING" />
                </div>
                <p className="text-[12px] text-slate-400">{b.reason}</p>
                <div className="text-[11px] text-slate-500">
                  <strong className="text-slate-400">Missing:</strong>{" "}
                  {b.missing.join(", ") || "—"}
                </div>
                <div className="text-[11px] text-slate-500">
                  <strong className="text-slate-400">Action:</strong> {b.action}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ACTIVITY SIGNALS — raw event counts. NEVER reported as
          output / yield / OEE / good units. The label spells this
          out. */}
      <section aria-label="Activity signals">
        <SectionHeader
          title="Activity signals (last 30d)"
          subtitle="Raw scan counts. Never output, yield, or OEE."
        />
        <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
          <DiagTile label="Total events 30d" value={activity.totalEvents30d} accent="cyan" />
          <DiagTile label="Card assigns" value={activity.cardAssigned30d} />
          <DiagTile label="Blister scans" value={activity.blisterEvents30d} />
          <DiagTile label="Sealing scans" value={activity.sealingEvents30d} />
          <DiagTile
            label="Packaging snapshots"
            value={activity.packagingSnapshots30d}
          />
          <DiagTile
            label="Packaging complete"
            value={activity.packagingComplete30d}
          />
          <DiagTile label="Bag pauses" value={activity.bagPaused30d} />
          <DiagTile label="Bag resumes" value={activity.bagResumed30d} />
        </div>
        {activity.bottleHandpack30d +
          activity.bottleCapSeal30d +
          activity.bottleSticker30d >
          0 && (
          <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2">
            <DiagTile label="Bottle handpack" value={activity.bottleHandpack30d} />
            <DiagTile label="Bottle cap/seal" value={activity.bottleCapSeal30d} />
            <DiagTile label="Bottle sticker" value={activity.bottleSticker30d} />
          </div>
        )}
        {activity.lastEventByStation.length > 0 && (
          <div className="mt-2 rounded-md border border-slate-700/60 bg-slate-900/60 overflow-x-auto">
            <table className="min-w-full text-[12px]">
              <thead className="bg-slate-900 text-[10px] uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="text-left px-3 py-2">Station</th>
                  <th className="text-left px-3 py-2">Machine</th>
                  <th className="text-left px-3 py-2">Kind</th>
                  <th className="text-right px-3 py-2">Events 30d</th>
                  <th className="text-left px-3 py-2">Last activity</th>
                </tr>
              </thead>
              <tbody>
                {activity.lastEventByStation.slice(0, 10).map((s) => (
                  <tr key={s.stationId} className="border-t border-slate-800">
                    <td className="px-3 py-1.5 text-slate-200">
                      {s.stationLabel ?? s.stationId.slice(0, 8) + "…"}
                    </td>
                    <td className="px-3 py-1.5 text-slate-300">
                      {s.machineName ?? "—"}
                    </td>
                    <td className="px-3 py-1.5 text-slate-500 font-mono">
                      {s.machineKind ?? "—"}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-slate-300">
                      {s.eventCount30d}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-slate-500">
                      {s.lastEventAt.toISOString().replace("T", " ").slice(0, 19)} UTC
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* KPI STRIP */}
      <section aria-label="KPI strip" className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
        <MetricCard label="Bags in flow" metric={dashboard.bagsInFlow ?? FALLBACK} size="sm" />
        <MetricCard label="Good units today" metric={dashboard.goodUnitsToday ?? FALLBACK} size="sm" />
        <MetricCard label="Displays today" metric={dashboard.displaysToday ?? FALLBACK} size="sm" />
        <MetricCard label="Cases today" metric={dashboard.casesToday ?? FALLBACK} size="sm" />
        <MetricCard label="Oldest queue age" metric={dashboard.oldestQueueAgeMinutes ?? FALLBACK} size="sm" />
        <MetricCard label="Paused > 30m" metric={dashboard.pausedBagsOverThreshold ?? FALLBACK} size="sm" />
        <MetricCard label="Bottleneck" metric={bottleneck.stageKey} size="sm" />
        <MetricCard label="Schedule gap" metric={dashboard.scheduleGap ?? FALLBACK} size="sm" />
      </section>

      {/* PROCESS MAP — two lanes */}
      <section aria-label="Process map" className="space-y-3">
        <SectionHeader title="Process map" subtitle="Live queue snapshot — one row per stage" />
        <LaneRow lane="CARD" label="Card / blister route" stages={CARD_LANE} queues={queues} />
        {bottleLaneHasActivity(queues) ? (
          <LaneRow lane="BOTTLE" label="Bottle route" stages={BOTTLE_LANE} queues={queues} />
        ) : (
          <div className="rounded-md border border-dashed border-slate-700 bg-slate-900/40 p-3 text-[12px] text-slate-400">
            <span className="font-medium text-slate-300">Bottle line</span> ·
            no bottle activity captured.
          </div>
        )}
      </section>

      {/* MACHINE WALL */}
      <section aria-label="Machine wall" className="space-y-3">
        <SectionHeader title="Machine state" subtitle={`${machinesList.length} machines configured`} />
        {machineSnapshots.length === 0 ? (
          <MissingState
            metric={{
              value: null,
              unit: null,
              confidence: "MISSING",
              missingInputs: ["machines"],
              label: "No machines configured",
            }}
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
            {machineSnapshots.map(({ machine, metrics }) => (
              <MachineCard key={machine.id} name={machine.name} kind={machine.kind} metrics={metrics} />
            ))}
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* BOTTLENECK */}
        <Panel title="Bottleneck" subtitle="Highest queue-age or WIP among all stages">
          {bottleneck.stageKey.confidence === "MISSING" ? (
            <MissingState metric={bottleneck.stageKey} />
          ) : (
            <div className="space-y-2 text-sm">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-slate-400 text-[11px] uppercase tracking-wider">Stage</span>
                <span className="font-mono text-slate-100">{String(bottleneck.stageKey.value)}</span>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-slate-400 text-[11px] uppercase tracking-wider">Reason</span>
                <span className="font-mono text-amber-300">{String(bottleneck.reason.value ?? "—")}</span>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-slate-400 text-[11px] uppercase tracking-wider">Oldest age</span>
                <span className="font-mono text-slate-100">
                  {String(bottleneck.oldestAgeMinutes.value ?? 0)}{" "}
                  <span className="text-slate-500 text-[11px]">{bottleneck.oldestAgeMinutes.unit}</span>
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-slate-400 text-[11px] uppercase tracking-wider">WIP</span>
                <span className="font-mono text-slate-100">{String(bottleneck.wip.value ?? 0)}</span>
              </div>
              {bottleneck.cycleVsStandardPct.confidence === "MISSING" && (
                <div className="text-[11px] text-slate-500 pt-1 border-t border-slate-800/60">
                  cycle vs. standard: {bottleneck.cycleVsStandardPct.label}
                </div>
              )}
            </div>
          )}
        </Panel>

        {/* PACKAGING OUTPUT */}
        <Panel title="Packaging output (7d)" subtitle="Strict unit-type separation">
          <div className="grid grid-cols-2 gap-2">
            <MetricCard label="Cases" metric={packaging.masterCases ?? FALLBACK} size="sm" />
            <MetricCard label="Displays" metric={packaging.displaysMade ?? FALLBACK} size="sm" />
            <MetricCard label="Loose cards" metric={packaging.looseCards ?? FALLBACK} size="sm" />
            <MetricCard label="Damaged units" metric={packaging.damagedPackaging ?? FALLBACK} size="sm" />
            <MetricCard label="Ripped cards" metric={packaging.rippedCards ?? FALLBACK} size="sm" />
            <MetricCard label="Damage rate" metric={packaging.damageRatePct ?? FALLBACK} size="sm" />
          </div>
        </Panel>

        {/* DAMAGE / REWORK */}
        <Panel title="Damage & rework (7d)" subtitle="Reject events — all from workflow_events">
          <div className="grid grid-cols-2 gap-2">
            <MetricCard label="First-pass yield" metric={damage.firstPassYieldPct ?? FALLBACK} size="sm" />
            <MetricCard label="Damage events" metric={damage.damageEvents ?? FALLBACK} size="sm" />
            <MetricCard label="Force releases" metric={damage.forceReleaseEvents ?? FALLBACK} size="sm" />
            <MetricCard label="Submission corrections" metric={damage.submissionCorrections ?? FALLBACK} size="sm" />
            <MetricCard label="Rework events" metric={damage.reworkEvents ?? FALLBACK} size="sm" />
          </div>
          {damage.reworkEvents?.confidence === "MISSING" && (
            <div className="mt-2 text-[11px] text-slate-500">
              Rework event flow not configured — REWORK_SENT events not emitted (Phase F).
            </div>
          )}
        </Panel>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* GENEALOGY PREVIEW */}
        <Panel
          title="Latest active bag"
          subtitle="Chronological event preview — full timeline at /genealogy/[bagId]"
        >
          {!recentActiveBag[0] || !genealogy || genealogy.events.length === 0 ? (
            <MissingState
              metric={{
                value: null,
                unit: null,
                confidence: "MISSING",
                missingInputs: ["read_bag_state"],
                label: "No active bags right now",
              }}
            />
          ) : (
            <div className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2 pb-2 border-b border-slate-800/60">
                <Link
                  href={`/genealogy/${recentActiveBag[0].id}`}
                  className="font-mono text-cyan-300 hover:text-cyan-200 text-sm"
                >
                  bag {recentActiveBag[0].id.slice(0, 8)}…
                </Link>
                <span className="text-[11px] text-slate-400">
                  {recentActiveBag[0].productName ?? "no product mapped"}
                  {recentActiveBag[0].productSku ? ` · ${recentActiveBag[0].productSku}` : ""}
                </span>
                <span className="text-[11px] text-slate-500">
                  stage: <span className="text-slate-300">{recentActiveBag[0].stage ?? "—"}</span>
                  {recentActiveBag[0].currentOperator ? ` · op ${recentActiveBag[0].currentOperator}` : ""}
                </span>
              </div>
              <ol className="space-y-1.5 text-[12px]">
                {(genealogy ? genealogy.events.slice(-5).reverse() : []).map((e) => (
                  <li key={e.eventId} className="flex flex-wrap items-baseline gap-2">
                    <span className="font-mono text-slate-500 text-[10px]">
                      {e.occurredAt.toISOString().slice(11, 19)}
                    </span>
                    <span className="font-mono text-cyan-300 text-[10px] uppercase tracking-wider">
                      {e.eventType}
                    </span>
                    {e.machineName && <span className="text-slate-300">{e.machineName}</span>}
                    {e.employeeName && <span className="text-slate-500">· {e.employeeName}</span>}
                  </li>
                ))}
              </ol>
              <Link
                href={`/genealogy/${recentActiveBag[0].id}`}
                className="block text-[11px] text-cyan-400 hover:text-cyan-300 pt-1"
              >
                full timeline →
              </Link>
            </div>
          )}
        </Panel>

        {/* RECON ALERTS */}
        <Panel
          title="Material reconciliation alerts"
          subtitle="High variance + estimated rows from read_material_reconciliation"
        >
          {reconAlerts.length === 0 ? (
            <MissingState
              metric={{
                value: null,
                unit: null,
                confidence: "MISSING",
                missingInputs: ["read_material_reconciliation"],
                label: "No reconciliation rows yet",
                explanation:
                  "Rows populate at BAG_FINALIZED. Run npm run rebuild:read-models to materialise from existing finalised bags.",
              }}
            />
          ) : (
            <div className="space-y-2 text-[12px]">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-1">
                  High variance (&gt;5%)
                </div>
                {highVariance.length === 0 ? (
                  <div className="text-slate-500 text-[11px]">None — all reconciliations within tolerance.</div>
                ) : (
                  <ul className="space-y-0.5">
                    {highVariance.slice(0, 5).map((r) => (
                      <li key={r.bagId} className="flex flex-wrap items-baseline gap-2">
                        <Link
                          href={`/genealogy/${r.bagId}`}
                          className="font-mono text-cyan-300 hover:text-cyan-200 text-[11px]"
                        >
                          {r.bagId.slice(0, 8)}…
                        </Link>
                        <span className="text-slate-300">{r.productName ?? "—"}</span>
                        <span className="font-mono text-rose-300">
                          {Number(r.variancePct ?? 0).toFixed(2)}%
                        </span>
                        <span className="font-mono text-slate-500">
                          ({r.varianceQty} tablets)
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="pt-2 border-t border-slate-800/60">
                <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-1">
                  Estimated (input gap)
                </div>
                {estimatedRows.length === 0 ? (
                  <div className="text-slate-500 text-[11px]">
                    None — every row has full input data.
                  </div>
                ) : (
                  <div className="text-slate-500 text-[11px]">
                    {estimatedRows.length} row{estimatedRows.length === 1 ? "" : "s"} estimated.
                    See <Link href="/material-reconciliation" className="text-cyan-300 hover:text-cyan-200">/material-reconciliation</Link> for the full table.
                  </div>
                )}
              </div>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

function bottleLaneHasActivity(queues: Awaited<ReturnType<typeof deriveQueueAging>>): boolean {
  for (const key of ["BOTTLE_FILL_QUEUE", "BOTTLE_STICKER_QUEUE", "BOTTLE_INDUCTION_QUEUE"] as const) {
    const wip = queues[`${key}.wip`];
    if (wip && typeof wip.value === "number" && wip.value > 0) return true;
  }
  return false;
}

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-slate-800/70 pb-1">
      <h2 className="text-[11px] uppercase tracking-[0.10em] text-slate-300 font-semibold">
        {title}
      </h2>
      {subtitle && <span className="text-[10px] text-slate-500">{subtitle}</span>}
    </div>
  );
}

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  const headerProps: { title: string; subtitle?: string } = { title };
  if (subtitle !== undefined) headerProps.subtitle = subtitle;
  return (
    <section className="rounded-md border border-slate-700/60 bg-slate-900/60 p-3">
      <SectionHeader {...headerProps} />
      <div className="mt-2">{children}</div>
    </section>
  );
}

function LaneRow({
  lane,
  label,
  stages,
  queues,
}: {
  lane: "CARD" | "BOTTLE";
  label: string;
  stages: ReadonlyArray<{ key: StageKey; label: string }>;
  queues: Awaited<ReturnType<typeof deriveQueueAging>>;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.10em] text-slate-500 mb-1.5">
        {label}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {stages.map((s) => (
          <StageCard key={`${lane}-${s.key}`} stageKey={s.key} label={s.label} queues={queues} />
        ))}
      </div>
    </div>
  );
}

const STATUS_COLOR: Record<string, string> = {
  EMPTY: "border-slate-700/60",
  FLOWING: "border-emerald-500/40",
  AGING: "border-amber-500/40",
  STALLED: "border-rose-500/40",
};

function StageCard({
  stageKey,
  label,
  queues,
}: {
  stageKey: StageKey;
  label: string;
  queues: Awaited<ReturnType<typeof deriveQueueAging>>;
}) {
  const wip = queues[`${stageKey}.wip`];
  const oldest = queues[`${stageKey}.oldestAgeMinutes`];
  const avg = queues[`${stageKey}.avgAgeMinutes`];
  const p90 = queues[`${stageKey}.p90AgeMinutes`];
  const overThreshold = queues[`${stageKey}.bagsOverThreshold`];
  const status = queues[`${stageKey}.status`];
  const statusValue = String(status?.value ?? "EMPTY");
  const borderClass = STATUS_COLOR[statusValue] ?? "border-slate-700/60";
  return (
    <div className={`rounded-md border ${borderClass} bg-slate-900/60 p-2.5 space-y-1`}>
      <div className="flex items-center justify-between gap-1.5">
        <div className="text-[10px] uppercase tracking-[0.10em] text-slate-300 font-semibold leading-tight truncate">
          {label}
        </div>
        <span className="text-[9px] uppercase tracking-wider text-slate-400">
          {statusValue}
        </span>
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-mono tabular-nums text-slate-100">
          {String(wip?.value ?? "—")}
        </span>
        <span className="text-[10px] text-slate-500">bags WIP</span>
      </div>
      <div className="grid grid-cols-3 gap-1 text-[10px] text-slate-400 pt-1 border-t border-slate-800/60">
        <Mini label="oldest" m={oldest} />
        <Mini label="avg" m={avg} />
        <Mini label="p90" m={p90} />
      </div>
      {overThreshold && typeof overThreshold.value === "number" && overThreshold.value > 0 && (
        <div className="text-[10px] text-amber-300">
          {overThreshold.value} over threshold
        </div>
      )}
    </div>
  );
}

function Mini({ label, m }: { label: string; m: MetricResult | undefined }) {
  if (!m || m.value == null) {
    return (
      <div>
        <div className="text-slate-600">{label}</div>
        <div className="text-slate-500 font-mono">—</div>
      </div>
    );
  }
  return (
    <div>
      <div className="text-slate-500">{label}</div>
      <div className="text-slate-300 font-mono">
        {String(m.value)}
        {m.unit ? ` ${m.unit}` : ""}
      </div>
    </div>
  );
}

function MachineCard({
  name,
  kind,
  metrics,
}: {
  name: string;
  kind: string;
  metrics: Awaited<ReturnType<typeof deriveMachineMetrics>>;
}) {
  const state = String(metrics.state?.value ?? "UNKNOWN");
  const stateColor =
    state === "LIVE"
      ? "border-emerald-500/40 text-emerald-300"
      : state === "NO_ACTIVITY_TODAY"
        ? "border-slate-700/60 text-slate-400"
        : state === "NOT_INTEGRATED"
          ? "border-slate-800 text-slate-500"
          : state === "PAUSED"
            ? "border-amber-500/40 text-amber-300"
            : "border-slate-700/60 text-slate-400";
  return (
    <div className={`rounded-md border ${stateColor} bg-slate-900/60 p-2.5 space-y-1`}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-[12px] font-semibold text-slate-100 leading-tight truncate">
          {name}
        </div>
        <span className="text-[9px] uppercase tracking-wider">{state}</span>
      </div>
      <div className="text-[10px] text-slate-500 uppercase tracking-wider">{kind}</div>
      <div className="text-[11px] text-slate-300 truncate">
        bag:{" "}
        <span className="font-mono text-slate-200">
          {metrics.currentBag?.value
            ? String(metrics.currentBag.value).slice(0, 8) + "…"
            : "—"}
        </span>
      </div>
      <div className="text-[11px] text-slate-300 truncate">
        product: <span className="text-slate-200">{String(metrics.currentSku?.value ?? "—")}</span>
      </div>
      <div className="text-[11px] text-slate-300 truncate">
        op: <span className="text-slate-200">{String(metrics.currentOperator?.value ?? "—")}</span>
      </div>
      <div className="grid grid-cols-2 gap-1 text-[10px] pt-1 border-t border-slate-800/60">
        <div>
          <div className="text-slate-500">runtime</div>
          <div className="text-slate-300 font-mono">
            {String(metrics.activeRuntimeToday?.value ?? 0)} {metrics.activeRuntimeToday?.unit}
          </div>
        </div>
        <div>
          <div className="text-slate-500">units/hr</div>
          <div className="text-slate-300 font-mono">
            {String(metrics.unitsPerHour?.value ?? 0)}
          </div>
        </div>
      </div>
      {metrics.idealCycleSeconds?.confidence === "MISSING" && (
        <div className="text-[9px] text-slate-500">
          {metrics.idealCycleSeconds.label}
        </div>
      )}
    </div>
  );
}

const FALLBACK: MetricResult = {
  value: null,
  unit: null,
  confidence: "MISSING",
  missingInputs: ["metric_api"],
  label: "No data",
};

function DiagTile({
  label,
  value,
  accent = "default",
}: {
  label: string;
  value: number | string;
  accent?: "default" | "amber" | "rose" | "cyan";
}) {
  const valueColor =
    accent === "amber"
      ? "text-amber-300"
      : accent === "rose"
        ? "text-rose-300"
        : accent === "cyan"
          ? "text-cyan-300"
          : "text-slate-100";
  const borderColor =
    accent === "amber"
      ? "border-amber-500/30"
      : accent === "rose"
        ? "border-rose-500/30"
        : accent === "cyan"
          ? "border-cyan-500/30"
          : "border-slate-700/60";
  return (
    <div
      className={`rounded-md border ${borderColor} bg-slate-900/60 px-3 py-2`}
    >
      <div className="text-[10px] uppercase tracking-[0.10em] text-slate-400 leading-tight truncate">
        {label}
      </div>
      <div className={`mt-1 text-xl font-mono tabular-nums ${valueColor}`}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>
    </div>
  );
}
