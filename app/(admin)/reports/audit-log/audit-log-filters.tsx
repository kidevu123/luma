"use client";

import { useRouter, useSearchParams } from "next/navigation";
import * as React from "react";

export function AuditLogFilters({
  initial,
}: {
  initial: {
    action: string;
    targetType: string;
    actor: string;
  };
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [action, setAction] = React.useState(initial.action);
  const [targetType, setTargetType] = React.useState(initial.targetType);
  const [actor, setActor] = React.useState(initial.actor);

  function apply(e: React.FormEvent) {
    e.preventDefault();
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (action.trim()) params.set("action", action.trim());
    else params.delete("action");
    if (targetType.trim()) params.set("targetType", targetType.trim());
    else params.delete("targetType");
    if (actor.trim()) params.set("actor", actor.trim());
    else params.delete("actor");
    const q = params.toString();
    router.push(q ? `/reports/audit-log?${q}` : "/reports/audit-log");
  }

  function clearFilters() {
    setAction("");
    setTargetType("");
    setActor("");
    router.push("/reports/audit-log");
  }

  return (
    <form
      onSubmit={apply}
      className="flex flex-wrap items-end gap-3 rounded-lg border border-border/70 bg-surface p-3"
    >
      <label className="space-y-1 min-w-[140px] flex-1">
        <span className="text-[11px] font-medium text-text-subtle">Action contains</span>
        <input
          type="text"
          value={action}
          onChange={(e) => setAction(e.target.value)}
          placeholder="e.g. inventory_bag"
          className="block w-full h-9 px-2.5 rounded-md border border-border bg-page text-sm"
        />
      </label>
      <label className="space-y-1 min-w-[120px]">
        <span className="text-[11px] font-medium text-text-subtle">Target type</span>
        <input
          type="text"
          value={targetType}
          onChange={(e) => setTargetType(e.target.value)}
          placeholder="InventoryBag"
          className="block w-full h-9 px-2.5 rounded-md border border-border bg-page text-sm"
        />
      </label>
      <label className="space-y-1 min-w-[140px] flex-1">
        <span className="text-[11px] font-medium text-text-subtle">Actor email contains</span>
        <input
          type="text"
          value={actor}
          onChange={(e) => setActor(e.target.value)}
          placeholder="name@company.com"
          className="block w-full h-9 px-2.5 rounded-md border border-border bg-page text-sm"
        />
      </label>
      <div className="flex gap-2">
        <button
          type="submit"
          className="h-9 px-3 rounded-md bg-brand-700 text-white text-sm font-medium hover:bg-brand-800"
        >
          Apply
        </button>
        <button
          type="button"
          onClick={clearFilters}
          className="h-9 px-3 rounded-md border border-border bg-surface text-sm text-text-muted hover:bg-surface-2"
        >
          Clear
        </button>
      </div>
    </form>
  );
}
