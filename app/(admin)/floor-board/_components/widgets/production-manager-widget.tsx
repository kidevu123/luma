"use client";

import {
  AlertTriangle,
  Ban,
  Clock,
  Factory,
  Package,
  Pause,
  ScanLine,
  Users,
} from "lucide-react";
import {
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { FloorManagerSnapshot } from "@/lib/production/floor-manager-snapshot-types";
import type { MachineProductionRow, StationScanRow } from "@/lib/production/floor-manager-snapshot-types";
import {
  CycleCompareBar,
  FloorEmptyState,
  FloorHeroMetric,
  FloorLiveIndicator,
  FloorPanel,
  FloorStatusPill,
  floorTokens,
  fmtCycle,
  fmtPct,
} from "../floor-board-ui";

function stationVariant(s: StationScanRow): "active" | "paused" | "hold" | "rework" | "idle" | "neutral" {
  if (s.reworkPending) return "rework";
  if (s.isPaused) return "paused";
  if (s.isOnHold) return "hold";
  if (s.workflowBagId) return "active";
  if (s.idleMinutes != null && s.idleMinutes > 5) return "idle";
  return "neutral";
}

function stationStatusLabel(s: StationScanRow): string {
  if (s.reworkPending) return "rework";
  if (s.isPaused) return "paused";
  if (s.isOnHold) return "hold";
  if (s.workflowBagId) return "active";
  if (s.idleMinutes != null && s.idleMinutes > 5) return `idle ${s.idleMinutes}m`;
  return "open";
}

function MachineCard({ m }: { m: MachineProductionRow }) {
  const active = Boolean(m.currentReceiptNumber);
  return (
    <article
      className={[
        "rounded-xl border p-3 min-w-[200px] max-w-[280px] shrink-0 snap-start",
        "bg-gradient-to-b from-slate-900/80 to-slate-950/90 transition-colors",
        active
          ? "border-emerald-500/35 shadow-[0_0_20px_-6px_rgba(52,211,153,0.35)]"
          : "border-white/[0.08]",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-slate-100 truncate">{m.name}</h4>
          <p className="text-[10px] text-slate-500 capitalize">
            {m.kind.replace(/_/g, " ").toLowerCase()}
          </p>
        </div>
        <FloorStatusPill variant={active ? "active" : "idle"}>
          {active ? "running" : "idle"}
        </FloorStatusPill>
      </div>

      <div className="mt-3 rounded-lg border border-white/[0.06] bg-black/20 px-2.5 py-2">
        {active ? (
          <>
            <div className="text-[10px] uppercase tracking-wider text-slate-500">On line</div>
            <div className="text-sm font-mono font-medium text-emerald-300 tabular-nums truncate">
              {m.currentReceiptNumber}
            </div>
            <p className="text-[11px] text-slate-400 mt-1 truncate">
              {m.currentProductName ?? "—"}
              {m.currentOperatorName ? ` · ${m.currentOperatorName}` : ""}
            </p>
          </>
        ) : (
          <p className="text-[11px] text-slate-600 py-1">No bag on line</p>
        )}
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div>
          <div className={floorTokens.label}>7d cycle</div>
          <div className="text-xs font-semibold text-slate-200 tabular-nums mt-0.5">
            {fmtCycle(m.avgCycleSec7d)}
          </div>
        </div>
        <div>
          <div className={floorTokens.label}>Shift</div>
          <div className="text-xs font-semibold text-slate-200 tabular-nums mt-0.5">
            {fmtCycle(m.avgCycleSecShift)}
          </div>
        </div>
        <div>
          <div className={floorTokens.label}>Today</div>
          <div className="text-xs font-semibold text-slate-200 tabular-nums mt-0.5">
            {m.todayFinalized}b
          </div>
        </div>
      </div>

      <div className="mt-2">
        <CycleCompareBar
          shiftSec={m.avgCycleSecShift}
          baselineSec={m.p90CycleSec7d ?? m.avgCycleSec7d}
          label="Shift vs 7d baseline"
        />
      </div>
    </article>
  );
}

function StationCard({ s }: { s: StationScanRow }) {
  const variant = stationVariant(s);
  return (
    <article
      className={[
        "rounded-lg border px-2.5 py-2 min-w-[148px] max-w-[180px] shrink-0 snap-start",
        s.workflowBagId
          ? "border-white/[0.1] bg-slate-900/60"
          : "border-white/[0.05] bg-slate-950/40 opacity-90",
      ].join(" ")}
    >
      <div className="flex items-center justify-between gap-1">
        <span className="text-[11px] font-medium text-slate-200 truncate">{s.label}</span>
        <FloorStatusPill variant={variant}>{stationStatusLabel(s)}</FloorStatusPill>
      </div>
      {s.machineName && (
        <p className="text-[10px] text-slate-600 truncate mt-0.5">{s.machineName}</p>
      )}
      <div className="mt-2 font-mono text-xs text-slate-300 tabular-nums truncate">
        {s.receiptNumber ?? <span className="text-slate-600 font-sans">—</span>}
      </div>
      <p className="text-[10px] text-slate-500 truncate mt-0.5">{s.productName ?? "—"}</p>
      <p className="text-[10px] text-slate-600 truncate">{s.operatorName ?? "—"}</p>
    </article>
  );
}

function AlertBanner({ snapshot }: { snapshot: FloorManagerSnapshot }) {
  const alerts: Array<{ text: string; tone: "warn" | "danger" }> = [];
  const oldest = snapshot.inFlight[0];
  if (oldest && oldest.elapsedMinutes > 180) {
    alerts.push({
      text: `Stalled flow — oldest bag ${oldest.receiptNumber ?? "?"} at ${oldest.elapsedMinutes}m`,
      tone: "danger",
    });
  }
  if (snapshot.plant.damageClusterActive) {
    alerts.push({ text: "Damage cluster this hour — check packaging QC", tone: "danger" });
  }
  if (snapshot.plant.laneImbalanceLabel) {
    alerts.push({ text: snapshot.plant.laneImbalanceLabel, tone: "warn" });
  }
  if (
    snapshot.plant.materialRunwayDays != null &&
    snapshot.plant.materialRunwayDays < 3
  ) {
    alerts.push({
      text: `Material runway ${snapshot.plant.materialRunwayDays.toFixed(1)} days`,
      tone: "warn",
    });
  }

  if (alerts.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 px-3 py-2 border-b border-white/[0.06] bg-slate-950/80">
      {alerts.map((a) => (
        <div
          key={a.text}
          className={[
            "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium",
            a.tone === "danger"
              ? "border-red-500/40 bg-red-500/10 text-red-200"
              : "border-amber-500/40 bg-amber-500/10 text-amber-100",
          ].join(" ")}
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {a.text}
        </div>
      ))}
    </div>
  );
}

export function ProductionManagerWidget({
  snapshot,
}: {
  snapshot: FloorManagerSnapshot;
}) {
  const { plant } = snapshot;

  const yieldChart = snapshot.products.slice(0, 6).map((p) => ({
    name: p.productName.length > 14 ? `${p.productName.slice(0, 12)}…` : p.productName,
    yield: p.yieldPct ?? 0,
    units: p.unitsYielded,
  }));

  const damageTone =
    (plant.damageRatePctShift ?? 0) > 2
      ? "danger"
      : (plant.damageRatePctShift ?? 0) > 0
        ? "warn"
        : "neutral";

  return (
    <div className="flex flex-col h-full overflow-hidden text-slate-100 bg-[#070b14]">
      <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-white/[0.06] shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Factory className="h-4 w-4 text-amber-400 shrink-0" strokeWidth={1.75} aria-hidden />
          <div>
            <h2 className="text-sm font-semibold text-slate-50 tracking-tight">
              Production command
            </h2>
            <p className={floorTokens.panelSub}>
              Machines · scans · material yield · floor health
            </p>
          </div>
        </div>
        <FloorLiveIndicator />
      </div>

      <AlertBanner snapshot={snapshot} />

      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2 p-3 border-b border-white/[0.06] shrink-0">
        <FloorHeroMetric label="WIP bags" value={String(plant.bagsInFlow)} tone="accent" />
        <FloorHeroMetric
          label="Finalized shift"
          value={String(plant.bagsFinalizedShift)}
          tone="success"
        />
        <FloorHeroMetric
          label="Units shift"
          value={plant.unitsYieldedShift.toLocaleString()}
        />
        <FloorHeroMetric label="Avg cycle" value={fmtCycle(plant.avgCycleSecShift)} />
        <FloorHeroMetric label="Yield" value={fmtPct(plant.avgYieldPctShift)} />
        <FloorHeroMetric label="Damage" value={fmtPct(plant.damageRatePctShift)} tone={damageTone} />
        <FloorHeroMetric
          label="Pause today"
          value={`${plant.pauseMinutesToday}m`}
          sub={`~$${plant.pauseCostUsdToday}`}
          tone={plant.pauseMinutesToday > 30 ? "warn" : "neutral"}
        />
        <FloorHeroMetric
          label="Material runway"
          value={
            plant.materialRunwayDays != null
              ? `${plant.materialRunwayDays.toFixed(1)}d`
              : "—"
          }
          tone={
            plant.materialRunwayDays != null && plant.materialRunwayDays < 3
              ? "warn"
              : "neutral"
          }
        />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        <div className="p-3 space-y-3">
          <FloorPanel
            title="Machines"
            subtitle="Cycle time vs baseline · live receipt on line"
            bodyClassName="p-3"
          >
            {snapshot.machines.length === 0 ? (
              <FloorEmptyState
                icon={Factory}
                title="No machines configured"
                description="Add machines in settings to track cycle and output."
              />
            ) : (
              <div className="flex gap-3 overflow-x-auto pb-1 snap-x snap-mandatory scrollbar-thin">
                {snapshot.machines.map((m) => (
                  <MachineCard key={m.machineId} m={m} />
                ))}
              </div>
            )}
          </FloorPanel>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            <FloorPanel
              title="Station scans"
              subtitle="What is on each station right now"
              bodyClassName="p-3"
            >
              {snapshot.stations.length === 0 ? (
                <FloorEmptyState icon={ScanLine} title="No stations" />
              ) : (
                <div className="flex gap-2 overflow-x-auto pb-1 snap-x snap-mandatory">
                  {snapshot.stations.map((s) => (
                    <StationCard key={s.stationId} s={s} />
                  ))}
                </div>
              )}
            </FloorPanel>

            <FloorPanel
              title="Material → product"
              subtitle="Shift yield by flavor"
              bodyClassName="p-3 space-y-3"
            >
              {snapshot.products.length === 0 ? (
                <FloorEmptyState
                  icon={Package}
                  title="No finalized bags this shift"
                  description="Yield and tablet-to-unit ratios appear after first finalize."
                />
              ) : (
                <>
                  <div className="h-[100px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={yieldChart} layout="vertical" margin={{ left: 4, right: 8 }}>
                        <XAxis type="number" domain={[0, 100]} hide />
                        <YAxis
                          type="category"
                          dataKey="name"
                          width={72}
                          tick={{ fill: "#64748b", fontSize: 10 }}
                          axisLine={false}
                          tickLine={false}
                        />
                        <Tooltip
                          cursor={{ fill: "rgba(255,255,255,0.04)" }}
                          contentStyle={{
                            background: "#0f172a",
                            border: "1px solid rgba(255,255,255,0.1)",
                            borderRadius: 8,
                            fontSize: 11,
                          }}
                          formatter={(v, _n, item) => {
                            const row = item.payload as { units: number };
                            return [`${v}% · ${row.units.toLocaleString()} units`, "Yield"];
                          }}
                        />
                        <Bar dataKey="yield" radius={[0, 4, 4, 0]} maxBarSize={14}>
                          {yieldChart.map((_, i) => (
                            <Cell
                              key={i}
                              fill={
                                (yieldChart[i]?.yield ?? 0) >= 95
                                  ? "#34d399"
                                  : (yieldChart[i]?.yield ?? 0) >= 85
                                    ? "#f59e0b"
                                    : "#f87171"
                              }
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="overflow-x-auto rounded-lg border border-white/[0.06]">
                    <table className="w-full text-left">
                      <thead>
                        <tr className="text-[10px] uppercase tracking-wider text-slate-500 border-b border-white/[0.06]">
                          <th className="px-2 py-1.5 font-medium">Product</th>
                          <th className="px-2 py-1.5 font-medium">In</th>
                          <th className="px-2 py-1.5 font-medium">Out</th>
                          <th className="px-2 py-1.5 font-medium">Yield</th>
                          <th className="px-2 py-1.5 font-medium">Dmg</th>
                        </tr>
                      </thead>
                      <tbody>
                        {snapshot.products.map((p) => (
                          <tr
                            key={p.productId}
                            className="border-t border-white/[0.04] hover:bg-white/[0.03]"
                          >
                            <td className="px-2 py-1.5 text-[11px] text-slate-200 max-w-[100px] truncate">
                              {p.productName}
                            </td>
                            <td className="px-2 py-1.5 text-[11px] tabular-nums text-slate-400">
                              {p.inputPills.toLocaleString()}
                            </td>
                            <td className="px-2 py-1.5 text-[11px] tabular-nums text-slate-300">
                              {p.unitsYielded.toLocaleString()}
                            </td>
                            <td className="px-2 py-1.5 text-[11px] tabular-nums text-emerald-400/90">
                              {fmtPct(p.yieldPct)}
                            </td>
                            <td className="px-2 py-1.5 text-[11px] tabular-nums text-slate-500">
                              {fmtPct(p.damageRatePct)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </FloorPanel>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <FloorPanel title="Operators today" bodyClassName="p-0">
              {snapshot.operators.length === 0 ? (
                <FloorEmptyState
                  icon={Users}
                  title="No operator activity"
                  description="Shows when bags are finalized with operator attribution."
                />
              ) : (
                <ul className="divide-y divide-white/[0.05]">
                  {snapshot.operators.map((o, i) => (
                    <li
                      key={i}
                      className="flex items-center justify-between gap-2 px-3 py-2 hover:bg-white/[0.02]"
                    >
                      <span className="text-[12px] text-slate-200 truncate">{o.displayName}</span>
                      <span className="text-[11px] tabular-nums text-slate-500 shrink-0">
                        {o.bagsFinalized} bags · {o.activeHours}h
                        {o.damageEvents > 0 && (
                          <span className="text-amber-400/90"> · {o.damageEvents} dmg</span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </FloorPanel>

            <FloorPanel title="Downtime today" bodyClassName="p-0">
              {snapshot.downtimeToday.length === 0 ? (
                <FloorEmptyState
                  icon={Pause}
                  title="No pauses logged"
                  description="Pause reasons and minutes lost appear here."
                />
              ) : (
                <ul className="divide-y divide-white/[0.05]">
                  {snapshot.downtimeToday.map((d) => (
                    <li
                      key={d.reason}
                      className="flex items-center justify-between px-3 py-2 hover:bg-white/[0.02]"
                    >
                      <span className="text-[12px] text-slate-300 capitalize">
                        {d.reason.replace(/_/g, " ")}
                      </span>
                      <span className="text-[11px] tabular-nums text-slate-500">
                        {d.totalMinutes}m · {d.occurrences}×
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </FloorPanel>

            <FloorPanel title="Oldest in-flight" bodyClassName="p-0">
              {snapshot.inFlight.length === 0 ? (
                <FloorEmptyState icon={Clock} title="No bags in flight" />
              ) : (
                <ul className="divide-y divide-white/[0.05]">
                  {snapshot.inFlight.slice(0, 8).map((b, i) => (
                    <li
                      key={i}
                      className="flex items-center justify-between gap-2 px-3 py-2 hover:bg-white/[0.02]"
                    >
                      <div className="min-w-0">
                        <div className="font-mono text-[11px] text-slate-200 truncate">
                          {b.receiptNumber ?? "—"}
                        </div>
                        <div className="text-[10px] text-slate-500 truncate">
                          {b.productName ?? "—"} · {b.stage ?? "—"}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span
                          className={[
                            "text-[11px] font-semibold tabular-nums",
                            b.elapsedMinutes > 120 ? "text-red-400" : "text-slate-400",
                          ].join(" ")}
                        >
                          {b.elapsedMinutes}m
                        </span>
                        {b.isPaused && (
                          <Pause className="h-3 w-3 text-amber-400" aria-label="Paused" />
                        )}
                        {b.isOnHold && (
                          <Ban className="h-3 w-3 text-red-400" aria-label="On hold" />
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </FloorPanel>
          </div>
        </div>
      </div>
    </div>
  );
}
