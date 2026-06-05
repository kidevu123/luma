"use client";

import type { FloorManagerSnapshot } from "@/lib/production/floor-manager-snapshot-types";
import type { QueueHealthRow } from "@/lib/floor-command/types";
import type { PauseReasonRow } from "../_loaders";
import { fmtCycle, fmtPct } from "./floor-board-ui";
import { formatWait } from "@/lib/floor-command/floor-display";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";

const TAB_KEY = "luma-floor-shift-deck-tab";

type TabId = "machines" | "staging" | "output" | "downtime";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "machines", label: "Machines" },
  { id: "staging", label: "Staging & WIP" },
  { id: "output", label: "Output" },
  { id: "downtime", label: "Downtime" },
];

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-2 py-1.5 text-left text-[10px] font-medium uppercase tracking-wider text-slate-500 whitespace-nowrap">
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
    <td className={cn("border-t border-white/5 px-2 py-1.5 text-[11px] tabular-nums text-slate-300", className)}>
      {children}
    </td>
  );
}

function MachinesTab({ snapshot }: { snapshot: FloorManagerSnapshot }) {
  return (
    <table className="w-full">
      <thead>
        <tr>
          <Th>Machine</Th>
          <Th>On line</Th>
          <Th>Product</Th>
          <Th>Cycle 7d</Th>
          <Th>Shift</Th>
          <Th>Today</Th>
        </tr>
      </thead>
      <tbody>
        {snapshot.machines.map((m) => (
          <tr key={m.machineId} className="hover:bg-white/[0.03]">
            <Td className="font-medium text-slate-200">{m.name}</Td>
            <Td className="font-mono text-[10px] text-emerald-300">
              {m.currentReceiptNumber ?? "idle"}
            </Td>
            <Td className="max-w-[120px] truncate">{m.currentProductName ?? "—"}</Td>
            <Td>{fmtCycle(m.avgCycleSec7d)}</Td>
            <Td>{fmtCycle(m.avgCycleSecShift)}</Td>
            <Td>
              {m.todayFinalized}b · {m.todayPackaged > 0 ? `${m.todayPackaged} pkg` : `${m.todayUnits}u`}
            </Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StagingTab({
  snapshot,
  queues,
}: {
  snapshot: FloorManagerSnapshot;
  queues: QueueHealthRow[];
}) {
  return (
    <div className="space-y-3">
      <div>
        <h4 className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          WIP by stage
        </h4>
        <table className="w-full">
          <thead>
            <tr>
              <Th>Stage</Th>
              <Th>Count</Th>
              <Th>Oldest</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {snapshot.wipByStage.map((w) => (
              <tr key={w.stage}>
                <Td className="text-slate-200">{w.label}</Td>
                <Td>{w.count}</Td>
                <Td className={w.oldestMinutes > 120 ? "text-red-400" : ""}>
                  {formatWait(w.oldestMinutes)}
                </Td>
                <Td className="text-slate-500">{w.stage}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <h4 className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          Queue health
        </h4>
        <table className="w-full">
          <thead>
            <tr>
              <Th>Stage</Th>
              <Th>WIP</Th>
              <Th>Oldest</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {queues.map((q) => (
              <tr key={q.stageKey}>
                <Td className="text-slate-200">{q.stageKey.replace(/_/g, " ")}</Td>
                <Td>{q.wip}</Td>
                <Td>
                  {q.oldestAgeSeconds != null
                    ? formatWait(Math.floor(q.oldestAgeSeconds / 60))
                    : "—"}
                </Td>
                <Td className={q.queueStatus === "STALLED" ? "text-red-400" : q.queueStatus === "AGING" ? "text-amber-400" : "text-slate-500"}>
                  {q.queueStatus}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <h4 className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          In-flight (oldest first)
        </h4>
        <table className="w-full">
          <thead>
            <tr>
              <Th>Receipt</Th>
              <Th>Stage</Th>
              <Th>Elapsed</Th>
            </tr>
          </thead>
          <tbody>
            {snapshot.inFlight.slice(0, 12).map((b) => (
              <tr key={b.workflowBagId}>
                <Td className="font-mono text-[10px]">{b.receiptNumber ?? "—"}</Td>
                <Td>{b.stage ?? "—"}</Td>
                <Td className={b.elapsedMinutes > 120 ? "text-red-400" : ""}>
                  {formatWait(b.elapsedMinutes)}
                  {b.isPaused ? " · paused" : b.isOnHold ? " · hold" : ""}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function OutputTab({ snapshot }: { snapshot: FloorManagerSnapshot }) {
  return (
    <div className="space-y-3">
      <div>
        <h4 className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          Flavor output today
        </h4>
        <table className="w-full">
          <thead>
            <tr>
              <Th>Product</Th>
              <Th>Units</Th>
              <Th>Bags</Th>
            </tr>
          </thead>
          <tbody>
            {snapshot.flavorToday.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-2 py-3 text-center text-[11px] text-slate-600">
                  No flavor output logged today
                </td>
              </tr>
            ) : (
              snapshot.flavorToday.map((f) => (
                <tr key={f.productName}>
                  <Td className="truncate max-w-[160px] text-slate-200">{f.productName}</Td>
                  <Td>{f.units.toLocaleString()}</Td>
                  <Td>{f.bags}</Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div>
        <h4 className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          Material → product (shift)
        </h4>
        <table className="w-full">
          <thead>
            <tr>
              <Th>Product</Th>
              <Th>In</Th>
              <Th>Out</Th>
              <Th>Disp</Th>
              <Th>Cases</Th>
              <Th>Yield</Th>
            </tr>
          </thead>
          <tbody>
            {snapshot.products.map((p) => (
              <tr key={p.productId}>
                <Td className="truncate max-w-[120px]">{p.productName}</Td>
                <Td>{p.inputPills.toLocaleString()}</Td>
                <Td>{p.unitsYielded.toLocaleString()}</Td>
                <Td>{p.displaysMade}</Td>
                <Td>{p.casesMade}</Td>
                <Td>{fmtPct(p.yieldPct)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <h4 className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          Recent finalized
        </h4>
        <table className="w-full">
          <thead>
            <tr>
              <Th>Receipt</Th>
              <Th>Product</Th>
              <Th>Units</Th>
              <Th>Cycle</Th>
              <Th>Ago</Th>
            </tr>
          </thead>
          <tbody>
            {snapshot.recentFinalized.slice(0, 8).map((r, i) => (
              <tr key={i}>
                <Td className="font-mono text-[10px]">{r.receiptNumber ?? "—"}</Td>
                <Td className="truncate max-w-[100px]">{r.productName ?? "—"}</Td>
                <Td>{r.unitsYielded}</Td>
                <Td>{fmtCycle(r.totalCycleSec)}</Td>
                <Td>{r.minutesAgo}m</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DowntimeTab({
  snapshot,
  pauseReasons,
}: {
  snapshot: FloorManagerSnapshot;
  pauseReasons: PauseReasonRow[];
}) {
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <div>
        <h4 className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          Pause today
        </h4>
        <table className="w-full">
          <tbody>
            {snapshot.downtimeToday.map((d) => (
              <tr key={d.reason}>
                <Td className="capitalize text-slate-400">{d.reason.replace(/_/g, " ")}</Td>
                <Td className="text-right text-amber-400">{d.totalMinutes}m</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <h4 className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          Operators
        </h4>
        <table className="w-full">
          <tbody>
            {snapshot.operators.slice(0, 8).map((o, i) => (
              <tr key={i}>
                <Td>{o.displayName}</Td>
                <Td className="text-right">{o.bagsFinalized}b · {o.activeHours}h</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="lg:col-span-2">
        <h4 className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          Pause reasons (7d)
        </h4>
        <table className="w-full">
          <tbody>
            {pauseReasons.slice(0, 6).map((p) => (
              <tr key={p.reason}>
                <Td className="capitalize">{p.reason.replace(/_/g, " ")}</Td>
                <Td className="text-right">{p.occurrences}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type Props = {
  snapshot: FloorManagerSnapshot;
  queues: QueueHealthRow[];
  pauseReasons: PauseReasonRow[];
  defaultTab?: TabId;
};

export function ShiftDeck({
  snapshot,
  queues,
  pauseReasons,
  defaultTab = "machines",
}: Props) {
  const [tab, setTab] = useState<TabId>(defaultTab);

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(TAB_KEY);
      if (saved === "machines" || saved === "staging" || saved === "output" || saved === "downtime") {
        setTab(saved);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const setTabPersist = (next: TabId) => {
    setTab(next);
    try {
      sessionStorage.setItem(TAB_KEY, next);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="flex max-h-[32vh] min-h-0 flex-col overflow-hidden border-t border-white/[0.06] bg-[#07090d]">
      <div className="flex shrink-0 gap-1 border-b border-white/[0.06] px-2 py-1">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTabPersist(id)}
            className={cn(
              "rounded px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider",
              tab === id
                ? "bg-sky-500/15 text-sky-300 border border-sky-500/40"
                : "text-slate-500 hover:text-slate-300 border border-transparent",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {tab === "machines" && <MachinesTab snapshot={snapshot} />}
        {tab === "staging" && <StagingTab snapshot={snapshot} queues={queues} />}
        {tab === "output" && <OutputTab snapshot={snapshot} />}
        {tab === "downtime" && <DowntimeTab snapshot={snapshot} pauseReasons={pauseReasons} />}
      </div>
    </div>
  );
}

export type { TabId as ShiftDeckTabId };
