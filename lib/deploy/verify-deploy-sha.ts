/** Pure helpers for comparing git HEAD to the running app's /api/health SHA. */

export type DeployShaVerdict =
  | { ok: true; comparable: false; reason: "dev_build" }
  | { ok: true; comparable: true }
  | { ok: false; comparable: true; reason: "sha_mismatch" }
  | { ok: false; comparable: false; reason: "health_not_ok"; status: string };

export function evaluateDeployShaMatch(
  localSha: string,
  remoteSha: string,
  healthStatus: string,
): DeployShaVerdict {
  if (healthStatus !== "ok") {
    return { ok: false, comparable: false, reason: "health_not_ok", status: healthStatus };
  }
  if (remoteSha === "dev" || remoteSha === "local" || remoteSha === "unknown") {
    return { ok: true, comparable: false, reason: "dev_build" };
  }
  const short = (s: string) => s.trim().slice(0, 12);
  if (short(localSha) !== short(remoteSha)) {
    return { ok: false, comparable: true, reason: "sha_mismatch" };
  }
  return { ok: true, comparable: true };
}
