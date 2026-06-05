"use client";

import { formatDateTimeEst } from "@/lib/ui/luma-display";

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
import { formatGramsAsKg } from "@/lib/inbound/roll-weight";
import {
  filterIdleRollLotsForRole,
  idleRollLotMatchesRole,
} from "@/lib/production/idle-roll-lots";
import { sortRollLotsForPicker } from "@/lib/production/roll-lot-sort";

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
  materialKind: string;
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

  function safeError(raw: string): string {
    // Don't expose raw PG error syntax to operators. Translate the
    // most common contract-violation pattern; pass other messages
    // through unchanged.
    if (/invalid input syntax for type uuid/i.test(raw)) {
      return "Roll change failed because the event id was invalid. Please call supervisor — server logs have the details.";
    }
    return raw;
  }

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
        setError(safeError(res.error));
        return;
      }
      setOkMsg(successMsg);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? safeError(err.message) : "Unexpected error.");
    } finally {
      setPending(false);
    }
  }

  return { pending, error, okMsg, submit };
}

function formatLotOptionLabel(lot: Lot): string {
  const weight =
    lot.netWeightGrams != null ? formatGramsAsKg(lot.netWeightGrams) : "weight ?";
  return `${lot.rollNumber ?? lot.id.slice(0, 8)} · ${lot.materialName} · ${weight}`;
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
  const [role, setRole] = React.useState<"PVC" | "FOIL" | "">("");
  const [lotId, setLotId] = React.useState("");

  const lotsForRole =
    role === "PVC" || role === "FOIL"
      ? sortRollLotsForPicker(filterIdleRollLotsForRole(idleRollLots, role))
      : [];

  React.useEffect(() => {
    if (!lotId) return;
    const selected = idleRollLots.find((l) => l.id === lotId);
    if (
      !selected ||
      (role !== "PVC" && role !== "FOIL") ||
      !idleRollLotMatchesRole(selected, role)
    ) {
      setLotId("");
    }
  }, [role, lotId, idleRollLots]);

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
      <Field label="Roll type / material role">
        <div className="flex gap-2">
          {(["PVC", "FOIL"] as const).map((r) => (
            <label
              key={r}
              className="flex-1 flex items-center justify-center gap-1 px-3 py-2 rounded border border-border bg-surface text-sm cursor-pointer"
            >
              <input
                type="radio"
                name="role"
                value={r}
                required
                checked={role === r}
                onChange={() => setRole(r)}
              />
              {r}
            </label>
          ))}
        </div>
      </Field>
      <Field label="Roll lot">
        {role !== "PVC" && role !== "FOIL" ? (
          <p className="text-sm text-text-muted py-2">
            Select PVC or FOIL above to see available rolls.
          </p>
        ) : lotsForRole.length === 0 ? (
          <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            No available {role} rolls. Receive rolls in inbound first.
          </p>
        ) : (
          <select
            name="packagingLotId"
            required
            value={lotId}
            onChange={(e) => setLotId(e.target.value)}
            className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm"
          >
            <option value="" disabled>
              — Select roll —
            </option>
            {lotsForRole.map((lot) => (
              <option key={lot.id} value={lot.id}>
                {formatLotOptionLabel(lot)}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Starting weight (kg, optional override)">
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="0.001"
          name="startingWeightKg"
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
      <Field label="Spent roll / core weight (kg, optional)">
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="0.001"
          name="endingWeightKg"
          className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm tabular-nums"
        />
        <p className="text-[11px] text-text-muted mt-1">
          Weigh the spent roll (cardboard / core only) after material is used.
          Leave blank if not weighed — lot stays AVAILABLE with MEDIUM
          confidence until a weigh-back lands.
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
      <Field label="Current weight (kg)">
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="0.001"
          required
          name="currentWeightKg"
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
  fixedRole,
  replacementInputMode = "select",
  showEndingWeight = false,
  onCancel,
}: {
  token: string;
  stationId: string;
  activeBag: { id: string; label: string; startedAt: Date | string | null };
  idleRollLots: Lot[];
  /** When set, role is locked (station main-page roll change buttons). */
  fixedRole?: "PVC" | "FOIL";
  replacementInputMode?: "select" | "text";
  showEndingWeight?: boolean;
  onCancel?: () => void;
}) {
  const { pending, error, okMsg, submit } = useFormSubmit();
  const replacementLots = sortRollLotsForPicker(
    fixedRole != null
      ? filterIdleRollLotsForRole(idleRollLots, fixedRole)
      : idleRollLots,
  );
  return (
    <form
      action={(fd) => {
        fd.set("token", token);
        fd.set("stationId", stationId);
        fd.set("workflowBagId", activeBag.id);
        if (fixedRole) fd.set("role", fixedRole);
        const newRollToken = String(fd.get("newRollToken") ?? "").trim();
        if (newRollToken) {
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(newRollToken)) {
            fd.set("newPackagingLotId", newRollToken);
          } else {
            fd.set("newRollNumber", newRollToken);
          }
        }
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
            ? formatDateTimeEst(activeBag.startedAt)
            : "—"}
        </div>
        <div className="text-amber-900/80">
          This count is assigned to the roll being removed, the still-active other
          roll, and this bag. The replacement roll starts after this change.
        </div>
      </div>
      <p className="text-xs text-text-muted">
        Use this when a roll runs out or is changed out mid-bag. Enter the
        machine counter when the roll being removed stopped. That count closes
        the segment for the removed roll, the other active roll, and this bag.
        The replacement roll does not receive this count.
      </p>
      <Field label="Role being changed">
        {fixedRole ? (
          <input type="hidden" name="role" value={fixedRole} />
        ) : null}
        {fixedRole ? (
          <p className="text-sm font-medium py-2">{fixedRole} roll</p>
        ) : (
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
        )}
      </Field>
      <Field label="Machine counter reading">
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
      <Field label="Old roll status">
        <div className="grid gap-2">
          <label className="flex items-start gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm cursor-pointer">
            <input
              type="radio"
              name="oldRollEndState"
              value="depleted"
              required
              className="mt-1"
            />
            <span>
              <span className="block font-medium">Finished / depleted</span>
              <span className="block text-xs text-text-muted">
                Mark the old roll depleted after assigning this count.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm cursor-pointer">
            <input
              type="radio"
              name="oldRollEndState"
              value="removed_partial"
              required
              className="mt-1"
            />
            <span>
              <span className="block font-medium">
                Removed with material remaining
              </span>
              <span className="block text-xs text-text-muted">
                The old roll will be removed and can be mounted again later. It
                will not be marked depleted.
              </span>
            </span>
          </label>
        </div>
      </Field>
      {replacementInputMode === "text" ? (
        <Field label="New roll scan token or lot token">
          <input
            type="text"
            name="newRollToken"
            required
            autoCapitalize="characters"
            className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm"
          />
        </Field>
      ) : (
        <Field label="New roll lot (replacement)">
          {fixedRole != null && replacementLots.length === 0 ? (
            <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              No available {fixedRole} rolls.
            </p>
          ) : (
            <select
              name="newPackagingLotId"
              required
              defaultValue=""
              className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm"
            >
              <option value="" disabled>
                — Select new roll —
              </option>
              {replacementLots.map((lot) => (
                <option key={lot.id} value={lot.id}>
                  {formatLotOptionLabel(lot)}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
      {showEndingWeight ? (
        <Field label="Spent roll / core weight (kg, optional)">
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.001"
            name="endingWeightKg"
            className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm tabular-nums"
          />
        </Field>
      ) : null}
      <Field label="Notes (optional)">
        <input
          type="text"
          name="notes"
          maxLength={500}
          className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm"
        />
      </Field>
      <StatusBanner error={error} ok={okMsg} />
      <div className={onCancel ? "flex gap-2" : undefined}>
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="flex-1 rounded-lg border border-border bg-surface text-sm font-medium px-4 py-3 transition-colors disabled:opacity-60"
          >
            Cancel
          </button>
        ) : null}
        <div className={onCancel ? "flex-1" : undefined}>
          <Submit
            pending={pending}
            label="Change roll"
            pendingLabel="Changing…"
          />
        </div>
      </div>
    </form>
  );
}
