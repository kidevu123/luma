"use client";

// Acknowledge button for station_exception_reports rows on the Act Now rail.
// Calls the server action and disables itself while the request is in flight.

import { useTransition } from "react";
import { acknowledgeStationReportAction } from "../actions";

export function AcknowledgeButton({ reportId }: { reportId: string }) {
  const [pending, startTransition] = useTransition();

  function handleClick() {
    startTransition(async () => {
      await acknowledgeStationReportAction(reportId);
    });
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={pending}
      className="mt-1.5 self-start rounded border border-slate-600/50 bg-slate-800/60 px-2 py-0.5 text-[10.5px] font-medium text-slate-300 hover:border-slate-500/70 hover:bg-slate-700/60 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
    >
      {pending ? "Acknowledging..." : "Acknowledge"}
    </button>
  );
}
