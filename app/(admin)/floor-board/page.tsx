// Phase E → LUMA-UI-REBUILD-1.
//
// Luma Production Command Center — the floor wallboard.
//
// Single source of truth: lib/production/metrics.ts. UI computes
// nothing; it formats values and arranges them. Honest by default —
// every metric flows through MetricResult, every empty surfaces with
// the canonical missing-data label.
//
// Surface: dark "command wall" (bg-inverse). Chrome rebuilt in the
// LUMA-UI-REBUILD-1 design language — 3px tone rail as signature
// motif, refined eyebrow + display type hierarchy, tone vocabulary
// (good / warn / crit / info / muted / brand) replaces ad-hoc
// amber / rose / cyan. Existing domain primitives (MetricCard,
// MissingState, ConfidenceBadge, LiveRefresh) preserved — they were
// already dark-tuned and re-render unchanged.
//
// Data loading + every read query unchanged from the prior version.

import Link from "next/link";
import { db } from "@/lib/db";
import { eq, desc, isNotNull, and } from "drizzle-orm";
import {
  machines,
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
  AlertTriangle,
  ArrowRight,
  Cpu,
  GitBranch,
  Layers,
  Radar,
} from "lucide-react";
import {
  type StageKey,
  type MetricResult,
} from "@/lib/production/types";
import { cn } from "@/lib/utils";

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

// Tone vocabulary on the dark wall — same names as the light pages,
// different shades so they read on bg-inverse.
type WallTone = "good" | "warn" | "crit" | "info" | "muted" | "brand";

const RAIL: Record<WallTone, string> = {
  good: "before:bg-good-500",
  warn: "before:bg-warn-500",
  crit: "before:bg-crit-500",
  info: "before:bg-info-500",
  muted: "before:bg-slate-600",
  brand: "before:bg-brand-accent",
};

const TILE_TEXT: Record<WallTone, string> = {
  good: "text-emerald-300",
  warn: "text-amber-300",
  crit: "text-rose-300",
  info: "text-cyan-300",
  muted: "text-slate-100",
  brand: "text-brand-accent",
};

const TILE_BORDER: Record<WallTone, string> = {
  good: "border-emerald-500/30",
  warn: "border-amber-500/30",
  crit: "border-rose-500/30",
  info: "border-cyan-500/25",
  muted: "border-slate-800/70",
  brand: "border-brand-500/35",
};

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
    <div className="-mx-4 sm:-mx-6 lg:-mx-8 -my-4 sm:-my-6 lg:-my-8 px-4 sm:px-6 lg:px-10 py-6 lg:py-8 bg-inverse text-text-inverse min-h-dvh space-y-6">
      {/* COMMAND BAND — brand identity + live signal. The eyebrow
          ties the page to the rest of the system; the display title
          carries weight; the right-aligned cluster delivers signal
          state at a glance. */}
      <header className="relative reveal reveal-1">
        <div className="flex flex-wrap items-end justify-between gap-4 pb-5 border-b border-slate-800">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-inverse/55 flex items-center gap-2">
              <span
                aria-hidden
                className="pulse-accent inline-block h-1.5 w-1.5 rounded-full bg-brand-accent"
              />
              Luma · Floor work · Live operations
            </div>
            <h1 className="display-title mt-3 text-[36px] sm:text-[42px] text-text-inverse">
              Production command center
            </h1>
            <p className="mt-2 text-[12.5px] text-text-inverse/55 max-w-2xl leading-relaxed">
              Single source of truth:{" "}
              <code className="font-mono text-text-inverse/80">lib/production/metrics.ts</code>.
              Window: today {today.from.toISOString().slice(0, 10)} UTC.
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <div className="text-right">
              <div className="text-[9.5px] uppercase tracking-[0.14em] text-text-inverse/45">
                Last refresh
              </div>
              <div className="font-mono text-[11px] text-text-inverse/85 tabular">
                {fmtTime(new Date())}
              </div>
            </div>
            <div className="h-7 w-px bg-slate-800" aria-hidden />
            <ConfidenceBadge confidence="HIGH" />
            <LiveRefresh />
          </div>
        </div>
      </header>

      {/* WORKFLOW HEALTH — diagnostic strip. Always visible. Surfaces
          the gap between activity and finalization. */}
      <WallSection
        eyebrow="Workflow health"
        subtitle={
          health.lastEventAt
            ? `Last event ${new Date(health.lastEventAt).toISOString().replace("T", " ").slice(0, 19)} UTC`
            : "No events recorded yet"
        }
        tone="info"
        icon={Radar}
      >
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
          <WallTile label="Total events" value={health.totalEvents} />
          <WallTile label="Total bags" value={health.totalBags} />
          <WallTile label="Active" value={health.activeBags} />
          <WallTile
            label="Finalized"
            value={health.finalizedBags}
            tone={
              health.finalizedBags === 0 && health.totalBags > 0
                ? "crit"
                : "muted"
            }
          />
          <WallTile
            label="Missing finalize"
            value={health.bagsMissingFinalization}
            tone={health.bagsMissingFinalization > 0 ? "warn" : "muted"}
          />
          <WallTile
            label="Completion rate"
            value={
              health.completionRatePct == null
                ? "—"
                : `${health.completionRatePct}%`
            }
            tone={
              health.completionRatePct != null && health.completionRatePct < 50
                ? "crit"
                : "muted"
            }
          />
          <WallTile
            label="Operator capture"
            value={
              health.activeBags === 0
                ? "—"
                : `${health.operatorCodeCaptureCount} / ${health.activeBags}`
            }
            tone={
              health.activeBags > 0 && health.operatorCodeCaptureCount === 0
                ? "crit"
                : "muted"
            }
          />
        </div>
        <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
          <WallTile label="Stuck @ start" value={health.bagsStuckAtStart} tone="warn" />
          <WallTile label="Stuck @ blister" value={health.bagsStuckAtBlister} tone="warn" />
          <WallTile label="Stuck @ seal" value={health.bagsStuckAtSeal} tone="warn" />
          <WallTile label="Packaged, not finalized" value={health.bagsPackagedNotFinalized} tone="warn" />
          <WallTile label="Force releases" value={health.forceReleaseCount} />
          <WallTile label="Submission corrections" value={health.submissionCorrectionCount} />
          <WallTile label="Paused bags" value={health.pausedBags} />
        </div>
      </WallSection>

      {/* WHY ARE METRICS EMPTY? — only shows when activity exists
          but no bags have finalized. */}
      {health.totalEvents > 0 && health.finalizedBags === 0 && (
        <WallAlert
          tone="warn"
          icon={AlertTriangle}
          title="Why are output metrics empty?"
          body={
            <>
              <p className="leading-relaxed">
                Production activity exists ({health.totalEvents} events across{" "}
                {health.totalBags} bags), but{" "}
                <strong className="text-amber-200">
                  no bags have reached BAG_FINALIZED
                </strong>
                . Output metrics (good units, displays, cases, yield, OEE,
                material reconciliation) are blocked until bags are finalized
                on the floor or until legacy activity is mapped into canonical
                completion states via the legacy synthesizer.
              </p>
              <p className="mt-1.5">
                Action: complete the full floor flow on the station —{" "}
                <span className="font-mono text-text-inverse/80">
                  CARD_ASSIGNED → BLISTER_COMPLETE → SEALING_COMPLETE →
                  PACKAGING_COMPLETE → BAG_FINALIZED
                </span>
                . The Finalize button on the packaging station fires
                BAG_FINALIZED, which writes read_bag_metrics and unlocks every
                output KPI.
              </p>
            </>
          }
        />
      )}

      {/* BLOCKED METRICS — list every blocked KPI, why, and what to
          do. */}
      {blocked.length > 0 && (
        <WallSection
          eyebrow="Blocked metrics"
          subtitle={`${blocked.length} KPI${blocked.length === 1 ? "" : "s"} cannot compute today`}
          tone="crit"
          icon={AlertTriangle}
        >
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
            {blocked.map((b) => (
              <div
                key={b.metric}
                className={cn(
                  "rail",
                  RAIL.crit,
                  "relative pl-[3px] rounded-md border border-rose-500/25 bg-slate-900/60 p-3 space-y-1.5",
                )}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-[13px] font-semibold tracking-tight text-text-inverse">
                    {b.metric}
                  </h3>
                  <ConfidenceBadge confidence="MISSING" />
                </div>
                <p className="text-[12px] text-text-inverse/65 leading-relaxed">
                  {b.reason}
                </p>
                <div className="text-[11px] text-text-inverse/45">
                  <strong className="text-text-inverse/70">Missing:</strong>{" "}
                  {b.missing.join(", ") || "—"}
                </div>
                <div className="text-[11px] text-text-inverse/45">
                  <strong className="text-text-inverse/70">Action:</strong>{" "}
                  {b.action}
                </div>
              </div>
            ))}
          </div>
        </WallSection>
      )}

      {/* ACTIVITY SIGNALS — raw event counts. NEVER reported as
          output / yield / OEE / good units. The label spells this
          out. */}
      <WallSection
        eyebrow="Activity signals (last 30d)"
        subtitle="Raw scan counts. Never output, yield, or OEE."
        tone="info"
        icon={Radar}
      >
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
          <WallTile label="Total events 30d" value={activity.totalEvents30d} tone="info" />
          <WallTile label="Card assigns" value={activity.cardAssigned30d} />
          <WallTile label="Blister scans" value={activity.blisterEvents30d} />
          <WallTile label="Sealing scans" value={activity.sealingEvents30d} />
          <WallTile label="Packaging snapshots" value={activity.packagingSnapshots30d} />
          <WallTile label="Packaging complete" value={activity.packagingComplete30d} />
          <WallTile label="Bag pauses" value={activity.bagPaused30d} />
          <WallTile label="Bag resumes" value={activity.bagResumed30d} />
        </div>
        {activity.bottleHandpack30d +
          activity.bottleCapSeal30d +
          activity.bottleSticker30d >
          0 && (
          <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2">
            <WallTile label="Bottle handpack" value={activity.bottleHandpack30d} />
            <WallTile label="Bottle cap/seal" value={activity.bottleCapSeal30d} />
            <WallTile label="Bottle sticker" value={activity.bottleSticker30d} />
          </div>
        )}
        {activity.lastEventByStation.length > 0 && (
          <div className="mt-3 rounded-md border border-slate-800/70 bg-slate-900/60 overflow-hidden">
            <div className="grid grid-cols-[1fr_1fr_100px_90px_180px] gap-2 px-3 py-2 text-[9.5px] font-semibold uppercase tracking-[0.10em] text-text-inverse/45 bg-slate-900/80 border-b border-slate-800/70">
              <div>Station</div>
              <div>Machine</div>
              <div>Kind</div>
              <div className="text-right">Events 30d</div>
              <div>Last activity</div>
            </div>
            {activity.lastEventByStation.slice(0, 10).map((s) => (
              <div
                key={s.stationId}
                className="grid grid-cols-[1fr_1fr_100px_90px_180px] gap-2 px-3 py-1.5 text-[12px] border-t border-slate-800/40 first:border-t-0 items-baseline"
              >
                <div className="text-text-inverse/85 truncate">
                  {s.stationLabel ?? s.stationId.slice(0, 8) + "…"}
                </div>
                <div className="text-text-inverse/70 truncate">
                  {s.machineName ?? "—"}
                </div>
                <div className="text-text-inverse/45 font-mono text-[11px]">
                  {s.machineKind ?? "—"}
                </div>
                <div className="text-right font-mono tabular text-text-inverse/85">
                  {s.eventCount30d}
                </div>
                <div className="font-mono text-[10.5px] text-text-inverse/45">
                  {s.lastEventAt.toISOString().replace("T", " ").slice(0, 19)} UTC
                </div>
              </div>
            ))}
          </div>
        )}
      </WallSection>

      {/* KPI STRIP — eight at-a-glance numbers. */}
      <WallSection eyebrow="Today" tone="brand" icon={Layers}>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
          <MetricCard label="Bags in flow" metric={dashboard.bagsInFlow ?? FALLBACK} size="sm" />
          <MetricCard label="Good units today" metric={dashboard.goodUnitsToday ?? FALLBACK} size="sm" />
          <MetricCard label="Displays today" metric={dashboard.displaysToday ?? FALLBACK} size="sm" />
          <MetricCard label="Cases today" metric={dashboard.casesToday ?? FALLBACK} size="sm" />
          <MetricCard label="Oldest queue age" metric={dashboard.oldestQueueAgeMinutes ?? FALLBACK} size="sm" />
          <MetricCard label="Paused > 30m" metric={dashboard.pausedBagsOverThreshold ?? FALLBACK} size="sm" />
          <MetricCard label="Bottleneck" metric={bottleneck.stageKey} size="sm" />
          <MetricCard label="Schedule gap" metric={dashboard.scheduleGap ?? FALLBACK} size="sm" />
        </div>
      </WallSection>

      {/* PROCESS MAP — two lanes the floor walks. */}
      <WallSection
        eyebrow="Process map"
        subtitle="Live queue snapshot — one row per stage, in the order bags travel."
        tone="brand"
        icon={GitBranch}
      >
        <div className="space-y-4">
          <LaneRow lane="CARD" label="Card / blister route" stages={CARD_LANE} queues={queues} />
          {bottleLaneHasActivity(queues) ? (
            <LaneRow lane="BOTTLE" label="Bottle route" stages={BOTTLE_LANE} queues={queues} />
          ) : (
            <WallEmpty
              title="Bottle line idle"
              body="No bottle-route activity captured in the current window."
              source="read_queue_state · BOTTLE_*_QUEUE"
            />
          )}
        </div>
      </WallSection>

      {/* MACHINE WALL — one tile per machine. State drives the rail. */}
      <WallSection
        eyebrow="Machine state"
        subtitle={`${machinesList.length} machine${machinesList.length === 1 ? "" : "s"} configured`}
        tone="info"
        icon={Cpu}
      >
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
              <MachineTile
                key={machine.id}
                name={machine.name}
                kind={machine.kind}
                metrics={metrics}
              />
            ))}
          </div>
        )}
      </WallSection>

      {/* TRIPTYCH — bottleneck / packaging / damage detail */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <WallPanel eyebrow="Bottleneck" subtitle="Highest queue-age or WIP across stages" tone="warn">
          {bottleneck.stageKey.confidence === "MISSING" ? (
            <MissingState metric={bottleneck.stageKey} />
          ) : (
            <div className="space-y-1.5">
              <BottleRow label="Stage" value={String(bottleneck.stageKey.value)} mono />
              <BottleRow label="Reason" value={String(bottleneck.reason.value ?? "—")} mono tone="warn" />
              <BottleRow
                label="Oldest age"
                value={`${String(bottleneck.oldestAgeMinutes.value ?? 0)} ${bottleneck.oldestAgeMinutes.unit ?? ""}`}
                mono
              />
              <BottleRow label="WIP" value={String(bottleneck.wip.value ?? 0)} mono />
              {bottleneck.cycleVsStandardPct.confidence === "MISSING" && (
                <div className="text-[10.5px] text-text-inverse/45 pt-1.5 border-t border-slate-800/60">
                  cycle vs. standard: {bottleneck.cycleVsStandardPct.label}
                </div>
              )}
            </div>
          )}
        </WallPanel>

        <WallPanel
          eyebrow="Packaging output (7d)"
          subtitle="Strict unit-type separation"
          tone="info"
        >
          <div className="grid grid-cols-2 gap-2">
            <MetricCard label="Cases" metric={packaging.masterCases ?? FALLBACK} size="sm" />
            <MetricCard label="Displays" metric={packaging.displaysMade ?? FALLBACK} size="sm" />
            <MetricCard label="Loose cards" metric={packaging.looseCards ?? FALLBACK} size="sm" />
            <MetricCard label="Damaged units" metric={packaging.damagedPackaging ?? FALLBACK} size="sm" />
            <MetricCard label="Ripped cards" metric={packaging.rippedCards ?? FALLBACK} size="sm" />
            <MetricCard label="Damage rate" metric={packaging.damageRatePct ?? FALLBACK} size="sm" />
          </div>
        </WallPanel>

        <WallPanel
          eyebrow="Damage & rework (7d)"
          subtitle="Reject events — all from workflow_events"
          tone="crit"
        >
          <div className="grid grid-cols-2 gap-2">
            <MetricCard label="First-pass yield" metric={damage.firstPassYieldPct ?? FALLBACK} size="sm" />
            <MetricCard label="Damage events" metric={damage.damageEvents ?? FALLBACK} size="sm" />
            <MetricCard label="Force releases" metric={damage.forceReleaseEvents ?? FALLBACK} size="sm" />
            <MetricCard label="Submission corrections" metric={damage.submissionCorrections ?? FALLBACK} size="sm" />
            <MetricCard label="Rework events" metric={damage.reworkEvents ?? FALLBACK} size="sm" />
          </div>
          {damage.reworkEvents?.confidence === "MISSING" && (
            <div className="mt-2 text-[10.5px] text-text-inverse/45">
              Rework event flow not configured — REWORK_SENT events not emitted (Phase F).
            </div>
          )}
        </WallPanel>
      </div>

      {/* DUO — most recent active bag / recon alerts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <WallPanel
          eyebrow="Latest active bag"
          subtitle="Chronological event preview · full timeline at /genealogy/[bagId]"
          tone="brand"
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
              <div className="flex flex-wrap items-baseline justify-between gap-2 pb-2 border-b border-slate-800/70">
                <Link
                  href={`/genealogy/${recentActiveBag[0].id}`}
                  className="font-mono text-cyan-300 hover:text-cyan-200 text-[12.5px]"
                >
                  bag {recentActiveBag[0].id.slice(0, 8)}…
                </Link>
                <span className="text-[11px] text-text-inverse/70">
                  {recentActiveBag[0].productName ?? "no product mapped"}
                  {recentActiveBag[0].productSku
                    ? ` · ${recentActiveBag[0].productSku}`
                    : ""}
                </span>
                <span className="text-[11px] text-text-inverse/55">
                  stage:{" "}
                  <span className="text-text-inverse/85">
                    {recentActiveBag[0].stage ?? "—"}
                  </span>
                  {recentActiveBag[0].currentOperator
                    ? ` · op ${recentActiveBag[0].currentOperator}`
                    : ""}
                </span>
              </div>
              <ol className="space-y-1.5 text-[12px]">
                {(genealogy ? genealogy.events.slice(-5).reverse() : []).map(
                  (e) => (
                    <li
                      key={e.eventId}
                      className="flex flex-wrap items-baseline gap-2"
                    >
                      <span className="font-mono text-text-inverse/45 text-[10px] tabular">
                        {e.occurredAt.toISOString().slice(11, 19)}
                      </span>
                      <span className="font-mono text-cyan-300 text-[10px] uppercase tracking-wider">
                        {e.eventType}
                      </span>
                      {e.machineName && (
                        <span className="text-text-inverse/80">
                          {e.machineName}
                        </span>
                      )}
                      {e.employeeName && (
                        <span className="text-text-inverse/55">
                          · {e.employeeName}
                        </span>
                      )}
                    </li>
                  ),
                )}
              </ol>
              <Link
                href={`/genealogy/${recentActiveBag[0].id}`}
                className="inline-flex items-center gap-1 text-[11px] text-cyan-300 hover:text-cyan-200 pt-1"
              >
                Full timeline
                <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
          )}
        </WallPanel>

        <WallPanel
          eyebrow="Material reconciliation alerts"
          subtitle="High variance + estimated rows from read_material_reconciliation"
          tone="crit"
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
            <div className="space-y-2.5 text-[12px]">
              <div>
                <div className="eyebrow text-text-inverse/55 mb-1">
                  High variance (&gt;5%)
                </div>
                {highVariance.length === 0 ? (
                  <div className="text-text-inverse/55 text-[11px]">
                    None — all reconciliations within tolerance.
                  </div>
                ) : (
                  <ul className="space-y-0.5">
                    {highVariance.slice(0, 5).map((r) => (
                      <li
                        key={r.bagId}
                        className="flex flex-wrap items-baseline gap-2"
                      >
                        <Link
                          href={`/genealogy/${r.bagId}`}
                          className="font-mono text-cyan-300 hover:text-cyan-200 text-[11px]"
                        >
                          {r.bagId.slice(0, 8)}…
                        </Link>
                        <span className="text-text-inverse/85">
                          {r.productName ?? "—"}
                        </span>
                        <span className="font-mono text-rose-300 tabular">
                          {Number(r.variancePct ?? 0).toFixed(2)}%
                        </span>
                        <span className="font-mono text-text-inverse/50">
                          ({r.varianceQty} tablets)
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="pt-2 border-t border-slate-800/70">
                <div className="eyebrow text-text-inverse/55 mb-1">
                  Estimated (input gap)
                </div>
                {estimatedRows.length === 0 ? (
                  <div className="text-text-inverse/55 text-[11px]">
                    None — every row has full input data.
                  </div>
                ) : (
                  <div className="text-text-inverse/55 text-[11px]">
                    {estimatedRows.length} row
                    {estimatedRows.length === 1 ? "" : "s"} estimated. See{" "}
                    <Link
                      href="/material-reconciliation"
                      className="text-cyan-300 hover:text-cyan-200"
                    >
                      /material-reconciliation
                    </Link>{" "}
                    for the full table.
                  </div>
                )}
              </div>
            </div>
          )}
        </WallPanel>
      </div>
    </div>
  );
}

function bottleLaneHasActivity(
  queues: Awaited<ReturnType<typeof deriveQueueAging>>,
): boolean {
  for (const key of [
    "BOTTLE_FILL_QUEUE",
    "BOTTLE_STICKER_QUEUE",
    "BOTTLE_INDUCTION_QUEUE",
  ] as const) {
    const wip = queues[`${key}.wip`];
    if (wip && typeof wip.value === "number" && wip.value > 0) return true;
  }
  return false;
}

// ── Dark-wall primitives ────────────────────────────────────────────
//
// Local to this page on purpose. The light-canvas primitives in
// components/production/luma-ui.tsx are tuned for bg-surface and would
// read wrong on bg-inverse. These mirror the same vocabulary (rail,
// eyebrow, tone) but on the dark wallboard.

function WallSection({
  eyebrow,
  subtitle,
  tone = "muted",
  icon: Icon,
  children,
}: {
  eyebrow: string;
  subtitle?: string;
  tone?: WallTone;
  icon?: typeof Radar;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "rail",
        RAIL[tone],
        "relative pl-[3px] rounded-[10px] bg-slate-900/50 border border-slate-800/70 overflow-hidden",
      )}
      aria-label={eyebrow}
    >
      <header className="px-4 pt-3 pb-2.5 border-b border-slate-800/70 flex items-center justify-between gap-3 flex-wrap bg-slate-900/40">
        <div className="flex items-center gap-2 min-w-0">
          {Icon ? (
            <span
              className={cn(
                "inline-flex h-5 w-5 items-center justify-center rounded-sm border bg-slate-900/80",
                TILE_BORDER[tone],
                TILE_TEXT[tone],
              )}
            >
              <Icon className="h-3 w-3" />
            </span>
          ) : null}
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-text-inverse/75">
            {eyebrow}
          </span>
        </div>
        {subtitle ? (
          <span className="text-[10.5px] text-text-inverse/45 font-mono tabular">
            {subtitle}
          </span>
        ) : null}
      </header>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

function WallPanel({
  eyebrow,
  subtitle,
  tone = "muted",
  children,
}: {
  eyebrow: string;
  subtitle?: string;
  tone?: WallTone;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "rail",
        RAIL[tone],
        "relative pl-[3px] rounded-[10px] bg-slate-900/50 border border-slate-800/70 overflow-hidden",
      )}
    >
      <header className="px-3.5 pt-3 pb-2 border-b border-slate-800/70 bg-slate-900/30">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-text-inverse/75">
          {eyebrow}
        </div>
        {subtitle ? (
          <div className="mt-0.5 text-[10.5px] text-text-inverse/45 leading-snug">
            {subtitle}
          </div>
        ) : null}
      </header>
      <div className="px-3.5 py-3">{children}</div>
    </section>
  );
}

function WallTile({
  label,
  value,
  tone = "muted",
}: {
  label: string;
  value: number | string;
  tone?: WallTone;
}) {
  return (
    <div
      className={cn(
        "rail",
        RAIL[tone],
        "relative pl-[3px] rounded-md bg-slate-900/60 border px-3 py-2.5",
        TILE_BORDER[tone],
      )}
    >
      <div className="text-[10px] uppercase tracking-[0.10em] text-text-inverse/55 leading-tight truncate">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 text-[20px] font-mono tabular leading-none",
          TILE_TEXT[tone],
        )}
      >
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>
    </div>
  );
}

function WallAlert({
  tone = "info",
  title,
  body,
  icon: Icon,
}: {
  tone?: WallTone;
  title: string;
  body?: React.ReactNode;
  icon?: typeof AlertTriangle;
}) {
  return (
    <div
      className={cn(
        "rail",
        RAIL[tone],
        "relative pl-[3px] rounded-[10px] border bg-slate-900/60",
        TILE_BORDER[tone],
      )}
      role="status"
    >
      <div className="flex items-start gap-3 px-4 py-3">
        {Icon ? (
          <span
            className={cn(
              "shrink-0 mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-md border bg-slate-900/80",
              TILE_BORDER[tone],
              TILE_TEXT[tone],
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "text-[13px] font-semibold tracking-tight",
              TILE_TEXT[tone],
            )}
          >
            {title}
          </p>
          {body ? (
            <div className="mt-1 text-[12px] leading-relaxed text-text-inverse/70">
              {body}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function WallEmpty({
  title,
  body,
  source,
}: {
  title: string;
  body?: React.ReactNode;
  source?: string;
}) {
  return (
    <div className="rounded-md border border-dashed border-slate-800/80 bg-slate-900/40 px-4 py-5 text-center">
      <p className="text-[12.5px] font-semibold tracking-tight text-text-inverse/85">
        {title}
      </p>
      {body ? (
        <p className="mt-1 text-[11px] text-text-inverse/55 leading-relaxed">
          {body}
        </p>
      ) : null}
      {source ? (
        <p className="mt-1 text-[10px] text-text-inverse/40 font-mono">
          {source}
        </p>
      ) : null}
    </div>
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
      <div className="eyebrow text-text-inverse/55 mb-1.5">{label}</div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {stages.map((s) => (
          <StageTile
            key={`${lane}-${s.key}`}
            stageKey={s.key}
            label={s.label}
            queues={queues}
          />
        ))}
      </div>
    </div>
  );
}

const STAGE_STATUS_TONE: Record<string, WallTone> = {
  EMPTY: "muted",
  FLOWING: "good",
  AGING: "warn",
  STALLED: "crit",
};

function StageTile({
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
  const tone: WallTone = STAGE_STATUS_TONE[statusValue] ?? "muted";
  return (
    <div
      className={cn(
        "rail",
        RAIL[tone],
        "relative pl-[3px] rounded-md border bg-slate-900/60 px-3 py-2.5 space-y-1.5",
        TILE_BORDER[tone],
      )}
    >
      <div className="flex items-center justify-between gap-1.5">
        <div className="text-[10px] uppercase tracking-[0.10em] text-text-inverse/85 font-semibold leading-tight truncate">
          {label}
        </div>
        <span
          className={cn(
            "text-[9px] uppercase tracking-[0.10em] font-mono",
            TILE_TEXT[tone],
          )}
        >
          {statusValue}
        </span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span
          className={cn(
            "text-[26px] leading-none font-mono tabular",
            TILE_TEXT[tone],
          )}
        >
          {String(wip?.value ?? "—")}
        </span>
        <span className="text-[10px] text-text-inverse/45">bags WIP</span>
      </div>
      <div className="grid grid-cols-3 gap-1 text-[10px] text-text-inverse/55 pt-1 border-t border-slate-800/60">
        <Mini label="oldest" m={oldest} />
        <Mini label="avg" m={avg} />
        <Mini label="p90" m={p90} />
      </div>
      {overThreshold &&
        typeof overThreshold.value === "number" &&
        overThreshold.value > 0 && (
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
        <div className="text-text-inverse/40">{label}</div>
        <div className="text-text-inverse/55 font-mono">—</div>
      </div>
    );
  }
  return (
    <div>
      <div className="text-text-inverse/45">{label}</div>
      <div className="text-text-inverse/85 font-mono tabular">
        {String(m.value)}
        {m.unit ? ` ${m.unit}` : ""}
      </div>
    </div>
  );
}

const MACHINE_STATE_TONE: Record<string, WallTone> = {
  LIVE: "good",
  PAUSED: "warn",
  NO_ACTIVITY_TODAY: "muted",
  NOT_INTEGRATED: "muted",
};

function MachineTile({
  name,
  kind,
  metrics,
}: {
  name: string;
  kind: string;
  metrics: Awaited<ReturnType<typeof deriveMachineMetrics>>;
}) {
  const state = String(metrics.state?.value ?? "UNKNOWN");
  const tone: WallTone = MACHINE_STATE_TONE[state] ?? "muted";
  return (
    <div
      className={cn(
        "rail",
        RAIL[tone],
        "relative pl-[3px] rounded-md border bg-slate-900/60 px-3 py-2.5 space-y-1",
        TILE_BORDER[tone],
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-[12.5px] font-semibold text-text-inverse leading-tight truncate">
          {name}
        </div>
        <span
          className={cn(
            "text-[9px] uppercase tracking-[0.10em] font-mono",
            TILE_TEXT[tone],
          )}
        >
          {state}
        </span>
      </div>
      <div className="text-[10px] text-text-inverse/45 uppercase tracking-[0.10em]">
        {kind}
      </div>
      <div className="text-[11px] text-text-inverse/85 truncate">
        bag:{" "}
        <span className="font-mono text-text-inverse">
          {metrics.currentBag?.value
            ? String(metrics.currentBag.value).slice(0, 8) + "…"
            : "—"}
        </span>
      </div>
      <div className="text-[11px] text-text-inverse/85 truncate">
        product:{" "}
        <span className="text-text-inverse">
          {String(metrics.currentSku?.value ?? "—")}
        </span>
      </div>
      <div className="text-[11px] text-text-inverse/85 truncate">
        op:{" "}
        <span className="text-text-inverse">
          {String(metrics.currentOperator?.value ?? "—")}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-1 text-[10px] pt-1 border-t border-slate-800/60">
        <div>
          <div className="text-text-inverse/45">runtime</div>
          <div className="text-text-inverse/85 font-mono tabular">
            {String(metrics.activeRuntimeToday?.value ?? 0)}{" "}
            {metrics.activeRuntimeToday?.unit}
          </div>
        </div>
        <div>
          <div className="text-text-inverse/45">units/hr</div>
          <div className="text-text-inverse/85 font-mono tabular">
            {String(metrics.unitsPerHour?.value ?? 0)}
          </div>
        </div>
      </div>
      {metrics.idealCycleSeconds?.confidence === "MISSING" && (
        <div className="text-[9px] text-text-inverse/45">
          {metrics.idealCycleSeconds.label}
        </div>
      )}
    </div>
  );
}

function BottleRow({
  label,
  value,
  mono,
  tone,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: WallTone;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[10px] uppercase tracking-[0.10em] text-text-inverse/55">
        {label}
      </span>
      <span
        className={cn(
          "text-[12.5px]",
          mono ? "font-mono tabular" : "",
          tone ? TILE_TEXT[tone] : "text-text-inverse/90",
        )}
      >
        {value}
      </span>
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
