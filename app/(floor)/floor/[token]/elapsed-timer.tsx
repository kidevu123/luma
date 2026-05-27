"use client";

import * as React from "react";
import { formatElapsedSeconds } from "@/lib/floor-time";

export function ElapsedTimer({
  startedAtMs,
  pausedSecondsAccum,
  isPaused,
  pausedAtMs,
}: {
  startedAtMs: number;
  pausedSecondsAccum: number;
  isPaused: boolean;
  pausedAtMs: number | null;
}) {
  const [elapsed, setElapsed] = React.useState(0);

  React.useEffect(() => {
    function compute() {
      const now = Date.now();
      const inPause =
        isPaused && pausedAtMs != null ? now - pausedAtMs : 0;
      const activeMs = Math.max(
        0,
        now - startedAtMs - pausedSecondsAccum * 1000 - inPause,
      );
      setElapsed(Math.floor(activeMs / 1000));
    }
    compute();
    if (!isPaused) {
      const id = setInterval(compute, 1000);
      return () => clearInterval(id);
    }
  }, [startedAtMs, pausedSecondsAccum, isPaused, pausedAtMs]);

  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-2 text-center">
      <p className="text-[11px] font-medium uppercase tracking-widest text-text-muted">
        {isPaused ? "Paused at" : "Elapsed"}
      </p>
      <p className="text-3xl font-semibold tabular-nums leading-tight text-text">
        {formatElapsedSeconds(elapsed)}
      </p>
    </div>
  );
}
