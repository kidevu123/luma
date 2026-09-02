// SIMPLIFY-A — module-level suppression counter for AutoRefreshOnFocus.
// A drawer, an open form, or the guided overlay acquires suppression while
// mounted so a background router.refresh() cannot re-derive the page under
// an operator mid-task. Client-bundle singleton; no React state needed.

import * as React from "react";

let holders = 0;

export function acquireRefreshSuppression(): () => void {
  holders += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
  };
}

export function isRefreshSuppressed(): boolean {
  return holders > 0;
}

/** Suppress auto-refresh while the calling component is mounted (and `active`). */
export function useRefreshSuppression(active: boolean = true): void {
  React.useEffect(() => {
    if (!active) return;
    return acquireRefreshSuppression();
  }, [active]);
}
