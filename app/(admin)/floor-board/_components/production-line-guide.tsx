"use client";

import Link from "next/link";
import { ChevronDown, ChevronUp, Info } from "lucide-react";
import { useState } from "react";
import {
  primaryLineForRows,
  type ProductionLineDefinition,
} from "@/lib/floor-command/production-lines";
import type { StationCommandRow } from "@/lib/production/floor-manager-snapshot-types";

type Props = {
  rows: StationCommandRow[];
};

export function ProductionLineGuide({ rows }: Props) {
  const [open, setOpen] = useState(false);
  const line: ProductionLineDefinition = primaryLineForRows(rows);

  return (
    <div className="shrink-0 border-b border-white/[0.06] bg-[#0a0d12] px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
            Production line
          </p>
          <p className="text-sm font-semibold text-slate-100">{line.name}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden md:flex items-center gap-1.5 text-[11px] text-slate-400">
            {line.steps.map((step, i) => (
              <span key={step.key} className="inline-flex items-center gap-1.5">
                {i > 0 && (
                  <span className="text-slate-600" aria-hidden>
                    →
                  </span>
                )}
                <span>
                  <span className="text-amber-400/90 font-semibold">
                    {step.step}.
                  </span>{" "}
                  {step.label}
                </span>
              </span>
            ))}
          </div>
          <Link
            href="/settings/blister-standards"
            className="hidden sm:inline text-[10px] text-sky-400/90 hover:text-sky-300"
          >
            Roll yield →
          </Link>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-1 rounded border border-white/10 bg-white/[0.03] px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400 hover:text-slate-200"
          >
            <Info size={12} aria-hidden />
            Roles
            {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
        </div>
      </div>
      {open && (
        <div className="mt-2 grid gap-2 md:grid-cols-3">
          {line.steps.map((step) => (
            <div
              key={step.key}
              className="rounded-md border border-white/[0.08] bg-black/20 px-2.5 py-2"
            >
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-amber-400/80">
                Step {step.step} · {step.label}
              </p>
              <p className="mt-1 text-[11px] leading-snug text-slate-400">
                {step.role}
              </p>
            </div>
          ))}
        </div>
      )}
      <p className="mt-1.5 text-[10px] text-slate-600">
        Stations below follow this order left → right. Full doc:{" "}
        <code className="text-slate-500">docs/PRODUCTION_LINE_LAYOUT.md</code>
      </p>
    </div>
  );
}
