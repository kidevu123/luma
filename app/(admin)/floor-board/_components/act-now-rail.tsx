// Prioritized exceptions. Everything actionable lives here and only
// here — no duplicate "forecast" banners elsewhere on the board.

import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import type { ActNowItem } from "@/lib/floor-command/act-now";
import type { FloorManagerSnapshot } from "@/lib/production/floor-manager-snapshot-types";
import { board } from "./board-ui";

const SEVERITY_STYLES = {
  crit: "border-red-400/30 bg-red-400/[0.06]",
  warn: "border-amber-400/25 bg-amber-400/[0.05]",
  info: "border-sky-400/20 bg-sky-400/[0.04]",
} as const;

const SEVERITY_LABEL = {
  crit: "text-red-300",
  warn: "text-amber-300",
  info: "text-sky-300",
} as const;

export function ActNowRail({
  items,
  dataGaps,
}: {
  items: ActNowItem[];
  dataGaps: FloorManagerSnapshot["dataGaps"];
}) {
  const critGaps = dataGaps.filter((g) => g.status === "crit" || g.status === "missing");

  return (
    <aside className="space-y-3 min-w-0">
      <section className={board.panel}>
        <div className="flex items-center justify-between px-4 pt-3">
          <p className={board.eyebrow}>Act now</p>
          <p className={board.subtle}>{items.length} open</p>
        </div>
        <div className="space-y-2 px-3 pb-3 pt-2">
          {items.length === 0 ? (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-400/20 bg-emerald-400/[0.05] px-3 py-3">
              <CheckCircle2 className="h-4 w-4 text-emerald-300 shrink-0" />
              <p className="text-[12px] text-emerald-200">
                Nothing needs intervention right now.
              </p>
            </div>
          ) : (
            items.map((item) => {
              const inner = (
                <div
                  className={`rounded-lg border px-3 py-2.5 ${SEVERITY_STYLES[item.severity]} ${
                    item.href ? "hover:bg-white/[0.03] transition-colors" : ""
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-[12.5px] font-medium text-slate-100 leading-snug">
                      {item.title}
                    </p>
                    <span
                      className={`text-[9px] font-bold uppercase tracking-wider shrink-0 ${SEVERITY_LABEL[item.severity]}`}
                    >
                      {item.severity}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-slate-400 leading-snug">
                    {item.detail}
                  </p>
                </div>
              );
              return item.href ? (
                <Link key={item.id} href={item.href} className="block">
                  {inner}
                </Link>
              ) : (
                <div key={item.id}>{inner}</div>
              );
            })
          )}
        </div>
      </section>

      {critGaps.length > 0 ? (
        <section className={`${board.panel} ${board.panelPad}`}>
          <p className={board.eyebrow}>Setup gaps</p>
          <p className="mt-1 text-[11px] text-slate-400 leading-snug">
            {critGaps.length} configuration {critGaps.length === 1 ? "gap" : "gaps"} reduce
            data confidence:
          </p>
          <ul className="mt-1.5 space-y-1">
            {critGaps.slice(0, 4).map((g) => (
              <li key={g.id} className="text-[11px] text-slate-500 leading-snug">
                {g.href ? (
                  <Link href={g.href} className="underline underline-offset-2 hover:text-slate-300">
                    {g.label}
                  </Link>
                ) : (
                  g.label
                )}{" "}
                — {g.value}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </aside>
  );
}
