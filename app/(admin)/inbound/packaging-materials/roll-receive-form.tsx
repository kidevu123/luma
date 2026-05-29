"use client";

// ROLL-INTAKE-UX-LEGACY-1 — simplified multi-roll receive for PVC / foil.

import { useEffect, useMemo, useState, useTransition } from "react";
import { receiveRollsBatchAction } from "./actions";
import { materialKindShortLabel } from "@/lib/inbound/roll-receive-batch";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

type Material = {
  id: string;
  sku: string;
  name: string;
  kind: string;
};

type MountTarget = {
  stationId: string;
  machineId: string;
  label: string;
};

type RollRow = {
  rollNumber: string;
  netWeightKg: string;
};

const inputClass =
  "mt-1 w-full h-9 px-2.5 rounded-lg border border-border bg-surface-2/60 text-[12.5px] text-text-strong placeholder:text-text-subtle focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 focus:outline-none transition-colors";

function emptyRow(): RollRow {
  return { rollNumber: "", netWeightKg: "" };
}

export function RollReceiveForm({
  materials,
  mountTargets,
}: {
  materials: Material[];
  mountTargets: MountTarget[];
}) {
  const [receiptType, setReceiptType] = useState<
    "NORMAL" | "LEGACY_OPENING_BALANCE"
  >("LEGACY_OPENING_BALANCE");
  const [rollCount, setRollCount] = useState(8);
  const [rows, setRows] = useState<RollRow[]>(() =>
    Array.from({ length: 8 }, emptyRow),
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [alreadyMounted, setAlreadyMounted] = useState(false);
  const [mountStationId, setMountStationId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    setRows((prev) => {
      const n = Math.min(Math.max(1, rollCount), 50);
      if (prev.length === n) return prev;
      if (prev.length < n) {
        return [...prev, ...Array.from({ length: n - prev.length }, emptyRow)];
      }
      return prev.slice(0, n);
    });
    if (rollCount !== 1) setAlreadyMounted(false);
  }, [rollCount]);

  const rollsJson = useMemo(
    () =>
      JSON.stringify(
        rows.map((r) => ({
          rollNumber: r.rollNumber,
          netWeightKg: r.netWeightKg === "" ? Number.NaN : Number(r.netWeightKg),
        })),
      ),
    [rows],
  );

  function updateRow(index: number, patch: Partial<RollRow>) {
    setRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    const fd = new FormData(e.currentTarget);
    fd.set("rollsJson", rollsJson);
    fd.set("alreadyMounted", alreadyMounted ? "true" : "false");
    if (!alreadyMounted) fd.delete("mountStationId");

    startTransition(async () => {
      const res = await receiveRollsBatchAction(fd);
      if (res?.error) {
        setError(res.error);
        return;
      }
      const count = rows.length;
      let msg = `Received ${count} roll${count === 1 ? "" : "s"}.`;
      if (res?.mountMessage) msg += ` ${res.mountMessage}`;
      else if (alreadyMounted && count === 1) {
        msg +=
          " Receive complete. Mount this roll from the floor station Rolls panel if it is not already mounted.";
      }
      setSuccess(msg);
      setRows(Array.from({ length: rollCount }, emptyRow));
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="text-[11px] text-text-muted font-medium">
            Roll material
          </span>
          <select
            name="packagingMaterialId"
            required
            defaultValue=""
            className={inputClass}
          >
            <option value="" disabled>
              — select PVC or foil —
            </option>
            {materials.map((m) => (
              <option key={m.id} value={m.id}>
                {materialKindShortLabel(m.kind)} — {m.name} ({m.sku})
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-[11px] text-text-muted font-medium">
            Receipt type
          </span>
          <select
            name="receiptType"
            required
            value={receiptType}
            onChange={(e) =>
              setReceiptType(
                e.target.value as "NORMAL" | "LEGACY_OPENING_BALANCE",
              )
            }
            className={inputClass}
          >
            <option value="NORMAL">Normal receipt</option>
            <option value="LEGACY_OPENING_BALANCE">
              Legacy opening balance
            </option>
          </select>
        </label>

        <label className="block">
          <span className="text-[11px] text-text-muted font-medium">
            PO / receipt reference
          </span>
          <input
            name="receiptNumber"
            type="text"
            placeholder="Optional"
            className={inputClass}
          />
        </label>

        <label className="block">
          <span className="text-[11px] text-text-muted font-medium">
            Number of rolls
          </span>
          <input
            type="number"
            min={1}
            max={50}
            required
            value={rollCount}
            onChange={(e) => setRollCount(Number(e.target.value) || 1)}
            className={inputClass}
          />
        </label>

        <label className="block sm:col-span-2">
          <span className="text-[11px] text-text-muted font-medium">
            Notes (optional)
          </span>
          <input name="notes" type="text" maxLength={500} className={inputClass} />
        </label>
      </div>

      <div className="rounded-xl border border-border overflow-hidden">
        <div className="px-3 py-2 bg-surface-2/50 border-b border-border/60">
          <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wider">
            Roll weights
          </p>
          <p className="text-[11px] text-text-subtle mt-0.5">
            Enter each roll number and net weight in{" "}
            <span className="font-semibold">kilograms</span>. Core / spent weight
            is captured later when the roll is unmounted on the floor.
          </p>
        </div>
        <div className="divide-y divide-border/40">
          {rows.map((row, i) => (
            <div
              key={i}
              className="grid grid-cols-1 sm:grid-cols-[1fr_140px] gap-2 px-3 py-2.5 items-end"
            >
              <label className="block">
                <span className="text-[10px] text-text-subtle font-medium">
                  Roll {i + 1} — number
                </span>
                <input
                  type="text"
                  required
                  value={row.rollNumber}
                  onChange={(e) => updateRow(i, { rollNumber: e.target.value })}
                  placeholder="e.g. FOIL-01"
                  className={inputClass}
                />
              </label>
              <label className="block">
                <span className="text-[10px] text-text-subtle font-medium">
                  Net weight (kg)
                </span>
                <input
                  type="number"
                  required
                  min={0.001}
                  step="0.001"
                  value={row.netWeightKg}
                  onChange={(e) => updateRow(i, { netWeightKg: e.target.value })}
                  placeholder="e.g. 5.2"
                  className={inputClass}
                />
              </label>
            </div>
          ))}
        </div>
      </div>

      {rollCount === 1 && mountTargets.length > 0 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50/50 px-4 py-3 space-y-2">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={alreadyMounted}
              onChange={(e) => setAlreadyMounted(e.target.checked)}
              className="mt-0.5"
            />
            <span className="text-[12px] text-amber-950">
              <span className="font-semibold">Already mounted on machine</span>
              <span className="block text-[11px] text-amber-900/80 mt-0.5">
                For a single legacy roll that is already on the blister machine.
                Luma will receive it and record a mount event on the selected
                station.
              </span>
            </span>
          </label>
          {alreadyMounted ? (
            <label className="block">
              <span className="text-[11px] text-text-muted font-medium">
                Mount at station
              </span>
              <select
                name="mountStationId"
                required
                value={mountStationId}
                onChange={(e) => setMountStationId(e.target.value)}
                className={inputClass}
              >
                <option value="" disabled>
                  — select machine / station —
                </option>
                {mountTargets.map((t) => (
                  <option key={t.stationId} value={t.stationId}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : rollCount === 1 && mountTargets.length === 0 ? (
        <p className="text-[11px] text-text-muted rounded-lg border border-border px-3 py-2">
          After receiving a single roll, mount it from the floor station{" "}
          <span className="font-semibold">Rolls</span> panel (Supervisor tools).
        </p>
      ) : null}

      <div>
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="inline-flex items-center gap-1 text-[11px] text-text-muted hover:text-text-strong transition-colors"
        >
          {showAdvanced ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
          Advanced details (optional)
        </button>
        {showAdvanced ? (
          <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-xl border border-border/60 bg-surface-2/30 p-3">
            <label className="block">
              <span className="text-[11px] text-text-muted font-medium">
                Supplier
              </span>
              <input name="supplier" type="text" className={inputClass} />
            </label>
            <label className="block">
              <span className="text-[11px] text-text-muted font-medium">
                Supplier lot number
              </span>
              <input name="lotNumber" type="text" className={inputClass} />
            </label>
            <label className="block">
              <span className="text-[11px] text-text-muted font-medium">
                Storage location
              </span>
              <input name="location" type="text" className={inputClass} />
            </label>
            <label className="block">
              <span className="text-[11px] text-text-muted font-medium">
                Material spec
              </span>
              <input name="materialSpec" type="text" className={inputClass} />
            </label>
            <label className="block">
              <span className="text-[11px] text-text-muted font-medium">
                Width (mm)
              </span>
              <input
                name="widthMm"
                type="number"
                min={0}
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className="text-[11px] text-text-muted font-medium">
                Thickness (μm)
              </span>
              <input
                name="thicknessMicrons"
                type="number"
                min={0}
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className="text-[11px] text-text-muted font-medium">
                Gross weight (kg) — all rolls
              </span>
              <input
                name="grossWeightKg"
                type="number"
                min={0}
                step="0.001"
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className="text-[11px] text-text-muted font-medium">
                Tare weight (kg) — all rolls
              </span>
              <input
                name="tareWeightKg"
                type="number"
                min={0}
                step="0.001"
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className="text-[11px] text-text-muted font-medium">
                Core weight at receipt (kg)
              </span>
              <input
                name="coreWeightKg"
                type="number"
                min={0}
                step="0.001"
                className={inputClass}
              />
            </label>
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-[12px] text-red-900">
          {error}
        </div>
      ) : null}
      {success ? (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-900">
          {success}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3 pt-1">
        <p className="text-[11px] text-text-muted">
          Weights are entered in kg; Luma stores grams internally. Duplicate roll
          numbers are rejected.
        </p>
        <button
          type="submit"
          disabled={pending}
          className={cn(
            "h-9 px-5 rounded-lg bg-brand-600 hover:bg-brand-700 active:bg-brand-800 text-white text-[12.5px] font-semibold tracking-tight shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60 shrink-0 disabled:opacity-60",
          )}
        >
          {pending
            ? "Saving…"
            : `Receive ${rows.length} roll${rows.length === 1 ? "" : "s"}`}
        </button>
      </div>
    </form>
  );
}
