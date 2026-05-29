"use client";

// OP-1C — Operator session UI block on the floor station page.
//
// Renders one of two states:
//   1) No active session → "Open shift" form (employee picker / code)
//   2) Active session    → operator banner + End shift
//
// First-op count stations (BLISTER / COMBINED / BOTTLE_HANDPACK) require
// a stable employees.id on the session before BLISTER_COMPLETE /
// BOTTLE_HANDPACK_COMPLETE will succeed.

import * as React from "react";
import {
  endOperatorSessionAction,
  openOperatorSessionAction,
} from "./operator-session-actions";
import {
  FIRST_OP_COUNT_ACCOUNTABILITY_STATION_KINDS,
  sessionSatisfiesFirstOpCount,
} from "@/lib/production/station-operator-session";

type ActiveSession = {
  id: string;
  employeeId: string | null;
  employeeNameSnapshot: string;
  accountabilitySource: string;
  openedAt: Date;
};

type EmployeeOption = {
  id: string;
  fullName: string;
  employeeCode: string | null;
};

export function OperatorSessionPanel({
  token,
  stationId,
  stationKind,
  activeSession,
  employeeOptions,
}: {
  token: string;
  stationId: string;
  stationKind: string;
  activeSession: ActiveSession | null;
  employeeOptions: EmployeeOption[];
}) {
  const requiresStableEmployee =
    FIRST_OP_COUNT_ACCOUNTABILITY_STATION_KINDS.has(stationKind);

  if (activeSession) {
    return (
      <ActiveSessionView
        token={token}
        stationId={stationId}
        session={activeSession}
        requiresStableEmployee={requiresStableEmployee}
      />
    );
  }
  return (
    <OpenSessionForm
      token={token}
      stationId={stationId}
      employeeOptions={employeeOptions}
      requiresStableEmployee={requiresStableEmployee}
    />
  );
}

function ActiveSessionView({
  token,
  stationId,
  session,
  requiresStableEmployee,
}: {
  token: string;
  stationId: string;
  session: ActiveSession;
  requiresStableEmployee: boolean;
}) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirming, setConfirming] = React.useState(false);

  const readyForFirstCount =
    !requiresStableEmployee || sessionSatisfiesFirstOpCount(session);

  async function endShift() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("token", token);
      fd.set("stationId", stationId);
      const r = await endOperatorSessionAction(fd);
      if (r?.error) setError(r.error);
    } finally {
      setPending(false);
      setConfirming(false);
    }
  }

  const openedSince = new Date(session.openedAt);
  const shellCls = readyForFirstCount
    ? "rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
    : "rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950";
  const labelCls = readyForFirstCount
    ? "text-[11px] font-semibold uppercase tracking-[0.12em] text-emerald-800/80"
    : "text-[11px] font-semibold uppercase tracking-[0.12em] text-amber-900/80";
  const metaCls = readyForFirstCount
    ? "text-[11px] text-emerald-900/70"
    : "text-[11px] text-amber-900/80";

  return (
    <div className={shellCls}>
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <div className={labelCls}>
            {readyForFirstCount ? "Operator on shift" : "Low-confidence shift"}
          </div>
          <div className="text-base font-semibold tracking-tight">
            {session.employeeNameSnapshot}
          </div>
          <div className={metaCls}>
            Source: {session.accountabilitySource}
            {" · "}
            Opened {openedSince.toLocaleTimeString()}
            {!session.employeeId ? " · no linked employee" : ""}
          </div>
        </div>
        <button
          type="button"
          onClick={endShift}
          disabled={pending}
          className={`min-h-[44px] rounded-lg px-4 py-2.5 text-sm font-medium transition-colors disabled:opacity-60 ${
            confirming
              ? "bg-rose-700 text-white hover:bg-rose-800"
              : readyForFirstCount
                ? "bg-white border border-emerald-200 text-emerald-800 hover:bg-emerald-100"
                : "bg-white border border-amber-300 text-amber-900 hover:bg-amber-100"
          }`}
        >
          {pending
            ? "Ending…"
            : confirming
              ? "Confirm end shift"
              : "End shift"}
        </button>
      </div>
      {!readyForFirstCount ? (
        <p className="mt-2 text-xs rounded border border-amber-400/60 bg-amber-100/80 text-amber-950 px-2 py-2">
          Low-confidence operator session. Pick an employee from the list or
          enter a valid operator code before submitting the first count.
          BLISTER and bottle hand-pack close-out will stay blocked until then.
        </p>
      ) : null}
      {error && (
        <p className="mt-2 text-xs rounded border border-rose-300 bg-rose-50 text-rose-800 px-2 py-1">
          {error}
        </p>
      )}
    </div>
  );
}

function OpenSessionForm({
  token,
  stationId,
  employeeOptions,
  requiresStableEmployee,
}: {
  token: string;
  stationId: string;
  employeeOptions: EmployeeOption[];
  requiresStableEmployee: boolean;
}) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [picked, setPicked] = React.useState<string>("");
  const [code, setCode] = React.useState<string>("");
  const [freeText, setFreeText] = React.useState<string>("");

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("token", token);
      fd.set("stationId", stationId);
      if (picked) {
        fd.set("employeeId", picked);
      } else if (code) {
        fd.set("employeeCode", code);
      } else if (freeText) {
        fd.set("freeText", freeText);
      }

      const r = await openOperatorSessionAction(fd);
      if (r?.error) {
        setError(r.error);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 space-y-3"
    >
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-amber-800/80">
          No operator on shift
        </div>
        <p className="text-xs">
          {requiresStableEmployee
            ? "Pick yourself from the list or type your operator code. Required before blister or bottle hand-pack close-out."
            : "Pick yourself from the list or type your operator code."}
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <select
          value={picked}
          onChange={(e) => {
            setPicked(e.target.value);
            setCode("");
          }}
          disabled={pending}
          className="h-12 px-3 rounded-lg bg-surface border border-border text-base"
        >
          <option value="">— Pick employee —</option>
          {employeeOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.fullName}
              {o.employeeCode ? ` (${o.employeeCode})` : ""}
            </option>
          ))}
        </select>
        <input
          type="text"
          inputMode="numeric"
          value={code}
          onChange={(e) => {
            setCode(e.target.value.replace(/\s+/g, "").slice(0, 40));
            setPicked("");
          }}
          placeholder="Operator code"
          disabled={pending}
          className="h-12 px-3 rounded-lg bg-surface border border-border text-base tabular-nums"
        />
      </div>
      {!requiresStableEmployee ? (
        <input
          type="text"
          value={freeText}
          onChange={(e) => {
            setFreeText(e.target.value.slice(0, 120));
            if (e.target.value) {
              setPicked("");
              setCode("");
            }
          }}
          placeholder="Full name (last resort — marked LOW confidence)"
          disabled={pending}
          className="h-12 w-full px-3 rounded-lg bg-surface border border-border text-base"
        />
      ) : null}
      <button
        type="submit"
        disabled={
          pending || (!picked && !code && (!requiresStableEmployee ? !freeText : true))
        }
        className="w-full h-14 inline-flex items-center justify-center gap-2 rounded-xl bg-brand-700 text-white text-base font-semibold shadow-sm hover:bg-brand-800 disabled:opacity-60"
      >
        {pending ? "Opening shift…" : "Open shift"}
      </button>
      {error && (
        <p className="text-xs rounded border border-rose-300 bg-rose-50 text-rose-800 px-2 py-1">
          {error}
        </p>
      )}
    </form>
  );
}
