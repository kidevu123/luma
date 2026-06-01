"use client";

import type { FloorManagerSnapshot } from "@/lib/production/floor-manager-snapshot-types";
import { fmtCycle, fmtPct } from "../floor-board-ui";

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="text-left text-[10px] uppercase tracking-wider text-slate-500 font-medium px-2 py-1.5 whitespace-nowrap">
      {children}
    </th>
  );
}

function Td({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <td
      className={`text-[11px] text-slate-300 px-2 py-1.5 border-t border-white/5 tabular-nums ${className}`}
    >
      {children}
    </td>
  );
}

function statusClass(s: {
  reworkPending: boolean;
  isPaused: boolean;
  isOnHold: boolean;
  workflowBagId: string | null;
}): string {
  if (s.reworkPending) return "text-orange-400";
  if (s.isPaused) return "text-amber-400";
  if (s.isOnHold) return "text-red-400";
  if (s.workflowBagId) return "text-emerald-400";
  return "text-slate-500";
}

function statusLabel(s: {
  reworkPending: boolean;
  isPaused: boolean;
  isOnHold: boolean;
  workflowBagId: string | null;
  idleMinutes: number | null;
}): string {
  if (s.reworkPending) return "rework";
  if (s.isPaused) return "paused";
  if (s.isOnHold) return "hold";
  if (s.workflowBagId) return "active";
  if (s.idleMinutes != null && s.idleMinutes > 5) return `idle ${s.idleMinutes}m`;
  return "open";
}

/** Dense production tables — no duplicate KPI heroes (see footer metrics). */
export function ProductionManagerWidget({
  snapshot,
  compact = false,
}: {
  snapshot: FloorManagerSnapshot;
  compact?: boolean;
}) {
  const { plant } = snapshot;
  const pad = compact ? "p-1.5" : "p-2";

  return (
    <div className={`flex flex-col h-full overflow-hidden text-slate-100 ${pad} gap-2`}>
      {(plant.laneImbalanceLabel || plant.damageClusterActive) && (
        <div className="flex flex-wrap gap-1.5 shrink-0">
          {plant.laneImbalanceLabel && (
            <span className="text-[10px] px-2 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-200">
              {plant.laneImbalanceLabel}
            </span>
          )}
          {plant.damageClusterActive && (
            <span className="text-[10px] px-2 py-0.5 rounded border border-red-500/40 bg-red-500/10 text-red-200">
              Damage cluster — check packaging
            </span>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 flex-1 min-h-0 gap-2">
        <div className="min-h-0 overflow-auto rounded border border-white/10 bg-slate-900/50">
          <div className="px-2 py-1 border-b border-white/10 text-[10px] font-semibold uppercase tracking-wider text-slate-400 sticky top-0 bg-slate-900 z-10">
            Machines · cycle & live bag
          </div>
          <table className="w-full">
            <thead>
              <tr>
                <Th>Machine</Th>
                <Th>On line</Th>
                <Th>Cycle 7d</Th>
                <Th>Shift</Th>
                <Th>Today</Th>
              </tr>
            </thead>
            <tbody>
              {snapshot.machines.map((m) => (
                <tr key={m.machineId} className="hover:bg-white/[0.03]">
                  <Td className="text-slate-200 font-medium">{m.name}</Td>
                  <Td>
                    {m.currentReceiptNumber ? (
                      <span className="text-emerald-300 font-mono text-[10px]">
                        {m.currentReceiptNumber}
                      </span>
                    ) : (
                      <span className="text-slate-600">idle</span>
                    )}
                  </Td>
                  <Td>{fmtCycle(m.avgCycleSec7d)}</Td>
                  <Td>{fmtCycle(m.avgCycleSecShift)}</Td>
                  <Td>
                    {m.todayFinalized}b / {m.todayUnits}u
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="min-h-0 overflow-auto rounded border border-white/10 bg-slate-900/50">
          <div className="px-2 py-1 border-b border-white/10 text-[10px] font-semibold uppercase tracking-wider text-slate-400 sticky top-0 bg-slate-900 z-10">
            Stations · what&apos;s scanned
          </div>
          <table className="w-full">
            <thead>
              <tr>
                <Th>Station</Th>
                <Th>Receipt</Th>
                <Th>Product</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {snapshot.stations.map((s) => (
                <tr key={s.stationId} className="hover:bg-white/[0.03]">
                  <Td className="text-slate-200">{s.label}</Td>
                  <Td className="font-mono text-[10px]">{s.receiptNumber ?? "—"}</Td>
                  <Td className="max-w-[100px] truncate">{s.productName ?? "—"}</Td>
                  <Td className={statusClass(s)}>{statusLabel(s)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-2 shrink-0 max-h-[32%] min-h-[88px]">
        <div className="overflow-auto rounded border border-white/10 bg-slate-900/50 lg:col-span-1">
          <div className="px-2 py-1 border-b border-white/10 text-[10px] font-semibold uppercase text-slate-400">
            Material → product (shift)
          </div>
          <table className="w-full">
            <thead>
              <tr>
                <Th>Product</Th>
                <Th>In</Th>
                <Th>Out</Th>
                <Th>Yield</Th>
              </tr>
            </thead>
            <tbody>
              {snapshot.products.length === 0 ? (
                <tr>
                  <td colSpan={4} className="text-center text-slate-600 text-[11px] py-3">
                    No finalized bags this shift
                  </td>
                </tr>
              ) : (
                snapshot.products.map((p) => (
                  <tr key={p.productId}>
                    <Td className="truncate max-w-[90px]">{p.productName}</Td>
                    <Td>{p.inputPills.toLocaleString()}</Td>
                    <Td>{p.unitsYielded.toLocaleString()}</Td>
                    <Td>{fmtPct(p.yieldPct)}</Td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="overflow-auto rounded border border-white/10 bg-slate-900/50">
          <div className="px-2 py-1 border-b border-white/10 text-[10px] font-semibold uppercase text-slate-400">
            Operators · downtime
          </div>
          <table className="w-full">
            <tbody>
              {snapshot.operators.slice(0, 4).map((o, i) => (
                <tr key={i}>
                  <Td className="text-slate-300">{o.displayName}</Td>
                  <Td className="text-right">
                    {o.bagsFinalized}b · {o.activeHours}h
                  </Td>
                </tr>
              ))}
              {snapshot.downtimeToday.map((d) => (
                <tr key={d.reason}>
                  <Td className="capitalize text-slate-500">
                    {d.reason.replace(/_/g, " ")}
                  </Td>
                  <Td className="text-right text-amber-400/90">
                    {d.totalMinutes}m
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="overflow-auto rounded border border-white/10 bg-slate-900/50">
          <div className="px-2 py-1 border-b border-white/10 text-[10px] font-semibold uppercase text-slate-400">
            Oldest in-flight
          </div>
          <table className="w-full">
            <tbody>
              {snapshot.inFlight.slice(0, 5).map((b, i) => (
                <tr key={i}>
                  <Td className="font-mono text-[10px]">{b.receiptNumber ?? "—"}</Td>
                  <Td
                    className={
                      b.elapsedMinutes > 120 ? "text-red-400 text-right" : "text-right"
                    }
                  >
                    {b.elapsedMinutes}m
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {!compact && (
        <div className="flex flex-wrap gap-3 text-[10px] text-slate-500 shrink-0 border-t border-white/5 pt-1">
          <span>Shift yield {fmtPct(plant.avgYieldPctShift)}</span>
          <span>Damage {fmtPct(plant.damageRatePctShift)}</span>
          <span>Pause {plant.pauseMinutesToday}m</span>
          <span>
            Runway{" "}
            {plant.materialRunwayDays != null
              ? `${plant.materialRunwayDays.toFixed(1)}d`
              : "—"}
          </span>
        </div>
      )}
    </div>
  );
}
