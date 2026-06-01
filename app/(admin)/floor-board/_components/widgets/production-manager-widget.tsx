"use client";

import type { FloorManagerSnapshot } from "@/lib/production/floor-manager-snapshot-types";

function fmtCycle(sec: number | null): string {
  if (sec == null || sec <= 0) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtPct(n: number | null): string {
  if (n == null) return "—";
  return `${n.toFixed(1)}%`;
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="text-left text-[9px] uppercase tracking-wider text-slate-500 font-medium px-2 py-1.5 whitespace-nowrap">
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

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col min-h-0">
      <div className="px-2 py-1.5 border-b border-white/10 bg-slate-900/80">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-cyan-300/90">
          {title}
        </div>
        {subtitle && (
          <div className="text-[9px] text-slate-500 mt-0.5">{subtitle}</div>
        )}
      </div>
      <div className="flex-1 overflow-auto">{children}</div>
    </div>
  );
}

function PlantSummary({ plant }: { plant: FloorManagerSnapshot["plant"] }) {
  const chips: Array<{ label: string; value: string; warn?: boolean }> = [
    { label: "WIP bags", value: String(plant.bagsInFlow) },
    {
      label: "Finalized (shift)",
      value: String(plant.bagsFinalizedShift),
    },
    {
      label: "Units out (shift)",
      value: plant.unitsYieldedShift.toLocaleString(),
    },
    {
      label: "Avg cycle (shift)",
      value: fmtCycle(plant.avgCycleSecShift),
    },
    {
      label: "Yield (shift)",
      value: fmtPct(plant.avgYieldPctShift),
    },
    {
      label: "Damage rate",
      value: fmtPct(plant.damageRatePctShift),
      warn: (plant.damageRatePctShift ?? 0) > 2,
    },
    {
      label: "Pause today",
      value: `${plant.pauseMinutesToday}m (~$${plant.pauseCostUsdToday})`,
    },
    {
      label: "Material runway",
      value:
        plant.materialRunwayDays != null
          ? `${plant.materialRunwayDays.toFixed(1)}d`
          : "—",
      warn:
        plant.materialRunwayDays != null && plant.materialRunwayDays < 3,
    },
  ];

  return (
    <div className="flex flex-wrap gap-2 p-2 border-b border-white/10">
      {chips.map((c) => (
        <div
          key={c.label}
          className={`rounded px-2 py-1 border ${
            c.warn
              ? "border-amber-500/40 bg-amber-500/10"
              : "border-white/10 bg-slate-900/60"
          }`}
        >
          <div className="text-[9px] text-slate-500">{c.label}</div>
          <div className="text-xs font-semibold text-slate-100">{c.value}</div>
        </div>
      ))}
      {plant.laneImbalanceLabel && (
        <div className="rounded px-2 py-1 border border-amber-500/50 bg-amber-500/10 text-[10px] text-amber-200">
          {plant.laneImbalanceLabel}
        </div>
      )}
      {plant.damageClusterActive && (
        <div className="rounded px-2 py-1 border border-red-500/50 bg-red-500/10 text-[10px] text-red-200">
          Damage cluster this hour — check packaging
        </div>
      )}
    </div>
  );
}

export function ProductionManagerWidget({
  snapshot,
}: {
  snapshot: FloorManagerSnapshot;
}) {
  return (
    <div className="flex flex-col h-full overflow-hidden text-slate-100">
      <PlantSummary plant={snapshot.plant} />

      <div className="grid grid-cols-1 xl:grid-cols-2 flex-1 min-h-0 divide-y xl:divide-y-0 xl:divide-x divide-white/10">
        <Section
          title="Machines"
          subtitle="Avg cycle (7d / shift), live bag on line, today's output"
        >
          <table className="w-full">
            <thead className="sticky top-0 bg-slate-950 z-10">
              <tr>
                <Th>Machine</Th>
                <Th>On line now</Th>
                <Th>Cycle 7d</Th>
                <Th>Cycle shift</Th>
                <Th>p90 7d</Th>
                <Th>Units shift</Th>
                <Th>Today</Th>
              </tr>
            </thead>
            <tbody>
              {snapshot.machines.map((m) => (
                <tr key={m.machineId} className="hover:bg-white/5">
                  <Td className="font-medium text-slate-200">
                    {m.name}
                    <span className="block text-[9px] text-slate-500">
                      {m.kind.replace(/_/g, " ").toLowerCase()}
                    </span>
                  </Td>
                  <Td>
                    {m.currentReceiptNumber ? (
                      <>
                        <span className="text-emerald-300">
                          {m.currentReceiptNumber}
                        </span>
                        <span className="block text-[9px] text-slate-500 truncate max-w-[120px]">
                          {m.currentProductName ?? "—"}
                          {m.currentOperatorName
                            ? ` · ${m.currentOperatorName}`
                            : ""}
                        </span>
                      </>
                    ) : (
                      <span className="text-slate-600">idle</span>
                    )}
                  </Td>
                  <Td>{fmtCycle(m.avgCycleSec7d)}</Td>
                  <Td>{fmtCycle(m.avgCycleSecShift)}</Td>
                  <Td>{fmtCycle(m.p90CycleSec7d)}</Td>
                  <Td>
                    {m.unitsProducedShift > 0
                      ? m.unitsProducedShift.toLocaleString()
                      : "—"}
                  </Td>
                  <Td>
                    <span className="block">{m.todayFinalized} bags</span>
                    <span className="text-[9px] text-slate-500">
                      {m.todayUnits} units
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        <div className="flex flex-col min-h-0 divide-y divide-white/10">
          <Section
            title="Stations — what's scanned"
            subtitle="Active bag / receipt at each station"
          >
            <table className="w-full">
              <thead className="sticky top-0 bg-slate-950 z-10">
                <tr>
                  <Th>Station</Th>
                  <Th>Receipt</Th>
                  <Th>Product</Th>
                  <Th>Operator</Th>
                  <Th>Stage</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {snapshot.stations.map((s) => (
                  <tr key={s.stationId} className="hover:bg-white/5">
                    <Td className="text-slate-200">
                      {s.label}
                      {s.machineName && (
                        <span className="block text-[9px] text-slate-500">
                          {s.machineName}
                        </span>
                      )}
                    </Td>
                    <Td>
                      {s.receiptNumber ?? (
                        <span className="text-slate-600">—</span>
                      )}
                    </Td>
                    <Td className="max-w-[100px] truncate">
                      {s.productName ?? "—"}
                    </Td>
                    <Td>{s.operatorName ?? "—"}</Td>
                    <Td>{s.stage ?? "—"}</Td>
                    <Td>
                      {s.reworkPending ? (
                        <span className="text-amber-400">rework</span>
                      ) : s.isPaused ? (
                        <span className="text-amber-400">paused</span>
                      ) : s.isOnHold ? (
                        <span className="text-red-400">hold</span>
                      ) : s.workflowBagId ? (
                        <span className="text-emerald-400">active</span>
                      ) : s.idleMinutes != null && s.idleMinutes > 5 ? (
                        <span className="text-slate-500">
                          idle {s.idleMinutes}m
                        </span>
                      ) : (
                        <span className="text-slate-600">open</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section
            title="Material → finished product (this shift)"
            subtitle="Input tablets vs units yielded, damage, cycle by flavor"
          >
            <table className="w-full">
              <thead className="sticky top-0 bg-slate-950 z-10">
                <tr>
                  <Th>Product</Th>
                  <Th>Bags</Th>
                  <Th>Tablets in</Th>
                  <Th>Units out</Th>
                  <Th>Displays</Th>
                  <Th>Yield</Th>
                  <Th>Damage</Th>
                  <Th>Avg cycle</Th>
                </tr>
              </thead>
              <tbody>
                {snapshot.products.length === 0 ? (
                  <tr>
                    <td
                      colSpan={8}
                      className="text-center text-slate-500 text-xs py-4"
                    >
                      No bags finalized this shift yet
                    </td>
                  </tr>
                ) : (
                  snapshot.products.map((p) => (
                    <tr key={p.productId} className="hover:bg-white/5">
                      <Td className="text-slate-200 max-w-[120px] truncate">
                        {p.productName}
                      </Td>
                      <Td>{p.bagsFinalized}</Td>
                      <Td>{p.inputPills.toLocaleString()}</Td>
                      <Td>{p.unitsYielded.toLocaleString()}</Td>
                      <Td>{p.displaysMade}</Td>
                      <Td>{fmtPct(p.yieldPct)}</Td>
                      <Td>{fmtPct(p.damageRatePct)}</Td>
                      <Td>{fmtCycle(p.avgCycleSec)}</Td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </Section>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 border-t border-white/10 max-h-[28%] min-h-[120px] divide-y md:divide-y-0 md:divide-x divide-white/10">
        <Section title="Operators (today)" subtitle="Bags · active hours · damage">
          <table className="w-full">
            <thead>
              <tr>
                <Th>Operator</Th>
                <Th>Bags</Th>
                <Th>Hrs</Th>
                <Th>Dmg</Th>
              </tr>
            </thead>
            <tbody>
              {snapshot.operators.map((o, i) => (
                <tr key={i}>
                  <Td>{o.displayName}</Td>
                  <Td>{o.bagsFinalized}</Td>
                  <Td>{o.activeHours}</Td>
                  <Td>{o.damageEvents}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        <Section title="Downtime today" subtitle="Pause reasons · minutes lost">
          <table className="w-full">
            <thead>
              <tr>
                <Th>Reason</Th>
                <Th>Count</Th>
                <Th>Min</Th>
              </tr>
            </thead>
            <tbody>
              {snapshot.downtimeToday.map((d) => (
                <tr key={d.reason}>
                  <Td className="capitalize">{d.reason.replace(/_/g, " ")}</Td>
                  <Td>{d.occurrences}</Td>
                  <Td>{d.totalMinutes}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        <Section title="Oldest in-flight bags" subtitle="Not finalized · longest first">
          <table className="w-full">
            <thead>
              <tr>
                <Th>Receipt</Th>
                <Th>Product</Th>
                <Th>Stage</Th>
                <Th>Age</Th>
              </tr>
            </thead>
            <tbody>
              {snapshot.inFlight.slice(0, 8).map((b, i) => (
                <tr key={i}>
                  <Td>{b.receiptNumber ?? "—"}</Td>
                  <Td className="truncate max-w-[80px]">{b.productName ?? "—"}</Td>
                  <Td>{b.stage ?? "—"}</Td>
                  <Td>
                    {b.elapsedMinutes}m
                    {b.isPaused ? " ⏸" : ""}
                    {b.isOnHold ? " ⛔" : ""}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      </div>
    </div>
  );
}
