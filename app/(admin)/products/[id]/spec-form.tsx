"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateProductSpecAction } from "./actions";

type SpecFormProps = {
  productId: string;
  tabletsPerUnit: number | null;
  unitsPerDisplay: number | null;
  displaysPerCase: number | null;
  defaultShelfLifeDays: number | null;
};

export function SpecForm(props: SpecFormProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  return (
    <form
      className="space-y-2.5 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        setSaved(false);
        const fd = new FormData(e.currentTarget);
        startTransition(async () => {
          const result = await updateProductSpecAction({
            productId: props.productId,
            tabletsPerUnit: parseOrNull(fd.get("tabletsPerUnit")),
            unitsPerDisplay: parseOrNull(fd.get("unitsPerDisplay")),
            displaysPerCase: parseOrNull(fd.get("displaysPerCase")),
            defaultShelfLifeDays: parseOrNull(fd.get("defaultShelfLifeDays")),
          });
          if (result && "error" in result && result.error) {
            setError(result.error);
            return;
          }
          setSaved(true);
          router.refresh();
        });
      }}
    >
      <SpecField
        name="tabletsPerUnit"
        label="Tablets per unit"
        defaultValue={props.tabletsPerUnit}
        min={1}
        max={10000}
      />
      <SpecField
        name="unitsPerDisplay"
        label="Units per display"
        defaultValue={props.unitsPerDisplay}
        min={1}
        max={10000}
      />
      <SpecField
        name="displaysPerCase"
        label="Displays per case"
        defaultValue={props.displaysPerCase}
        min={1}
        max={10000}
      />
      <SpecField
        name="defaultShelfLifeDays"
        label="Default shelf life (days)"
        defaultValue={props.defaultShelfLifeDays}
        min={1}
        max={3650}
        helper="Required for auto-issue. 365 = 1 year, 730 = 2 years."
      />
      <div className="flex items-center justify-between gap-2 pt-1">
        <div className="text-[11px] min-h-[14px]">
          {error ? <span className="text-red-700">{error}</span> : null}
          {saved && !error ? (
            <span className="text-emerald-700">Saved.</span>
          ) : null}
        </div>
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center rounded-md border border-brand-700 bg-brand-700 px-3 py-1 text-[11.5px] font-medium text-white hover:bg-brand-800 transition-colors disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save spec"}
        </button>
      </div>
    </form>
  );
}

function SpecField({
  name,
  label,
  defaultValue,
  min,
  max,
  helper,
}: {
  name: string;
  label: string;
  defaultValue: number | null;
  min: number;
  max: number;
  helper?: string;
}) {
  return (
    <label className="block">
      <div className="flex items-center justify-between gap-2 mb-0.5">
        <span className="text-text-muted text-xs uppercase tracking-wider">
          {label}
        </span>
        {helper ? (
          <span className="text-[10px] text-text-subtle">{helper}</span>
        ) : null}
      </div>
      <input
        type="number"
        name={name}
        defaultValue={defaultValue ?? ""}
        min={min}
        max={max}
        step={1}
        inputMode="numeric"
        className="block w-full bg-surface border border-border/60 rounded px-2 py-1.5 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-brand-300"
      />
    </label>
  );
}

function parseOrNull(value: FormDataEntryValue | null): number | null {
  if (value == null) return null;
  const s = typeof value === "string" ? value.trim() : "";
  if (s === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}
