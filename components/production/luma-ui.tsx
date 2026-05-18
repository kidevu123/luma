// LUMA-UI-REBUILD-1 — Industrial Command Surface design system.
//
// One file, intentionally. Every primitive shares the same tone
// vocabulary, the same rail motif, the same spacing scale, the same
// numeric voice. Splitting them into separate files invites drift;
// keeping them together makes the system inspectable in one read.
//
// Tone vocabulary (semantic, never decoration):
//   good  · running / ready / verified / confirmed
//   warn  · degraded / partial / needs review
//   crit  · blocked / conflict / over-allocated
//   info  · neutral signal / data window
//   muted · missing / idle / legacy / waiting
//   brand · earned only for the primary CTA + active nav state
//
// Signature: 3px status rail anchored to the left edge of cards and
// section headers. Tone drives rail color; the rail is the only place
// status color appears at full saturation, so the eye finds it
// instantly across a dense surface.

import * as React from "react";
import Link from "next/link";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────
// Tones
// ─────────────────────────────────────────────────────────────────────

export type Tone = "good" | "warn" | "crit" | "info" | "muted" | "brand";

const RAIL_CLASS: Record<Tone, string> = {
  good: "before:bg-good-500",
  warn: "before:bg-warn-500",
  crit: "before:bg-crit-500",
  info: "before:bg-info-500",
  muted: "before:bg-muted-500",
  brand: "before:bg-brand-accent",
};

const TONE_TINT: Record<Tone, string> = {
  good: "bg-good-50/60",
  warn: "bg-warn-50/60",
  crit: "bg-crit-50/60",
  info: "bg-info-50/40",
  muted: "bg-surface-2/70",
  brand: "bg-brand-50/40",
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
  good: "border-good-500/30",
  warn: "border-warn-500/30",
  crit: "border-crit-500/30",
  info: "border-info-500/25",
  muted: "border-border",
  brand: "border-brand-500/25",
};

// ─────────────────────────────────────────────────────────────────────
// CommandShell — the page chrome
// ─────────────────────────────────────────────────────────────────────

/** Wraps the page body in the canonical industrial-command surface
 *  layout: a max-width content rail with the page's eyebrow, hero, and
 *  body sections. Pages compose <CommandShell> at the top level. */
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
        "py-6 lg:py-8 space-y-6",
        className,
      )}
    >
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// PageHero — the single-line command identity at the top of each page
// ─────────────────────────────────────────────────────────────────────

export type HeroBadge = {
  label: string;
  tone?: Tone;
  /** Monospace formatting for ID-shaped values. */
  mono?: boolean;
};

/** Hero header: eyebrow + bold title + supportive subtitle + a chip
 *  row for state badges (workflow mode, gateway readiness, scope, etc.)
 *  + an actions slot. Designed to answer four questions in one glance:
 *  what page am I on, what mode am I in, what's the state, what can
 *  I do next. */
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
    <header className={cn("relative", className)}>
      <div className="flex items-start justify-between gap-6 flex-wrap">
        <div className="min-w-0 max-w-3xl">
          {eyebrow ? <div className="eyebrow mb-2">{eyebrow}</div> : null}
          <h1
            className="font-display text-[28px] leading-[1.05] tracking-tightest font-semibold text-text-strong"
          >
            {title}
          </h1>
          {description ? (
            <p className="mt-2 text-[13px] leading-relaxed text-text-muted max-w-2xl">
              {description}
            </p>
          ) : null}
          {badges && badges.length > 0 ? (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {badges.map((b, i) => (
                <StatusBadge key={i} tone={b.tone ?? "muted"} mono={b.mono === true}>
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
// StatusBadge — compact tone-tinted chip
// ─────────────────────────────────────────────────────────────────────

/** Replaces ad-hoc colored chips across the app with one canonical
 *  shape. Tone drives all color. Mono variant for ID-shaped data. */
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
// SectionCard — the canonical lifted panel with status rail
// ─────────────────────────────────────────────────────────────────────

/** Replaces the older ProductionSection. Always carries a 3px rail
 *  (default neutral, tinted by tone). Header + body + optional
 *  toolbar slot. Body padding is dense by default; pass `pad="loose"`
 *  for hero panels. */
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
}) {
  const hasHeader = !!(eyebrow || title || subtitle || actions);
  return (
    <section
      className={cn(
        "rail",
        RAIL_CLASS[tone],
        "relative pl-[3px] rounded-[10px] bg-surface border border-border shadow-card overflow-hidden",
        className,
      )}
    >
      {hasHeader ? (
        <header className="flex items-start justify-between gap-4 px-5 pt-4 pb-3 border-b border-border/70">
          <div className="min-w-0">
            {eyebrow ? <div className="eyebrow mb-1.5">{eyebrow}</div> : null}
            {title ? (
              <h2 className="text-[14px] font-semibold tracking-tight text-text-strong leading-tight">
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

/** Replaces ProductionAlertCard with cleaner geometry. Use sparingly —
 *  earn each one. Title + body + optional inline action. */
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
        "relative pl-[3px] rounded-[10px] border bg-surface",
        TONE_BORDER[tone],
        className,
      )}
      role="status"
    >
      <div className="flex items-start gap-3 px-4 py-3">
        {Icon ? (
          <span
            className={cn(
              "shrink-0 mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-md border",
              TONE_BORDER[tone],
              TONE_TINT[tone],
              TONE_TEXT[tone],
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <p className={cn("text-[13px] font-semibold tracking-tight", TONE_TEXT[tone])}>
            {title}
          </p>
          {body ? (
            <div className="mt-1 text-[12px] leading-relaxed text-text-muted">
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
// StatusCard / KPIMetric — for summary strips
// ─────────────────────────────────────────────────────────────────────

/** Compact summary card with eyebrow label + display number + optional
 *  delta / context line. Designed to tile in a 3-6 column grid. Tone
 *  drives the left rail; the number itself stays text-strong so the
 *  eye reads the count first, the meaning second. */
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
        "rail",
        RAIL_CLASS[tone],
        "relative pl-[3px] rounded-[10px] bg-surface border border-border shadow-card px-4 py-3.5",
        href && "transition-colors hover:border-border-strong hover:shadow-pop cursor-pointer",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="eyebrow">{label}</div>
          <div className="mt-1.5 display-num text-[28px]">{value}</div>
          {hint ? (
            <div className="mt-1 text-[11px] text-text-muted leading-snug">{hint}</div>
          ) : null}
        </div>
        {Icon ? (
          <span
            className={cn(
              "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border text-[12px]",
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
// RecordCard — clickable record summary (PO line, allocation row, etc.)
// ─────────────────────────────────────────────────────────────────────

/** Replaces ad-hoc clickable cards across the app. Header line +
 *  subline + optional metadata row + optional selection ring. Tone
 *  drives the rail and the optional inset selection state. */
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
    "rail",
    RAIL_CLASS[railTone],
    "relative pl-[3px] rounded-[10px] bg-surface border text-left w-full transition",
    selected
      ? "border-brand-500/50 shadow-pop"
      : "border-border hover:border-border-strong shadow-card hover:shadow-pop",
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
      <div className={classes} onClick={onClick} role={onClick ? "button" : undefined}>
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

/** Replaces ProductionIdentityBlock with sharper geometry. Renders a
 *  grid of label/value pairs in nested wells. Missing values render
 *  as italic "missing" rather than empty cells. */
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
            className="rounded-md border border-border bg-surface-2/40 px-2.5 py-2"
          >
            <dt className="eyebrow">{r.label}</dt>
            <dd
              className={cn(
                "mt-1 text-[12.5px] leading-snug",
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
// DataEmptyState — honest, contextual empty
// ─────────────────────────────────────────────────────────────────────

/** Replaces gray boxes that say "no data". Always names the next
 *  action. Never decorative. */
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
        "rail",
        RAIL_CLASS[tone],
        "relative pl-[3px] rounded-[10px] bg-surface-2/40 border border-dashed border-border/80 px-5 py-8 text-center",
        className,
      )}
    >
      {Icon ? (
        <span
          className={cn(
            "mx-auto mb-3 inline-flex h-9 w-9 items-center justify-center rounded-md border",
            TONE_BORDER[tone],
            TONE_TINT[tone],
            TONE_TEXT[tone],
          )}
        >
          <Icon className="h-4 w-4" />
        </span>
      ) : null}
      <p className="text-[13px] font-semibold tracking-tight text-text-strong">{title}</p>
      {body ? (
        <div className="mx-auto mt-1.5 max-w-md text-[12px] text-text-muted leading-relaxed">
          {body}
        </div>
      ) : null}
      {action ? <div className="mt-3 flex justify-center">{action}</div> : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// WorkflowStepper — staged-task indicator
// ─────────────────────────────────────────────────────────────────────

export type StepperStep = {
  label: string;
  state: "complete" | "active" | "pending" | "blocked";
};

/** Compact horizontal stepper. State drives color + connector style.
 *  Used on /production/start, multi-step wizards, etc. */
export function WorkflowStepper({
  steps,
  className,
}: {
  steps: StepperStep[];
  className?: string;
}) {
  return (
    <ol className={cn("flex items-center gap-1 text-[11px]", className)}>
      {steps.map((s, i) => {
        const stateClass =
          s.state === "complete"
            ? "bg-good-500/15 text-good-700 border-good-500/30"
            : s.state === "active"
              ? "bg-brand-accent/10 text-brand-800 border-brand-accent/40 ring-2 ring-brand-accent/15"
              : s.state === "blocked"
                ? "bg-crit-50 text-crit-700 border-crit-500/30"
                : "bg-surface-2 text-text-subtle border-border";
        return (
          <React.Fragment key={s.label}>
            <li
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-medium tracking-tight whitespace-nowrap",
                stateClass,
              )}
            >
              <span
                className={cn(
                  "inline-flex h-4 w-4 items-center justify-center rounded-full border text-[9px] font-mono font-semibold",
                  s.state === "complete"
                    ? "bg-good-500 text-white border-good-500"
                    : s.state === "active"
                      ? "bg-brand-accent text-white border-brand-accent"
                      : s.state === "blocked"
                        ? "bg-crit-500 text-white border-crit-500"
                        : "bg-surface text-text-subtle border-border-strong",
                )}
              >
                {s.state === "complete" ? "✓" : String(i + 1)}
              </span>
              {s.label}
            </li>
            {i < steps.length - 1 ? (
              <ChevronRight className="h-3 w-3 text-text-subtle/60 shrink-0" aria-hidden />
            ) : null}
          </React.Fragment>
        );
      })}
    </ol>
  );
}

// ─────────────────────────────────────────────────────────────────────
// MonoCode — inline mono token
// ─────────────────────────────────────────────────────────────────────

/** ID-shaped values (trace codes, receipts, UUIDs) render through
 *  this. Tabular numerals, slightly muted background, very small. */
export function MonoCode({
  children,
  className,
  tone,
}: {
  children: React.ReactNode;
  className?: string;
  tone?: Tone;
}) {
  return (
    <code
      className={cn(
        "font-mono text-[11.5px] tracking-normal rounded-[4px] px-1.5 py-[1px] border",
        tone ? TONE_TINT[tone] : "bg-surface-2",
        tone ? TONE_BORDER[tone] : "border-border",
        tone ? TONE_TEXT[tone] : "text-text-strong",
        className,
      )}
    >
      {children}
    </code>
  );
}

// ─────────────────────────────────────────────────────────────────────
// RailHeading — minor section label with rail
// ─────────────────────────────────────────────────────────────────────

/** A small step / sub-section label that carries the rail motif at
 *  smaller scale. Used inside SectionCard bodies. */
export function RailHeading({
  step,
  title,
  hint,
  tone = "muted",
  className,
}: {
  step?: string | number;
  title: string;
  hint?: React.ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rail",
        RAIL_CLASS[tone],
        "relative pl-3 flex items-baseline gap-2",
        className,
      )}
    >
      {step != null ? (
        <span className="eyebrow font-mono">{String(step).padStart(2, "0")}</span>
      ) : null}
      <span className="text-[13px] font-semibold tracking-tight text-text-strong">
        {title}
      </span>
      {hint ? <span className="text-[11px] text-text-muted">{hint}</span> : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Back-compat shims
// ─────────────────────────────────────────────────────────────────────

/** Existing pages reference these legacy names from
 *  components/production/ui. Re-export the new primitives under the
 *  legacy names so we can roll out without breaking pages until each
 *  one is migrated in this same phase. */
export {
  SectionCard as ProductionSection,
  ActionPanel as ProductionAlertCard,
  FieldGroup as ProductionIdentityBlock,
  DataEmptyState as ProductionEmptyState,
};
