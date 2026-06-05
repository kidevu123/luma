import { formatWeightKg } from "@/lib/ui/luma-display";
import type {
  ActiveRollRunwayRow,
  RollReconciliationRow,
} from "@/lib/production/roll-yield-reconciliation";
import { MANUFACTURER_YIELD_DEFAULTS } from "@/lib/production/blister-cycle-math";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusPill } from "@/components/ui/page-header";
import {
  DataTable,
  THead,
  TR,
  TH,
  TD,
} from "@/components/ui/table";

type Props = {
  rows: RollReconciliationRow[];
  activeRunway: ActiveRollRunwayRow[];
  cardsPerTurn: number;
};

function fmt(n: number | null | undefined, suffix = ""): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toLocaleString()}${suffix}`;
}

function fmtKgFromGrams(g: number | null | undefined): string {
  return formatWeightKg(g);
}

function yieldBadge(pct: number | null) {
  if (pct == null) return <StatusPill kind="warn">Missing</StatusPill>;
  if (pct >= 90) return <StatusPill kind="ok">{pct}%</StatusPill>;
  if (pct >= 70) return <StatusPill kind="info">{pct}%</StatusPill>;
  return <StatusPill kind="warn">{pct}%</StatusPill>;
}

export function RollYieldReconciliationPanel({
  rows,
  activeRunway,
  cardsPerTurn,
}: Props) {
  const completed = rows.filter((r) => !r.isMounted && r.machineCycles > 0);

  return (
    <div className="space-y-5">
      <Card className="border-brand-accent/25">
        <CardHeader>
          <CardTitle className="text-base">How we count blister output</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-text-muted space-y-2">
          <p>
            Operators enter <strong>machine cycles</strong> at blister complete and
            roll change. Blister Machine is configured for{" "}
            <strong>{cardsPerTurn} cards per cycle</strong> — finished cards = cycles
            × {cardsPerTurn}.
          </p>
          <p>
            <strong>Manufacturer spec</strong> (
            {MANUFACTURER_YIELD_DEFAULTS.PVC.blistersPerKg.toLocaleString()} PVC cycles/kg,{" "}
            {MANUFACTURER_YIELD_DEFAULTS.FOIL.blistersPerKg.toLocaleString()} foil cycles/kg)
            compares to raw cycles only — not multiplied by {cardsPerTurn}.
          </p>
          <p className="text-xs text-text-subtle">
            Packaging cards = prorated{" "}
            <code className="text-[11px]">read_bag_metrics.units_yielded</code> (master
            cases + displays + loose) for bags that ran on each roll.
          </p>
        </CardContent>
      </Card>

      {activeRunway.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>On the machine now — estimated remaining</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid md:grid-cols-2 gap-4">
              {activeRunway.map((r) => (
                <div
                  key={`${r.materialRole}-${r.rollNumber}`}
                  className="rounded-lg border border-border bg-surface px-4 py-3 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">
                      {r.materialRole} · {r.rollNumber ?? "—"}
                    </span>
                    <span className="text-xs text-text-muted">{r.machineName}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    <span className="text-text-muted">Net weight</span>
                    <span className="text-right tabular-nums">{r.netKg ?? "—"} kg</span>
                    <span className="text-text-muted">Cycles so far</span>
                    <span className="text-right tabular-nums">
                      {fmt(r.machineCyclesUsed)}
                    </span>
                    <span className="text-text-muted">Cards so far (×{r.cardsPerTurn})</span>
                    <span className="text-right tabular-nums font-medium">
                      {fmt(r.cardsProducedSoFar)}
                    </span>
                    <span className="text-text-muted">Packaging cards (finalized)</span>
                    <span className="text-right tabular-nums">
                      {fmt(r.packagingCardsSoFar)}
                    </span>
                    <span className="text-text-muted">Cycles left @ mfr rate</span>
                    <span className="text-right tabular-nums">
                      {fmt(r.remainingCyclesVsManufacturer)}
                    </span>
                    <span className="text-text-muted">Cards left @ mfr rate</span>
                    <span className="text-right tabular-nums text-brand-accent font-semibold">
                      {fmt(r.remainingCardsVsManufacturer)}
                    </span>
                    <span className="text-text-muted">Material left @ mfr rate</span>
                    <span className="text-right tabular-nums text-brand-accent font-semibold">
                      {r.remainingKgVsManufacturer != null
                        ? `${r.remainingKgVsManufacturer} kg`
                        : "—"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Per roll — blister room vs packaging vs manufacturer</CardTitle>
        </CardHeader>
        <CardContent>
          {completed.length === 0 ? (
            <p className="text-sm text-text-muted">
              No completed roll cycles with counter segments yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <DataTable>
                <THead>
                  <TR>
                    <TH>Roll</TH>
                    <TH>Role</TH>
                    <TH className="text-right">Net kg</TH>
                    <TH className="text-right">Cycles</TH>
                    <TH className="text-right">Cards (×{cardsPerTurn})</TH>
                    <TH className="text-right">Packaging cards</TH>
                    <TH className="text-right">Process waste</TH>
                    <TH className="text-right">Mfr expected cycles</TH>
                    <TH>Cycle yield</TH>
                    <TH className="text-right">Material waste</TH>
                  </TR>
                </THead>
                <tbody>
                  {completed.map((r) => (
                    <TR key={r.packagingLotId}>
                      <TD className="font-mono text-xs">{r.rollNumber ?? "—"}</TD>
                      <TD>{r.materialRole}</TD>
                      <TD className="text-right tabular-nums">{r.netKg ?? "—"}</TD>
                      <TD className="text-right tabular-nums">
                        {fmt(r.machineCycles)}
                      </TD>
                      <TD className="text-right tabular-nums font-medium">
                        {fmt(r.blisterRoomCards)}
                      </TD>
                      <TD className="text-right tabular-nums">
                        {fmt(r.packagingCards)}
                        {r.finalizedBagCount > 0 && (
                          <span className="block text-[10px] text-text-subtle">
                            {r.finalizedBagCount} bag{r.finalizedBagCount === 1 ? "" : "s"}
                          </span>
                        )}
                      </TD>
                      <TD className="text-right tabular-nums">
                        {r.processWasteCards != null ? (
                          <span
                            className={
                              r.processWasteCards > 0
                                ? "text-amber-700"
                                : "text-good-700"
                            }
                          >
                            {r.processWasteCards > 0 ? "+" : ""}
                            {r.processWasteCards.toLocaleString()}
                          </span>
                        ) : (
                          "—"
                        )}
                      </TD>
                      <TD className="text-right tabular-nums text-text-muted">
                        {fmt(r.manufacturerExpectedCycles)}
                      </TD>
                      <TD>{yieldBadge(r.cycleYieldVsManufacturerPct)}</TD>
                      <TD className="text-right tabular-nums">
                        {r.materialWasteGramsVsManufacturer != null
                          ? fmtKgFromGrams(r.materialWasteGramsVsManufacturer)
                          : "—"}
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </DataTable>
            </div>
          )}
          <p className="text-[11px] text-text-subtle mt-3 leading-snug">
            <strong>Process waste</strong> = blister cards − packaging cards (positive =
            cards lost after blister). <strong>Material waste</strong> = actual roll
            weight used − weight mfr spec says those cycles should need.{" "}
            <strong>Cycle yield</strong> = cycles ÷ mfr expected cycles.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
