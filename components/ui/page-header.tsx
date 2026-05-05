import * as React from "react";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-end justify-between gap-4 flex-wrap mb-5",
        className,
      )}
    >
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="text-sm text-text-muted mt-0.5">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatusPill({
  kind,
  children,
}: {
  kind: "ok" | "warn" | "danger" | "neutral" | "info";
  children: React.ReactNode;
}) {
  const styles: Record<typeof kind, string> = {
    ok: "bg-emerald-50 text-emerald-700 border border-emerald-200",
    warn: "bg-amber-50 text-amber-800 border border-amber-200",
    danger: "bg-red-50 text-red-700 border border-red-200",
    neutral: "bg-surface-2 text-text-muted border border-border",
    info: "bg-brand-50 text-brand-800 border border-brand-100",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium tracking-tight",
        styles[kind],
      )}
    >
      {children}
    </span>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-surface/60 p-10 text-center space-y-3">
      <div className="mx-auto w-10 h-10 rounded-full bg-brand-50 flex items-center justify-center ring-1 ring-inset ring-brand-100">
        <Icon className="w-4 h-4 text-brand-700" />
      </div>
      <div>
        <p className="text-sm font-semibold tracking-tight">{title}</p>
        {description && (
          <p className="text-xs text-text-muted mt-1">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}
