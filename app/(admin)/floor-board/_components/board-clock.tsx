"use client";

import * as React from "react";

/** Ticking clock in the company timezone. Renders after mount to avoid
 *  a server/client hydration mismatch. */
export function BoardClock({ tz }: { tz: string }) {
  const [now, setNow] = React.useState<Date | null>(null);

  React.useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!now) {
    return <span className="tabular-nums text-slate-500">--:--:--</span>;
  }

  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now);

  return <span className="tabular-nums">{time}</span>;
}
