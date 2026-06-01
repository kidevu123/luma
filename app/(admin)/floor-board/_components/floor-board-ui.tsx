"use client";

import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

/** Shared visual language for the live floor board (industrial OLED dark). */

export const floorTokens = {
  panel:
    "rounded-xl border border-white/[0.08] bg-gradient-to-b from-slate-900/90 to-slate-950/95 shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset]",
  panelHeader: "text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-400/90",
  panelSub: "text-[11px] text-slate-500 leading-snug",
  heroValue: "text-2xl sm:text-3xl font-semibold tabular-nums tracking-tight text-slate-50",
  label: "text-[11px] font-medium uppercase tracking-wider text-slate-500",
  muted: "text-slate-500",
  accent: "text-amber-400",
  success: "text-emerald-400",
  warn: "text-amber-400",
  danger: "text-red-400",
} as const;

export function FloorLiveIndicator({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-emerald-400/90",
        className,
      )}
      aria-label="Live data stream"
    >
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/40 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
      </span>
      Live
    </span>
  );
}

export function FloorPanel({
  title,
  subtitle,
  action,
  children,
  className,
  bodyClassName,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn(floorTokens.panel, "flex flex-col min-h-0 overflow-hidden", className)}>
      <header className="flex items-start justify-between gap-3 px-3 py-2.5 border-b border-white/[0.06] shrink-0">
        <div className="min-w-0">
          <h3 className={floorTokens.panelHeader}>{title}</h3>
          {subtitle && <p className={cn(floorTokens.panelSub, "mt-0.5")}>{subtitle}</p>}
        </div>
        {action}
      </header>
      <div className={cn("flex-1 min-h-0 overflow-auto", bodyClassName)}>{children}</div>
    </section>
  );
}

export function FloorHeroMetric({
  label,
  value,
  sub,
  tone = "neutral",
  className,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "neutral" | "success" | "warn" | "danger" | "accent";
  className?: string;
}) {
  const toneBorder = {
    neutral: "border-white/[0.08]",
    success: "border-emerald-500/30",
    warn: "border-amber-500/35",
    danger: "border-red-500/35",
    accent: "border-indigo-500/30",
  }[tone];

  const toneGlow = {
    neutral: "",
    success: "shadow-[0_0_24px_-8px_rgba(52,211,153,0.35)]",
    warn: "shadow-[0_0_24px_-8px_rgba(245,158,11,0.3)]",
    danger: "shadow-[0_0_24px_-8px_rgba(248,113,113,0.3)]",
    accent: "shadow-[0_0_24px_-8px_rgba(99,102,241,0.25)]",
  }[tone];

  return (
    <div
      className={cn(
        "rounded-xl border bg-slate-900/50 px-3 py-2.5",
        toneBorder,
        toneGlow,
        className,
      )}
    >
      <div className={floorTokens.label}>{label}</div>
      <div className={cn(floorTokens.heroValue, "mt-1")}>{value}</div>
      {sub && <div className="text-[11px] text-slate-500 mt-1 tabular-nums">{sub}</div>}
    </div>
  );
}

export function FloorStatusPill({
  children,
  variant = "neutral",
}: {
  children: React.ReactNode;
  variant?: "neutral" | "active" | "paused" | "hold" | "rework" | "idle" | "warn";
}) {
  const styles = {
    neutral: "bg-slate-800/80 text-slate-400 border-white/10",
    active: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    paused: "bg-amber-500/15 text-amber-200 border-amber-500/35",
    hold: "bg-red-500/15 text-red-300 border-red-500/35",
    rework: "bg-orange-500/15 text-orange-200 border-orange-500/35",
    idle: "bg-slate-800/60 text-slate-500 border-white/8",
    warn: "bg-amber-500/15 text-amber-200 border-amber-500/35",
  }[variant];

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        styles,
      )}
    >
      {children}
    </span>
  );
}

export function FloorEmptyState({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-8 px-4 text-center">
      <div className="rounded-full border border-dashed border-white/10 bg-slate-900/40 p-3">
        <Icon className="h-5 w-5 text-slate-600" strokeWidth={1.5} aria-hidden />
      </div>
      <p className="text-sm font-medium text-slate-400">{title}</p>
      {description && <p className="text-[11px] text-slate-600 max-w-[220px]">{description}</p>}
    </div>
  );
}

/** Compare shift cycle to 7d baseline (0–100% of p90 for visual bar). */
export function CycleCompareBar({
  shiftSec,
  baselineSec,
  label,
}: {
  shiftSec: number | null;
  baselineSec: number | null;
  label?: string;
}) {
  if (shiftSec == null && baselineSec == null) {
    return <span className="text-[11px] text-slate-600">—</span>;
  }
  const base = baselineSec && baselineSec > 0 ? baselineSec : shiftSec ?? 1;
  const pct = shiftSec != null ? Math.min(100, Math.round((shiftSec / base) * 100)) : 0;
  const fast = pct <= 85;
  const slow = pct > 110;

  return (
    <div className="space-y-1" title={label}>
      <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-300",
            fast ? "bg-emerald-500" : slow ? "bg-amber-500" : "bg-indigo-400",
          )}
          style={{ width: `${Math.max(8, pct)}%` }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-slate-500 tabular-nums">
        <span>shift</span>
        <span>{pct}% of baseline</span>
      </div>
    </div>
  );
}

export function fmtCycle(sec: number | null): string {
  if (sec == null || sec <= 0) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtPct(n: number | null): string {
  if (n == null) return "—";
  return `${n.toFixed(1)}%`;
}
