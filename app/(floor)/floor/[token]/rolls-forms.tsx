"use client";

// Phase VALIDATION-2E — observable rolls-page forms.
//
// Replaces the silent server-action wrappers with React client forms
// that surface pending / success / error state. Without this, any
// failure of mountRollAction / unmountRollAction / weighRollAction /
// changeRollAction looked identical to "page just refreshed" — no
// way for the operator to know why nothing happened.
//
// Each form here:
//   • disables the submit button while pending
//   • shows a red error banner when the action returns { error }
//   • shows a green success banner when the action returns { ok }
//   • triggers router.refresh() on success so the active rolls list
//     reflects the new state immediately

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  mountRollAction,
  unmountRollAction,
  weighRollAction,
  changeRollAction,
} from "./roll-actions";

type ActionResult = { ok?: true; error?: string } | void;

function StatusBanner({
  error,
  ok,
}: {
  error: string | null;
  ok: string | null;
}) {
  if (error) {
    return (
      <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">
        <p className="font-semibold">Action failed</p>
        <p className="text-xs">{error}</p>
      </div>
    );
  }
  if (ok) {
    return (
      <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
        <p className="font-semibold">{ok}</p>
      </div>
    );
  }
  return null;
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-sm">
      <div className="text-[11px] uppercase tracking-wider text-text-muted mb-0.5">
        {label}
      </div>
      {children}
    </label>
  );
}

function Submit({
  pending,
  label,
  pendingLabel,
  variant = "primary",
}: {
  pending: boolean;
  label: string;
  pendingLabel: string;
  variant?: "primary" | "danger" | "warn";
}) {
  const cls =
    variant === "danger"
      ? "bg-rose-700 hover:bg-rose-800"
      : variant === "warn"
        ? "bg-amber-600 hover:bg-amber-700"
        : "bg-brand-600 hover:bg-brand-700 active:bg-brand-800";
  return (
    <button
      type="submit"
      disabled={pending}
      className={`w-full rounded-lg ${cls} text-white text-sm font-medium px-4 py-3 transition-colors disabled:opacity-60`}
    >
      {pending ? pendingLabel : label}
    </button>
  );
}

type Lot = {
  id: string;
  rollNumber: string | null;
  netWeightGrams: number | null;
  currentEstimateGrams: number | null;
  materialName: string;
};

type ActiveRoll = {
  packagingLotId: string;
  rollNumber: string | null;
  role: "PVC" | "FOIL";
};

function newClientEventId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {
      // fallthrough
    }
  }
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0"));
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
}

function useFormSubmit() {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [okMsg, setOkMsg] = React.useState<string | null>(null);

  async function submit(
    fn: (fd: FormData) => Promise<ActionResult>,
    fd: FormData,
    successMsg: string,
  ) {
    setPending(true);
    setError(null);
    setOkMsg(null);
    try {
      const res = await fn(fd);
      if (res && "error" in res && res.error) {
        setError(res.error);
        return;
      }
      setOkMsg(successMsg);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error.");
    } finally {
      setPending(false);
    }
  }

  return { pending, error, okMsg, submit };
}

export function MountRollForm({
  token,
  stationId,
  idleRollLots,
}: {
  token: string;
  stationId: string;
  idleRollLots: Lot[];
}) {
  const { pending, error, okMsg, submit } = useFormSubmit();
  return (
    <form
      action={(fd) => {
        fd.set("token", token);
        fd.set("stationId", stationId);
        fd.set("clientEventId", newClientEventId());
        return submit(mountRollAction, fd, "Roll mounted.");
      }}
      className="space-y-3"
    >
      <Field label="Roll lot">
        <select
          name="packagingLotId"
          required
          defaultValue=""
          className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm"
        >
          <option value="" disabled>
            — Select roll —
          </option>
          {idleRollLots.map((lot) => (
            <option key={lot.id} value={lot.id}>
              {lot.rollNumber ?? lot.id.slice(0, 8)} · {lot.materialName} ·{" "}
              {lot.netWeightGrams != null ? `${lot.netWeightGrams} g` : "weight ?"}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Role">
        <div className="flex gap-2">
          {(["PVC", "FOIL"] as const).map((r) => (
            <label
              key={r}
              className="flex-1 flex items-center justify-center gap-1 px-3 py-2 rounded border border-border bg-surface text-sm cursor-pointer"
            >
              <input type="radio" name="role" value={r} required />
              {r}
            </label>
          ))}
        </div>
      </Field>
      <Field label="Starting weight (g, optional override)">
        <input
          type="number"
          inputMode="numeric"
          min="1"
          step="1"
          name="startingWeightGrams"
          className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm tabular-nums"
        />
      </Field>
      <Field label="Notes (optional)">
        <input
          type="text"
          name="notes"
          maxLength={500}
          className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm"
        />
      </Field>
      <StatusBanner error={error} ok={okMsg} />
      <Submit pending={pending} label="Mount roll" pendingLabel="Mounting…" />
    </form>
  );
}

export function UnmountRollForm({
  token,
  stationId,
  activeRolls,
}: {
  token: string;
  stationId: string;
  activeRolls: ActiveRoll[];
}) {
  const { pending, error, okMsg, submit } = useFormSubmit();
  return (
    <form
      action={(fd) => {
        fd.set("token", token);
        fd.set("stationId", stationId);
        fd.set("clientEventId", newClientEventId());
        return submit(unmountRollAction, fd, "Roll unmounted.");
      }}
      className="space-y-3"
    >
      <Field label="Active roll">
        <select
          name="packagingLotId"
          required
          defaultValue=""
          className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm"
        >
          <option value="" disabled>
            — Select active roll —
          </option>
          {activeRolls.map((r) => (
            <option key={r.packagingLotId} value={r.packagingLotId}>
              {r.role} · {r.rollNumber ?? r.packagingLotId.slice(0, 8)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Final weight (g, optional)">
        <input
          type="number"
          inputMode="numeric"
          min="0"
          step="1"
          name="endingWeightGrams"
          className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm tabular-nums"
        />
        <p className="text-[11px] text-text-muted mt-1">
          Leave blank if not weighed back. Lot stays AVAILABLE; confidence
          will be MEDIUM until a weigh-back lands.
        </p>
      </Field>
      <Field label="Notes (optional)">
        <input
          type="text"
          name="notes"
          maxLength={500}
          className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm"
        />
      </Field>
      <StatusBanner error={error} ok={okMsg} />
      <Submit
        pending={pending}
        label="Unmount roll"
        pendingLabel="Unmounting…"
        variant="warn"
      />
    </form>
  );
}

export function WeighRollForm({
  token,
  stationId,
  activeRolls,
}: {
  token: string;
  stationId: string;
  activeRolls: ActiveRoll[];
}) {
  const { pending, error, okMsg, submit } = useFormSubmit();
  return (
    <form
      action={(fd) => {
        fd.set("token", token);
        fd.set("stationId", stationId);
        fd.set("clientEventId", newClientEventId());
        return submit(weighRollAction, fd, "Weight recorded.");
      }}
      className="space-y-3"
    >
      <Field label="Active roll">
        <select
          name="packagingLotId"
          required
          defaultValue=""
          className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm"
        >
          <option value="" disabled>
            — Select active roll —
          </option>
          {activeRolls.map((r) => (
            <option key={r.packagingLotId} value={r.packagingLotId}>
              {r.role} · {r.rollNumber ?? r.packagingLotId.slice(0, 8)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Current weight (g)">
        <input
          type="number"
          inputMode="numeric"
          min="1"
          step="1"
          required
          name="currentWeightGrams"
          className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm tabular-nums"
        />
      </Field>
      <Field label="Notes (optional)">
        <input
          type="text"
          name="notes"
          maxLength={500}
          className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm"
        />
      </Field>
      <StatusBanner error={error} ok={okMsg} />
      <Submit
        pending={pending}
        label="Record weight"
        pendingLabel="Saving…"
      />
    </form>
  );
}

export function ChangeRollForm({
  token,
  stationId,
  activeBag,
  idleRollLots,
}: {
  token: string;
  stationId: string;
  activeBag: { id: string; label: string; startedAt: Date | string | null };
  idleRollLots: Lot[];
}) {
  const { pending, error, okMsg, submit } = useFormSubmit();
  return (
    <form
      action={(fd) => {
        fd.set("token", token);
        fd.set("stationId", stationId);
        fd.set("workflowBagId", activeBag.id);
        fd.set("clientEventId", newClientEventId());
        return submit(changeRollAction, fd, "Roll changed.");
      }}
      className="space-y-3"
    >
      <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs space-y-0.5">
        <div className="font-semibold text-amber-900">
          Segment will be allocated to: {activeBag.label}
        </div>
        <div className="text-amber-900/80 font-mono text-[10px]">
          bag {activeBag.id.slice(0, 8)} · started{" "}
          {activeBag.startedAt
            ? new Date(activeBag.startedAt).toLocaleString()
            : "—"}
        </div>
        <div className="text-amber-900/80">
          Counter goes to the old roll, the still-active other-role roll, and
          this bag.
        </div>
      </div>
      <p className="text-xs text-text-muted">
        Use this when a roll runs out (or is changed out) mid-bag. Enter the
        machine counter when this roll stopped — that count goes to the old
        roll AND to the other active roll for the segment.
      </p>
      <Field label="Role being changed">
        <div className="flex gap-2">
          {(["PVC", "FOIL"] as const).map((r) => (
            <label
              key={r}
              className="flex-1 flex items-center justify-center gap-1 px-3 py-2 rounded border border-border bg-surface text-sm cursor-pointer"
            >
              <input type="radio" name="role" value={r} required />
              {r}
            </label>
          ))}
        </div>
      </Field>
      <Field label="Counter when this roll stopped (segment count)">
        <input
          type="number"
          inputMode="numeric"
          min="1"
          step="1"
          required
          name="counterSegmentCount"
          className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm tabular-nums"
        />
      </Field>
      <Field label="New roll lot (replacement)">
        <select
          name="newPackagingLotId"
          required
          defaultValue=""
          className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm"
        >
          <option value="" disabled>
            — Select new roll —
          </option>
          {idleRollLots.map((lot) => (
            <option key={lot.id} value={lot.id}>
              {lot.rollNumber ?? lot.id.slice(0, 8)} · {lot.materialName} ·{" "}
              {lot.netWeightGrams != null ? `${lot.netWeightGrams} g` : "weight ?"}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Notes (optional)">
        <input
          type="text"
          name="notes"
          maxLength={500}
          className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm"
        />
      </Field>
      <StatusBanner error={error} ok={okMsg} />
      <Submit pending={pending} label="Change roll" pendingLabel="Changing…" />
    </form>
  );
}
