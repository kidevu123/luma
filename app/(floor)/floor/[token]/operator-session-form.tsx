"use client";

// OP-1C — Operator session UI block on the floor station page.
//
// Renders one of two states:
//   1) No active session → "Open shift" form (employee code or free text)
//   2) Active session    → "Operator: {name} · End shift" controls
//
// The forms use the same observable pattern as rolls-forms.tsx —
// pending state, success and error banners, button-disable while
// pending — so a tablet operator can tell whether their tap landed.

import * as React from "react";
import {
  endOperatorSessionAction,
  openOperatorSessionAction,
} from "./operator-session-actions";

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
  activeSession,
  employeeOptions,
}: {
  token: string;
  stationId: string;
  activeSession: ActiveSession | null;
  employeeOptions: EmployeeOption[];
}) {
  if (activeSession) {
    return (
      <ActiveSessionView
        token={token}
        stationId={stationId}
        session={activeSession}
      />
    );
  }
  return (
    <OpenSessionForm
      token={token}
      stationId={stationId}
      employeeOptions={employeeOptions}
    />
  );
}

function ActiveSessionView({
  token,
  stationId,
  session,
}: {
  token: string;
  stationId: string;
  session: ActiveSession;
}) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirming, setConfirming] = React.useState(false);

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
  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-emerald-800/80">
            Operator on shift
          </div>
          <div className="text-base font-semibold tracking-tight">
            {session.employeeNameSnapshot}
          </div>
          <div className="text-[11px] text-emerald-900/70">
            Source: {session.accountabilitySource}
            {" · "}
            Opened {openedSince.toLocaleTimeString()}
            {!session.employeeId ? " · LOW confidence (free text)" : ""}
          </div>
        </div>
        <button
          type="button"
          onClick={endShift}
          disabled={pending}
          className={`rounded-lg px-3 py-2 text-xs font-medium transition-colors disabled:opacity-60 ${
            confirming
              ? "bg-rose-700 text-white hover:bg-rose-800"
              : "bg-white border border-emerald-200 text-emerald-800 hover:bg-emerald-100"
          }`}
        >
          {pending
            ? "Ending…"
            : confirming
              ? "Confirm end shift"
              : "End shift"}
        </button>
      </div>
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
}: {
  token: string;
  stationId: string;
  employeeOptions: EmployeeOption[];
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
      // Picker option selected → resolve via the picked option's
      // employee code. Falls back to free-text input if neither.
      let employeeCode = "";
      if (picked) {
        const match = employeeOptions.find((o) => o.id === picked);
        if (match?.employeeCode) employeeCode = match.employeeCode;
        else if (match) {
          // Picker chose someone with no code — pass their full name
          // as freeText so the resolver can still snapshot it.
          fd.set("freeText", match.fullName);
        }
      }
      if (code) employeeCode = code;
      if (employeeCode) fd.set("employeeCode", employeeCode);
      if (freeText && !employeeCode) fd.set("freeText", freeText);

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
          Pick yourself from the list, type your operator code, or
          enter your full name. Required before submitting any count.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <select
          value={picked}
          onChange={(e) => {
            setPicked(e.target.value);
            setCode("");
            setFreeText("");
          }}
          disabled={pending}
          className="h-11 px-3 rounded-lg bg-surface border border-border text-sm"
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
            setFreeText("");
          }}
          placeholder="Op code"
          disabled={pending}
          className="h-11 px-3 rounded-lg bg-surface border border-border text-sm tabular-nums"
        />
      </div>
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
        className="h-11 w-full px-3 rounded-lg bg-surface border border-border text-sm"
      />
      <button
        type="submit"
        disabled={pending || (!picked && !code && !freeText)}
        className="w-full h-11 inline-flex items-center justify-center gap-2 rounded-xl bg-brand-700 text-white text-sm font-semibold shadow-sm hover:bg-brand-800 disabled:opacity-60"
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
