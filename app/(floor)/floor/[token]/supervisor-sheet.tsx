"use client";

// P5-SUPERVISOR Task 3 — the floor unlock sheet and session banner.
//
// SupervisorSheet: More ▸ Supervisor opens it when the station is LOCKED
// (view.supervisor == null). Employee code + PIN inputs, submitted via
// supervisorUnlockAction. On success the page re-renders with a non-null
// view.supervisor and the banner appears instead.
//
// SupervisorBanner: persisted on top of the operator screen while the
// session is OPEN (view.supervisor != null). Shows supervisor name + live
// countdown (supervisorSessionRemainingSeconds, ticked every second) +
// [ Exit ] that calls supervisorLockAction. At zero (or any negative diff
// the function already clamps to zero) the banner renders "Locked" and
// waits for the next page refresh — the NEXT getStationView call will see
// closed_at set by the lazy-close path inside requireSupervisorSession.
//
// PIN DISCIPLINE. The PIN state is cleared on BOTH success and failure
// so the field never echoes the secret back to a waiting observer:
// success re-renders the page; failure leaves the employee-code field
// intact (operator can retry the same code) but empties the PIN.
//
// Sheet style follows operator-screen.tsx: Sheet wrapper, ErrorAlert,
// PRIMARY_BUTTON / SECONDARY_BUTTON constants, numeric inputMode hints
// for the PIN field so the tablet raises a digit keyboard.

import * as React from "react";
import { KeyRound, LogOut, Shield } from "lucide-react";
import {
  supervisorSessionRemainingSeconds,
  type SupervisorSessionSnapshot,
} from "@/lib/production/engine/client";
import {
  supervisorLockAction,
  supervisorUnlockAction,
} from "./operator-actions";

// ── shared constants (mirrored from operator-screen.tsx conventions) ──

const PRIMARY_BUTTON =
  "w-full min-h-[72px] inline-flex items-center justify-center gap-2 rounded-2xl bg-brand-700 px-6 text-xl font-semibold text-white shadow-sm transition-colors hover:bg-brand-800 disabled:opacity-60";

function ErrorAlert({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-base text-rose-900"
    >
      <span>{message}</span>
    </p>
  );
}

// ── mm:ss countdown formatter ─────────────────────────────────────────

/** Format whole seconds as mm:ss. Used by the banner ticker. */
export function formatCountdown(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// ── SupervisorSheet ───────────────────────────────────────────────────

export function SupervisorSheet({
  token,
  stationId,
  onClose,
}: {
  token: string;
  stationId: string;
  onClose: () => void;
}) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [employeeCode, setEmployeeCode] = React.useState("");
  const [pin, setPin] = React.useState("");

  const handleSubmit = async () => {
    if (employeeCode.trim() === "" || pin === "") {
      setError("Enter your employee code and PIN.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("token", token);
      fd.set("stationId", stationId);
      fd.set("employeeCode", employeeCode.trim());
      fd.set("pin", pin);
      const result = await supervisorUnlockAction(fd);
      // Clear PIN on both success and failure — never echo it back.
      setPin("");
      if (result && "error" in result && result.error) {
        setError(result.error);
        return;
      }
      // Success: page refresh (triggered by revalidatePath in the action)
      // will re-render with view.supervisor non-null, replacing the sheet
      // with the banner. Close here so the sheet does not flash open while
      // the router commits the navigation.
      onClose();
    } catch (err) {
      setPin("");
      setError(err instanceof Error ? err.message : "Could not unlock supervisor mode.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-end bg-black/50">
      <div className="max-h-[85vh] w-full space-y-3 overflow-y-auto rounded-t-3xl bg-surface-2 p-4">
        <div className="flex items-center justify-between">
          <p className="flex items-center gap-2 text-lg font-semibold">
            <Shield className="h-5 w-5 text-text-muted" />
            Supervisor unlock
          </p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-2 text-text-muted hover:bg-surface hover:text-text"
          >
            <LogOut className="h-5 w-5" />
          </button>
        </div>

        <ErrorAlert message={error} />

        <p className="text-sm text-text-muted">
          Enter a supervisor employee code and PIN to unlock this station for
          15 minutes.
        </p>

        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-text-muted">
            Employee code
          </span>
          <input
            type="text"
            value={employeeCode}
            disabled={pending}
            onChange={(e) => setEmployeeCode(e.target.value)}
            className="h-14 w-full rounded-xl border border-border bg-surface px-4 text-xl text-text"
            placeholder="Employee code"
            autoComplete="off"
            autoCapitalize="none"
          />
        </label>

        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-text-muted">PIN</span>
          <input
            type="password"
            inputMode="numeric"
            value={pin}
            disabled={pending}
            onChange={(e) => setPin(e.target.value)}
            className="h-14 w-full rounded-xl border border-border bg-surface px-4 text-2xl tabular-nums text-text"
            placeholder="----"
            autoComplete="off"
          />
        </label>

        <button
          type="button"
          className={PRIMARY_BUTTON}
          disabled={pending || employeeCode.trim() === "" || pin === ""}
          onClick={() => void handleSubmit()}
        >
          <KeyRound className="h-6 w-6" />
          Unlock supervisor mode
        </button>
      </div>
    </div>
  );
}

// ── SupervisorBanner ──────────────────────────────────────────────────

/** Persistent banner shown while a supervisor session is open.
 *
 *  The expiresAt string is the ISO value from StationView.supervisor
 *  (set in getStationView from the DB row). We parse it once and then
 *  tick a local counter every second; on each tick we re-derive
 *  remaining seconds using supervisorSessionRemainingSeconds so the
 *  clamping and floor math stay in the single engine function.
 *
 *  At zero, the banner renders as LOCKED and the screen waits for the
 *  next view refresh (which will call getStationView → requireSupervisor
 *  Session, lazily closing the expired row, and return supervisor: null). */
export function SupervisorBanner({
  supervisor,
  token,
  stationId,
}: {
  supervisor: SupervisorSessionSnapshot | { employeeName: string; expiresAt: string };
  token: string;
  stationId: string;
}) {
  // Normalise: StationView carries expiresAt as an ISO string (types.ts);
  // SupervisorSessionSnapshot carries it as a Date (from the engine module).
  // Accept both so the banner is usable in tests with either shape.
  const expiresAtDate = React.useMemo(() => {
    const raw = supervisor.expiresAt;
    return raw instanceof Date ? raw : new Date(raw as string);
  }, [supervisor.expiresAt]);

  const [remaining, setRemaining] = React.useState(() =>
    supervisorSessionRemainingSeconds(expiresAtDate, new Date()),
  );
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Tick every second. Clears when unmounted (next view refresh will
  // have swapped view.supervisor already).
  React.useEffect(() => {
    const id = setInterval(() => {
      setRemaining(supervisorSessionRemainingSeconds(expiresAtDate, new Date()));
    }, 1000);
    return () => clearInterval(id);
  }, [expiresAtDate]);

  const isExpired = remaining === 0;

  const handleExit = async () => {
    setPending(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("token", token);
      fd.set("stationId", stationId);
      await supervisorLockAction(fd);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not exit supervisor mode.");
    } finally {
      setPending(false);
    }
  };

  if (isExpired) {
    return (
      <div className="border-b border-border bg-surface px-4 py-2">
        <p className="text-center text-sm font-medium text-text-muted">
          Supervisor session expired — locked
        </p>
      </div>
    );
  }

  return (
    <div className="border-b border-border bg-amber-50 px-4 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Shield className="h-4 w-4 flex-shrink-0 text-amber-700" />
          <span className="text-sm font-medium text-amber-900 truncate">
            {supervisor.employeeName}
          </span>
          <span className="text-sm font-semibold tabular-nums text-amber-700">
            {formatCountdown(remaining)}
          </span>
        </div>
        <button
          type="button"
          onClick={() => void handleExit()}
          disabled={pending}
          className="flex-shrink-0 rounded-lg border border-amber-300 bg-amber-100 px-3 py-1 text-sm font-medium text-amber-900 hover:bg-amber-200 disabled:opacity-60"
        >
          Exit
        </button>
      </div>
      {error ? (
        <p className="mt-1 text-xs text-rose-700">{error}</p>
      ) : null}
    </div>
  );
}
