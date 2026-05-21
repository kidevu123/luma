// LUMA-UI-REBUILD-1 v2 — Operations Atelier primitive library.
//
// One file, intentionally. Every primitive shares the same tone
// vocabulary, the same rail motif, the same spacing scale, the same
// display numerals. Splitting them into separate files invites drift;
// keeping them together makes the system inspectable in one read.
//
// Tone vocabulary (semantic, never decoration):
//   good  · running / ready / verified / confirmed
//   warn  · degraded / partial / needs review
//   crit  · blocked / conflict / over-allocated
//   info  · neutral signal / data window
//   muted · missing / idle / legacy / waiting
//   brand · earned only for the primary CTA + active nav state + live signal
//
// Signature moves (v2):
//   1. 3px tone rail with a 1px inner highlight + an outer bloom in
//      the rail's own color — reads as a sliver of light.
//   2. Surface cards carry a top-edge highlight + layered shadow.
//   3. Hero band sits on its own backdrop (dual radial + scoped grid).
//   4. RibbonStrip — a unified inverse band carrying massive Fraunces
//      tabular numerals, hairline dividers between segments, with the
//      accent-glow earned only when a segment is live.
//   5. Display numerals run on Fraunces (modern high-contrast serif).
//   6. Page-load reveal: lift-in cascade.

import * as React from "react";
import Link from "next/link";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────
// Tones
// ─────────────────────────────────────────────────────────────────────

export type Tone = "good" | "warn" | "crit" | "info" | "muted" | "brand";

const RAIL_CLASS: Record<Tone, string> = {
  good: "rail-good",
  warn: "rail-warn",
  crit: "rail-crit",
  info: "rail-info",
  muted: "rail-muted",
  brand: "rail-brand",
};

const TONE_TINT: Record<Tone, string> = {
  good: "bg-good-50/70",
  warn: "bg-warn-50/70",
  crit: "bg-crit-50/70",
  info: "bg-info-50/50",
  muted: "bg-surface-2/70",
  brand: "bg-brand-50/50",
};

const TONE_TEXT: Record<Tone, string> = {
  good: "text-good-700",
  warn: "text-warn-700",
  crit: "text-crit-700",
  info: "text-info-700",
  muted: "text-muted-700",
  brand: "text-brand-800",
};

const TONE_BORDER: Record<Tone, string> = {
  good: "border-good-500/35",
  warn: "border-warn-500/35",
  crit: "border-crit-500/35",
  info: "border-info-500/30",
  muted: "border-border",
  brand: "border-brand-500/30",
};

// Inverse counterparts — used on dark backdrops (ribbon segments).
const TONE_TEXT_INVERSE: Record<Tone, string> = {
  good: "text-emerald-300",
  warn: "text-amber-300",
  crit: "text-rose-300",
  info: "text-cyan-300",
  muted: "text-text-inverse/65",
  brand: "text-[rgb(var(--brand-accent-bright))]",
};

// ─────────────────────────────────────────────────────────────────────
// CommandShell — page chrome
// ─────────────────────────────────────────────────────────────────────

export function CommandShell({
  children,
  density = "default",
  className,
}: {
  children: React.ReactNode;
  density?: "default" | "wide" | "wallboard";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative mx-auto w-full",
        density === "wallboard"
          ? "max-w-none px-6 lg:px-10"
          : density === "wide"
            ? "max-w-[1480px] px-5 lg:px-8"
            : "max-w-[1280px] px-5 lg:px-8",
        "py-6 lg:py-8 space-y-7",
        className,
      )}
    >
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// PageHero — the architectural top band
// ─────────────────────────────────────────────────────────────────────

export type HeroBadge = {
  label: string;
  tone?: Tone;
  mono?: boolean;
};

/** Hero band — sits on its own backdrop (brand+accent radial + scoped
 *  grid + layered shadow). Display title runs on Fraunces. A live-signal
 *  brand-accent pip pulses in the eyebrow. Answers four questions in
 *  one glance: what page am I on, what mode am I in, what's the state,
 *  what can I do next. */
export function PageHero({
  eyebrow,
  title,
  description,
  badges,
  actions,
  className,
}: {
  eyebrow?: string;
  title: string;
  description?: React.ReactNode;
  badges?: HeroBadge[];
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "surface-hero reveal reveal-1 px-6 py-7 lg:px-8 lg:py-8",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-8 flex-wrap">
        <div className="min-w-0 max-w-3xl">
          {eyebrow ? (
            <div className="flex items-center gap-2 mb-3">
              <span
                aria-hidden
                className="pulse-accent inline-block h-1.5 w-1.5 rounded-full bg-brand-accent"
              />
              <div className="eyebrow">{eyebrow}</div>
            </div>
          ) : null}
          <h1 className="display-title text-[34px] sm:text-[40px] lg:text-[44px]">
            {title}
          </h1>
          {description ? (
            <p className="mt-3 text-[13.5px] leading-relaxed text-text-muted max-w-2xl">
              {description}
            </p>
          ) : null}
          {badges && badges.length > 0 ? (
            <div className="mt-4 flex flex-wrap items-center gap-1.5">
              {badges.map((b, i) => (
                <StatusBadge
                  key={i}
                  tone={b.tone ?? "muted"}
                  mono={b.mono === true}
                >
                  {b.label}
                </StatusBadge>
              ))}
            </div>
          ) : null}
        </div>
        {actions ? (
          <div className="flex items-center gap-2 shrink-0">{actions}</div>
        ) : null}
      </div>
    </header>
  );
}

// ─────────────────────────────────────────────────────────────────────
// StatusBadge
// ─────────────────────────────────────────────────────────────────────

export function StatusBadge({
  tone = "muted",
  mono = false,
  children,
  icon: Icon,
  className,
}: {
  tone?: Tone;
  mono?: boolean;
  children: React.ReactNode;
  icon?: LucideIcon;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-[3px] text-[11px] font-medium tracking-tight",
        TONE_TINT[tone],
        TONE_BORDER[tone],
        TONE_TEXT[tone],
        mono && "font-mono text-[10.5px] tracking-normal",
        className,
      )}
    >
      {Icon ? <Icon className="h-3 w-3 shrink-0" aria-hidden /> : null}
      {children}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────
// SectionCard — canonical lifted panel
// ─────────────────────────────────────────────────────────────────────

export function SectionCard({
  eyebrow,
  title,
  subtitle,
  tone = "muted",
  actions,
  toolbar,
  children,
  pad = "default",
  className,
  reveal: revealClass,
}: {
  eyebrow?: string;
  title?: string;
  subtitle?: React.ReactNode;
  tone?: Tone;
  actions?: React.ReactNode;
  toolbar?: React.ReactNode;
  children: React.ReactNode;
  pad?: "tight" | "default" | "loose";
  className?: string;
  reveal?: "reveal-2" | "reveal-3" | "reveal-4" | "reveal-5" | "reveal-6";
}) {
  const hasHeader = !!(eyebrow || title || subtitle || actions);
  return (
    <section
      className={cn(
        "surface-card rail",
        RAIL_CLASS[tone],
        "relative pl-[3px] overflow-hidden",
        revealClass ? `reveal ${revealClass}` : "",
        className,
      )}
    >
      {hasHeader ? (
        <header className="flex items-start justify-between gap-4 px-5 pt-4 pb-3 border-b border-border/70">
          <div className="min-w-0">
            {eyebrow ? <div className="eyebrow mb-1.5">{eyebrow}</div> : null}
            {title ? (
              <h2 className="text-[14.5px] font-semibold tracking-tight text-text-strong leading-tight">
                {title}
              </h2>
            ) : null}
            {subtitle ? (
              <p className="mt-1 text-[12px] leading-snug text-text-muted max-w-2xl">
                {subtitle}
              </p>
            ) : null}
          </div>
          {actions ? (
            <div className="flex items-center gap-1.5 shrink-0">{actions}</div>
          ) : null}
        </header>
      ) : null}
      {toolbar ? (
        <div className="px-5 py-2.5 bg-surface-2/40 border-b border-border/70 flex flex-wrap items-center gap-2">
          {toolbar}
        </div>
      ) : null}
      <div
        className={cn(
          pad === "tight"
            ? "px-4 py-3"
            : pad === "loose"
              ? "px-6 py-5"
              : "px-5 py-4",
        )}
      >
        {children}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────
// ActionPanel — the alert / banner band
// ─────────────────────────────────────────────────────────────────────

export function ActionPanel({
  tone = "info",
  title,
  body,
  action,
  icon: Icon,
  className,
}: {
  tone?: Tone;
  title: string;
  body?: React.ReactNode;
  action?: React.ReactNode;
  icon?: LucideIcon;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rail",
        RAIL_CLASS[tone],
        "relative pl-[3px] rounded-[12px] border bg-surface shadow-card overflow-hidden",
        TONE_BORDER[tone],
        className,
      )}
      role="status"
    >
      <div className="flex items-start gap-3.5 px-5 py-4">
        {Icon ? (
          <span
            className={cn(
              "shrink-0 mt-0.5 inline-flex h-7 w-7 items-center justify-center rounded-md border",
              TONE_BORDER[tone],
              TONE_TINT[tone],
              TONE_TEXT[tone],
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "text-[13.5px] font-semibold tracking-tight",
              TONE_TEXT[tone],
            )}
          >
            {title}
          </p>
          {body ? (
            <div className="mt-1 text-[12.5px] leading-relaxed text-text-muted">
              {body}
            </div>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// StatusCard — summary tile
// ─────────────────────────────────────────────────────────────────────

export function StatusCard({
  label,
  value,
  hint,
  tone = "muted",
  icon: Icon,
  href,
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: Tone;
  icon?: LucideIcon;
  href?: string;
  className?: string;
}) {
  const inner = (
    <div
      className={cn(
        "surface-card rail",
        RAIL_CLASS[tone],
        "relative pl-[3px] px-4 py-4",
        href && "lift-on-hover hover:border-border-strong cursor-pointer",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="eyebrow">{label}</div>
          <div className="mt-2 display-num text-[32px] sm:text-[36px]">
            {value}
          </div>
          {hint ? (
            <div className="mt-1.5 text-[11px] text-text-muted leading-snug">
              {hint}
            </div>
          ) : null}
        </div>
        {Icon ? (
          <span
            className={cn(
              "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border",
              TONE_TINT[tone],
              TONE_BORDER[tone],
              TONE_TEXT[tone],
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </span>
        ) : null}
      </div>
    </div>
  );
  if (href) return <Link href={href} className="block">{inner}</Link>;
  return inner;
}

// ─────────────────────────────────────────────────────────────────────
// RibbonStrip + RibbonSegment — unified inverse KPI band
// ─────────────────────────────────────────────────────────────────────

export type RibbonSegmentData = {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: Tone;
  /** Pulses the brand-accent dot when true — earn it, only one live
   *  segment per ribbon is the rule. */
  live?: boolean;
  /** Optional icon glyph rendered above the label. */
  icon?: LucideIcon;
};

/** The signature KPI band. One dark surface, hairline dividers between
 *  segments, massive Fraunces tabular numerals. Use sparingly — one
 *  per page maximum, at the top of the data layer. */
export function RibbonStrip({
  segments,
  className,
  reveal: revealClass,
}: {
  segments: RibbonSegmentData[];
  className?: string;
  reveal?: "reveal-2" | "reveal-3" | "reveal-4";
}) {
  return (
    <div
      className={cn(
        "surface-ribbon",
        revealClass ? `reveal ${revealClass}` : "",
        className,
      )}
    >
      <div
        className="grid"
        style={{
          gridTemplateColumns: `repeat(${segments.length}, minmax(0, 1fr))`,
        }}
      >
        {segments.map((s, i) => (
          <RibbonSegment key={i} {...s} isLast={i === segments.length - 1} />
        ))}
      </div>
    </div>
  );
}

function RibbonSegment({
  label,
  value,
  hint,
  tone = "muted",
  live,
  icon: Icon,
  isLast,
}: RibbonSegmentData & { isLast: boolean }) {
  // The numeric value can be 8+ digits with commas; the segment must
  // never bleed into its neighbour. min-w-0 lets the grid track
  // shrink; the clamp() font-size scales between cramped and roomy
  // viewport widths so large numbers fit without truncation in most
  // cases. truncate is the final safety net.
  return (
    <div
      className={cn(
        "relative min-w-0 px-4 py-5 lg:px-5 lg:py-6",
        !isLast && "border-r border-white/[0.07]",
      )}
    >
      <div className="flex items-center gap-2 mb-3">
        {live ? (
          <span
            aria-hidden
            className="pulse-accent inline-block h-1.5 w-1.5 rounded-full bg-brand-accent shrink-0"
          />
        ) : Icon ? (
          <span
            className={cn(
              "inline-flex h-4 w-4 items-center justify-center shrink-0",
              TONE_TEXT_INVERSE[tone],
            )}
          >
            <Icon className="h-3 w-3" />
          </span>
        ) : null}
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-inverse/55 truncate">
          {label}
        </div>
      </div>
      <div
        className={cn(
          "display-num text-text-inverse truncate",
          TONE_TEXT_INVERSE[tone],
        )}
        style={{ fontSize: "clamp(26px, 3.2vw, 46px)" }}
        title={
          typeof value === "string" || typeof value === "number"
            ? String(value)
            : undefined
        }
      >
        {value}
      </div>
      {hint ? (
        <div className="mt-2 text-[11px] text-text-inverse/55 leading-snug line-clamp-2">
          {hint}
        </div>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// RecordCard — clickable record summary
// ─────────────────────────────────────────────────────────────────────

export function RecordCard({
  selected = false,
  tone = "muted",
  onClick,
  children,
  className,
  as = "button",
  href,
}: {
  selected?: boolean;
  tone?: Tone;
  onClick?: () => void;
  children: React.ReactNode;
  className?: string;
  as?: "button" | "div";
  href?: string;
}) {
  const railTone: Tone = selected ? "brand" : tone;
  const classes = cn(
    "surface-card rail",
    RAIL_CLASS[railTone],
    "relative pl-[3px] text-left w-full",
    selected ? "border-brand-500/50 shadow-pop" : "lift-on-hover hover:border-border-strong",
    className,
  );
  if (href) {
    return (
      <Link href={href} className={classes}>
        {children}
      </Link>
    );
  }
  if (as === "div") {
    return (
      <div
        className={classes}
        onClick={onClick}
        role={onClick ? "button" : undefined}
      >
        {children}
      </div>
    );
  }
  return (
    <button type="button" onClick={onClick} className={classes}>
      {children}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────
// FieldGroup — identity / metadata grid
// ─────────────────────────────────────────────────────────────────────

export type FieldRow = {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  tone?: Tone;
  hint?: string;
};

export function FieldGroup({
  rows,
  columns = 2,
  className,
}: {
  rows: FieldRow[];
  columns?: 1 | 2 | 3 | 4 | 6;
  className?: string;
}) {
  const gridClass =
    columns === 1
      ? "grid-cols-1"
      : columns === 2
        ? "grid-cols-1 md:grid-cols-2"
        : columns === 3
          ? "grid-cols-1 md:grid-cols-3"
          : columns === 4
            ? "grid-cols-2 md:grid-cols-4"
            : "grid-cols-2 md:grid-cols-3 lg:grid-cols-6";
  return (
    <dl className={cn("grid gap-2", gridClass, className)}>
      {rows.map((r, i) => {
        const missing = r.value == null || r.value === "" || r.value === "—";
        return (
          <div
            key={`${r.label}-${i}`}
            className="surface-well px-3 py-2"
          >
            <dt className="eyebrow">{r.label}</dt>
            <dd
              className={cn(
                "mt-1.5 text-[12.5px] leading-snug",
                missing && "italic text-text-subtle",
                r.mono && !missing && "font-mono text-[12px] tracking-normal text-text-strong",
                !r.mono && !missing && "text-text-strong",
                r.tone && !missing && TONE_TEXT[r.tone],
              )}
              title={r.hint}
            >
              {missing ? "missing" : r.value}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

// ─────────────────────────────────────────────────────────────────────
// DataEmptyState — signature empty moment with brand halo
// ─────────────────────────────────────────────────────────────────────

export function DataEmptyState({
  title,
  body,
  icon: Icon,
  action,
  tone = "muted",
  className,
}: {
  title: string;
  body?: React.ReactNode;
  icon?: LucideIcon;
  action?: React.ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative rounded-[12px] border border-dashed border-border bg-surface-2/30 px-6 py-10 text-center overflow-hidden",
        className,
      )}
    >
      {/* Brand-tinted halo behind the glyph — small but distinct moment. */}
      <div
        aria-hidden
        className="absolute left-1/2 top-6 -translate-x-1/2 h-24 w-24 rounded-full pointer-events-none"
        style={{
          background:
            "radial-gradient(circle, rgb(var(--brand-500) / 0.10) 0%, transparent 70%)",
        }}
      />
      {Icon ? (
        <span
          className={cn(
            "relative mx-auto mb-4 inline-flex h-12 w-12 items-center justify-center rounded-xl border bg-surface shadow-card",
            TONE_BORDER[tone],
            TONE_TEXT[tone],
          )}
        >
          <Icon className="h-5 w-5" />
        </span>
      ) : null}
      <p className="relative text-[14px] font-semibold tracking-tight text-text-strong">
        {title}
      </p>
      {body ? (
        <div className="relative mx-auto mt-2 max-w-md text-[12.5px] text-text-muted leading-relaxed">
          {body}
        </div>
      ) : null}
      {action ? (
        <div className="relative mt-4 flex justify-center">{action}</div>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// WorkflowStepper
// ─────────────────────────────────────────────────────────────────────

export type StepperStep = {
  label: string;
  state: "complete" | "active" | "pending" | "blocked";
};

export function WorkflowStepper({
  steps,
  className,
}: {
  steps: StepperStep[];
  className?: string;
}) {
  return (
    <ol className={cn("flex items-center gap-1 text-[11.5px]", className)}>
      {steps.map((s, i) => {
        const stateClass =
          s.state === "complete"
            ? "bg-good-50/70 text-good-700 border-good-500/35"
            : s.state === "active"
              ? "bg-brand-50/70 text-brand-800 border-brand-500/40 shadow-card"
              : s.state === "blocked"
                ? "bg-crit-50/70 text-crit-700 border-crit-500/35"
                : "bg-surface text-text-subtle border-border";
        const dotClass =
          s.state === "complete"
            ? "bg-good-500"
            : s.state === "active"
              ? "bg-brand-accent pulse-accent"
              : s.state === "blocked"
                ? "bg-crit-500"
                : "bg-border-strong";
        return (
          <React.Fragment key={`${s.label}-${i}`}>
            <li
              className={cn(
                "inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 font-medium tracking-tight transition-colors",
                stateClass,
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "inline-block h-1.5 w-1.5 rounded-full",
                  dotClass,
                )}
              />
              <span>{s.label}</span>
            </li>
            {i < steps.length - 1 ? (
              <ChevronRight
                className="h-3 w-3 text-text-subtle shrink-0"
                aria-hidden
              />
            ) : null}
          </React.Fragment>
        );
      })}
    </ol>
  );
}

// ─────────────────────────────────────────────────────────────────────
// MonoCode + RailHeading — small helpers
// ─────────────────────────────────────────────────────────────────────

export function MonoCode({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <code
      className={cn(
        "font-mono text-[12px] tracking-normal text-text-strong bg-surface-2/70 border border-border rounded px-1.5 py-0.5",
        className,
      )}
    >
      {children}
    </code>
  );
}

export function RailHeading({
  eyebrow,
  title,
  subtitle,
  tone = "muted",
  className,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: React.ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rail",
        RAIL_CLASS[tone],
        "relative pl-3.5",
        className,
      )}
    >
      {eyebrow ? <div className="eyebrow mb-1">{eyebrow}</div> : null}
      <h2 className="text-[14px] font-semibold tracking-tight text-text-strong">
        {title}
      </h2>
      {subtitle ? (
        <p className="mt-0.5 text-[12px] text-text-muted leading-snug">
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Back-compat aliases — existing pages outside the rebuild scope keep
// rendering without modification.
// ─────────────────────────────────────────────────────────────────────

export const ProductionSection = SectionCard;
export const ProductionAlertCard = ActionPanel;
export const ProductionIdentityBlock = FieldGroup;
export const ProductionEmptyState = DataEmptyState;
