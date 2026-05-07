// Standards Admin index. Surfaces row counts so the user can see
// at a glance which inputs OEE/labor/on-time are still missing.

import Link from "next/link";
import { count } from "drizzle-orm";
import {
  CalendarDays,
  Gauge,
  DollarSign,
  Target,
  ArrowRight,
} from "lucide-react";
import { db } from "@/lib/db";
import {
  productionCalendars,
  stationStandards,
  laborRates,
  dueTargets,
} from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";

export const dynamic = "force-dynamic";

export default async function StandardsIndex() {
  await requireAdmin();
  const [cal, std, lab, due] = await Promise.all([
    db.select({ n: count() }).from(productionCalendars),
    db.select({ n: count() }).from(stationStandards),
    db.select({ n: count() }).from(laborRates),
    db.select({ n: count() }).from(dueTargets),
  ]);
  const tiles = [
    {
      href: "/standards/calendars",
      label: "Production calendars",
      icon: CalendarDays,
      count: cal[0]?.n ?? 0,
      blocks: "OEE Availability",
    },
    {
      href: "/standards/station-standards",
      label: "Station / machine standards",
      icon: Gauge,
      count: std[0]?.n ?? 0,
      blocks: "OEE Performance, Cycle vs standard, Bottleneck cycle",
    },
    {
      href: "/standards/labor-rates",
      label: "Labor rates",
      icon: DollarSign,
      count: lab[0]?.n ?? 0,
      blocks: "Labor cost per case",
    },
    {
      href: "/standards/due-targets",
      label: "Due targets",
      icon: Target,
      count: due[0]?.n ?? 0,
      blocks: "Schedule gap, On-time completion",
    },
  ];
  return (
    <div className="space-y-5">
      <PageHeader
        title="Standards & targets"
        description="Configure the inputs the production-intelligence layer needs to compute true OEE, labor cost, on-time completion, and bottleneck-vs-standard. Empty by default; until a tile has rows, the matching metrics show 'Insufficient data' on the dashboards."
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {tiles.map(({ href, label, icon: Icon, count, blocks }) => (
          <Link
            key={href}
            href={href}
            className="group rounded-md border border-slate-700/60 bg-slate-900/60 p-4 hover:border-cyan-500/40 transition-colors"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <Icon className="h-5 w-5 text-cyan-400" aria-hidden />
                <h2 className="text-sm font-semibold text-slate-100">{label}</h2>
              </div>
              <ArrowRight
                className="h-4 w-4 text-slate-500 group-hover:text-cyan-400 transition-colors"
                aria-hidden
              />
            </div>
            <div className="mt-3 flex items-baseline gap-2">
              <div className="text-3xl font-mono tabular-nums text-slate-100">
                {Number(count).toLocaleString()}
              </div>
              <div className="text-xs text-slate-500">configured</div>
            </div>
            <div className="mt-2 text-[11px] text-slate-500">
              Required for: {blocks}
            </div>
            {count === 0 && (
              <div className="mt-2 inline-flex items-center h-5 px-1.5 rounded-sm border bg-slate-800/60 border-slate-600/60 text-[10px] text-slate-400">
                NOT CONFIGURED
              </div>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}
