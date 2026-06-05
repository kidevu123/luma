import Link from "next/link";
import type { RollYieldRoleAnswer } from "@/lib/production/roll-yield-summary";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusPill } from "@/components/ui/page-header";

type Props = {
  answers: RollYieldRoleAnswer[];
  compact?: boolean;
};

export function RollYieldAnswerCard({ answers, compact = false }: Props) {
  return (
    <Card className="border-brand-accent/30 bg-brand-accent/[0.04]">
      <CardHeader {...(compact ? { className: "pb-2" } : {})}>
        <CardTitle className="text-base">
          How many blisters per roll?
        </CardTitle>
        {!compact && (
          <p className="text-sm text-text-muted font-normal mt-1">
            One answer for PVC and one for foil — from completed rolls and
            learned weight. This is the number planning and the floor should
            share.
          </p>
        )}
      </CardHeader>
      <CardContent>
        <div className="grid md:grid-cols-2 gap-4">
          {answers.map((a) => (
            <div
              key={a.role}
              className="rounded-lg border border-border bg-surface px-4 py-3 space-y-2"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold">{a.role} roll</span>
                <StatusPill
                  kind={
                    a.source === "MISSING"
                      ? "warn"
                      : a.confidence === "HIGH"
                        ? "ok"
                        : "info"
                  }
                >
                  {a.source === "MISSING"
                    ? "No data"
                    : a.source === "CONFIGURED"
                      ? "Confirmed"
                      : a.source === "LEARNED"
                        ? `Learned (${a.sampleRollCount} rolls)`
                        : `${a.sampleRollCount} roll avg`}
                </StatusPill>
              </div>

              {a.blistersPerKg != null ? (
                <div className="space-y-1">
                  <p className="text-2xl font-semibold tabular-nums text-text">
                    {a.blistersPerKg.toLocaleString()}
                    <span className="text-sm font-normal text-text-muted ml-1">
                      blisters / kg
                    </span>
                  </p>
                  {a.blistersPerTypicalRoll != null && a.typicalRollKg != null && (
                    <p className="text-lg tabular-nums text-text-muted">
                      ≈ {a.blistersPerTypicalRoll.toLocaleString()} blisters per{" "}
                      {a.typicalRollKg} kg roll
                    </p>
                  )}
                  {a.gramsPerBlister != null && (
                    <p className="text-xs text-text-subtle font-mono">
                      {(a.gramsPerBlister / 1000).toFixed(6)} kg per cycle
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-text-muted">{a.headline}</p>
              )}

              <p className="text-xs text-text-subtle leading-snug">{a.detail}</p>

              {a.lastRoll && a.lastRoll.blistersProduced > 0 && (
                <p className="text-[11px] text-text-muted border-t border-border/60 pt-2">
                  Last completed:{" "}
                  <span className="font-mono">{a.lastRoll.rollNumber ?? "—"}</span>
                  {" · "}
                  {a.lastRoll.blistersProduced.toLocaleString()} blisters
                  {a.lastRoll.gramsPerBlister != null &&
                    ` · ${(a.lastRoll.gramsPerBlister / 1000).toFixed(4)} kg/cycle`}
                </p>
              )}
            </div>
          ))}
        </div>
        {!compact && (
          <p className="text-xs text-text-subtle mt-4">
            Detail tables and overrides below. Floor operators: mark rolls{" "}
            <strong>depleted</strong> when empty so the next roll improves this
            average.
          </p>
        )}
        {compact && (
          <Link
            href="/settings/blister-standards"
            className="inline-block mt-3 text-sm text-brand-accent hover:underline"
          >
            Full roll yield breakdown →
          </Link>
        )}
      </CardContent>
    </Card>
  );
}
