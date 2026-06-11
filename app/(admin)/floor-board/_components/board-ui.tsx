// Shared design language for the floor board. Server-safe (no hooks).
//
// Two production lines get two unmistakable accent identities:
//   card line   → cyan
//   bottle line → violet
// Everything else stays in the dark slate command-center palette.

import type { ReactNode } from "react";

export const board = {
  panel:
    "rounded-xl border border-white/[0.07] bg-gradient-to-b from-slate-900/80 to-slate-950/90",
  panelPad: "px-4 py-3",
  eyebrow:
    "text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500",
  heroValue:
    "text-2xl font-semibold tabular-nums tracking-tight text-slate-50",
  sub: "text-[11px] text-slate-400",
  subtle: "text-[11px] text-slate-500",
} as const;

export type LineAccent = "card" | "bottle";

export const lineAccents: Record<
  LineAccent,
  {
    name: string;
    laneBorder: string;
    headerText: string;
    chipBg: string;
    dot: string;
    bar: string;
  }
> = {
  card: {
    name: "CARD LINE",
    laneBorder: "border-l-4 border-l-cyan-400/70",
    headerText: "text-cyan-300",
    chipBg: "bg-cyan-400/10 text-cyan-300 border-cyan-400/30",
    dot: "bg-cyan-400",
    bar: "bg-cyan-400/80",
  },
  bottle: {
    name: "BOTTLE LINE",
    laneBorder: "border-l-4 border-l-violet-400/70",
    headerText: "text-violet-300",
    chipBg: "bg-violet-400/10 text-violet-300 border-violet-400/30",
    dot: "bg-violet-400",
    bar: "bg-violet-400/80",
  },
};

export function Chip({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "crit" | "muted" | "info";
  children: ReactNode;
}) {
  const tones: Record<string, string> = {
    ok: "bg-emerald-400/10 text-emerald-300 border-emerald-400/25",
    warn: "bg-amber-400/10 text-amber-300 border-amber-400/25",
    crit: "bg-red-400/10 text-red-300 border-red-400/30",
    info: "bg-sky-400/10 text-sky-300 border-sky-400/25",
    muted: "bg-white/[0.04] text-slate-400 border-white/[0.08]",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/** Compact number: 12482 → "12.5k". Full precision under 10k. */
export function compactUnits(n: number): string {
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString();
}
