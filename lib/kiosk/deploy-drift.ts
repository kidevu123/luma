// Pure helpers for kiosk deploy-drift detection. The floor shell polls
// /api/kiosk/build-info and reloads when the remote SHA no longer
// matches the SHA the page was served with.

/** True when a long-lived kiosk tab should hard-reload for a new deploy. */
export function shouldReloadForDeployDrift(
  servedSha: string,
  remoteSha: string,
): boolean {
  const served = servedSha.trim();
  const remote = remoteSha.trim();
  if (served.length === 0 || remote.length === 0) return false;
  return served !== remote;
}

/** Default poll interval for build-info checks (3 minutes). */
export const KIOSK_BUILD_POLL_INTERVAL_MS = 3 * 60 * 1000;
