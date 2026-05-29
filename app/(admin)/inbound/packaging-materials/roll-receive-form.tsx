"use client";

// ROLL-INTAKE-UX-LEGACY-1 — simplified multi-roll receive for PVC / foil.
// ROLL-INTAKE-NUMBER-INPUT-FIX-1 — text numeric fields (no wheel mutation).

import { useEffect, useState, useTransition } from "react";
import { receiveRollsBatchAction } from "./actions";
import { materialKindShortLabel } from "@/lib/inbound/roll-receive-batch";
import {
  parseRollCountInput,
  parseDecimalKgInput,
  resizeRollRows,
  sanitizeRollCountTyping,
} from "@/lib/inbound/roll-receive-input";
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
  "mt-1 w-full h-9 px-2.5 rounded-lg border border-border bg-surface-2/60 text-[12.5px] text-text-strong placeholder:text-text-subtle focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 focus:outline-none transition-colors tabular-nums";

function emptyRow(): RollRow {
  return { rollNumber: "", netWeightKg: "" };
}

function NumericTextInput({
  inputMode,
  name,
  value,
  onChange,
  onBlur,
  placeholder,
  required,
  className,
}: {
  inputMode: "numeric" | "decimal";
  name?: string;
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onBlur?: (e: React.FocusEvent<HTMLInputElement>) => void;
  placeholder?: string;
  required?: boolean;
  className?: string;
}) {
  return (
    <input
      type="text"
      inputMode={inputMode}
      autoComplete="off"
      {...(name ? { name } : {})}
      {...(value !== undefined ? { value } : {})}
      {...(onChange ? { onChange } : {})}
      {...(onBlur ? { onBlur } : {})}
      {...(placeholder ? { placeholder } : {})}
      {...(required ? { required } : {})}
      className={className ?? inputClass}
    />
  );
}

export function RollReceiveForm({
  materials,
  mountTargets,
}: {
  materials: Material[];
  mountTargets: MountTarget[];
}) {
  const [receiptType, setReceiptType] = useState<"NORMAL" | "LEGACY_OPENING_BALANCE">("NORMAL");
  const [rollCountText, setRollCountText] = useState("1");
  const [committedRollCount, setCommittedRollCount] = useState(1);
  const [rollCountError, setRollCountError] = useState<string | null>(null);
  const [rows, setRows] = useState<RollRow[]>(() => [emptyRow()]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [alreadyMounted, setAlreadyMounted] = useState(false);
  const [mountStationId, setMountStationId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    setRows((prev) => resizeRollRows(prev, committedRollCount, emptyRow));
    if (committedRollCount !== 1) setAlreadyMounted(false);
  }, [committedRollCount]);

  function commitRollCountFromText(text: string): boolean {
    const parsed = parseRollCountInput(text);
    if (!parsed.ok) {
      setRollCountError(parsed.error);
      return false;
    }
    setRollCountError(null);
    setRollCountText(String(parsed.value));
    setCommittedRollCount(parsed.value);
    return true;
  }

  function handleRollCountBlur() {
    commitRollCountFromText(rollCountText);
  }

  function updateRow(index: number, patch: Partial<RollRow>) {
    setRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!commitRollCountFromText(rollCountText)) {
      return;
    }

    const parsed = parseRollCountInput(rollCountText);
    if (!parsed.ok) return;

    const syncedRows = resizeRollRows(rows, parsed.value, emptyRow);
    setRows(syncedRows);

    const parsedRows: Array<{ rollNumber: string; netWeightKg: number }> = [];
    for (let i = 0; i < syncedRows.length; i++) {
      const row = syncedRows[i]!;
      if (!row.rollNumber.trim()) {
        setError(`Roll ${i + 1} needs a roll number.`);
        return;
      }
      const weight = parseDecimalKgInput(row.netWeightKg);
      if (!weight.ok) {
        setError(`Roll ${i + 1}: ${weight.error}`);
        return;
      }
      parsedRows.push({
        rollNumber: row.rollNumber.trim(),
        netWeightKg: weight.value,
      });
    }

    const fd = new FormData(e.currentTarget);
    fd.set("rollsJson", JSON.stringify(parsedRows));
    fd.set("alreadyMounted", alreadyMounted ? "true" : "false");
    if (!alreadyMounted) fd.delete("mountStationId");

    startTransition(async () => {
      const res = await receiveRollsBatchAction(fd);
      if (res?.error) {
        setError(res.error);
        return;
      }
      const count = parsedRows.length;
      let msg = `Received ${count} roll${count === 1 ? "" : "s"}.`;
      if (res?.mountMessage) msg += ` ${res.mountMessage}`;
      else if (alreadyMounted && count === 1) {
        msg +=
          " Receive complete. Mount this roll from the floor station Rolls panel if it is not already mounted.";
      }
      setSuccess(msg);
      setRollCountText("1");
      setCommittedRollCount(1);
      setRows([emptyRow()]);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
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
            onChange={(ev) =>
              setReceiptType(
                ev.target.value as "NORMAL" | "LEGACY_OPENING_BALANCE",
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
            required
            placeholder="e.g. PO-2024-001 or LEGACY-FOIL-01"
            className={inputClass}
          />
        </label>

        <label className="block">
          <span className="text-[11px] text-text-muted font-medium">
            Number of rolls
          </span>
          <NumericTextInput
            inputMode="numeric"
            value={rollCountText}
            onChange={(ev) => {
              setRollCountText(sanitizeRollCountTyping(ev.target.value));
              setRollCountError(null);
            }}
            onBlur={handleRollCountBlur}
            placeholder="1"
            className={cn(
              inputClass,
              rollCountError ? "border-red-400 focus:border-red-500 focus:ring-red-500/20" : "",
            )}
          />
          {rollCountError ? (
            <p className="mt-1 text-[11px] text-red-700">{rollCountError}</p>
          ) : null}
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
                  value={row.rollNumber}
                  onChange={(ev) => updateRow(i, { rollNumber: ev.target.value })}
                  placeholder="e.g. FOIL-01"
                  className={inputClass}
                />
              </label>
              <label className="block">
                <span className="text-[10px] text-text-subtle font-medium">
                  Net weight (kg)
                </span>
                <NumericTextInput
                  inputMode="decimal"
                  value={row.netWeightKg}
                  onChange={(ev) => updateRow(i, { netWeightKg: ev.target.value })}
                  placeholder="e.g. 5.2"
                />
              </label>
            </div>
          ))}
        </div>
      </div>

      {committedRollCount === 1 && mountTargets.length > 0 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50/50 px-4 py-3 space-y-2">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={alreadyMounted}
              onChange={(ev) => setAlreadyMounted(ev.target.checked)}
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
                onChange={(ev) => setMountStationId(ev.target.value)}
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
      ) : committedRollCount === 1 && mountTargets.length === 0 ? (
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
              <NumericTextInput inputMode="numeric" name="widthMm" />
            </label>
            <label className="block">
              <span className="text-[11px] text-text-muted font-medium">
                Thickness (μm)
              </span>
              <NumericTextInput inputMode="numeric" name="thicknessMicrons" />
            </label>
            <label className="block">
              <span className="text-[11px] text-text-muted font-medium">
                Gross weight (kg) — all rolls
              </span>
              <NumericTextInput inputMode="decimal" name="grossWeightKg" />
            </label>
            <label className="block">
              <span className="text-[11px] text-text-muted font-medium">
                Tare weight (kg) — all rolls
              </span>
              <NumericTextInput inputMode="decimal" name="tareWeightKg" />
            </label>
            <label className="block">
              <span className="text-[11px] text-text-muted font-medium">
                Core weight at receipt (kg)
              </span>
              <NumericTextInput inputMode="decimal" name="coreWeightKg" />
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
            : `Receive ${committedRollCount} roll${committedRollCount === 1 ? "" : "s"}`}
        </button>
      </div>
    </form>
  );
}
