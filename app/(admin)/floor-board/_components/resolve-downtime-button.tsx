"use client";

// [ Resolved ] button for DOWNTIME_STARTED workflow-event rows on the Act Now
// rail (P6 Task 6). Calls resolveDowntimeAction which emits DOWNTIME_ENDED via
// the engine. Mirrors acknowledge-button.tsx's pattern exactly.

import { useTransition } from "react";
import { resolveDowntimeAction } from "../actions";

export function ResolveDowntimeButton({ downtimeEventId }: { downtimeEventId: string }) {
  const [pending, startTransition] = useTransition();

  function handleClick() {
    startTransition(async () => {
      await resolveDowntimeAction(downtimeEventId);
    });
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={pending}
      className="mt-1.5 self-start rounded border border-slate-600/50 bg-slate-800/60 px-2 py-0.5 text-[10.5px] font-medium text-slate-300 hover:border-slate-500/70 hover:bg-slate-700/60 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
    >
      {pending ? "Resolving..." : "Resolved"}
    </button>
  );
}
