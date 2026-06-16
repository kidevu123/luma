// ZOHO-STAGING-BUFFER-v1.1.0 — cron-route bearer authentication.
//
// The auto-commit cron endpoint is exposed on the same Next.js app
// the operator UI runs on, so it must be authenticated to prevent
// anyone with network access to the LXC from triggering Zoho writes.
// The systemd timer on the LXC calls the endpoint with an
// `Authorization: Bearer <LUMA_CRON_SECRET>` header; nothing else
// gets in.
//
// Contract:
//   - The secret is read from the LUMA_CRON_SECRET env var.
//   - If the env var is missing OR empty, EVERY request is rejected
//     (including ones that happen to send a matching header). This
//     fails closed if the env file is misconfigured.
//   - Constant-time comparison so timing attacks can't enumerate the
//     secret byte-by-byte.

import { timingSafeEqual } from "node:crypto";

export const LUMA_CRON_SECRET_ENV = "LUMA_CRON_SECRET";

export type CronAuthResult =
  | { ok: true }
  | { ok: false; reason: "NOT_CONFIGURED" | "MISSING_HEADER" | "BAD_SCHEME" | "BAD_SECRET" };

/** Parse and validate the `Authorization: Bearer <token>` header
 *  against LUMA_CRON_SECRET. Pure-function-ish: env is passed in so
 *  tests can stub it deterministically. */
export function validateCronBearer(
  authorizationHeader: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): CronAuthResult {
  const configured = env[LUMA_CRON_SECRET_ENV];
  if (!configured || configured.trim().length === 0) {
    // Fail closed: if the env var isn't set on this deployment, the
    // cron endpoint refuses every request. This catches the case
    // where someone deploys the app without configuring the secret.
    return { ok: false, reason: "NOT_CONFIGURED" };
  }

  if (!authorizationHeader) {
    return { ok: false, reason: "MISSING_HEADER" };
  }

  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  if (!match) {
    return { ok: false, reason: "BAD_SCHEME" };
  }
  const presented = match[1]!.trim();
  if (presented.length === 0) {
    return { ok: false, reason: "BAD_SECRET" };
  }

  // Constant-time compare. timingSafeEqual requires equal-length
  // buffers; if they differ in length, compare against a buffer of
  // the same length first to keep the timing constant.
  const a = Buffer.from(presented);
  const b = Buffer.from(configured.trim());
  if (a.length !== b.length) {
    // Drain the timing channel by still doing a compare against a
    // same-length buffer.
    timingSafeEqual(a, Buffer.alloc(a.length));
    return { ok: false, reason: "BAD_SECRET" };
  }
  if (!timingSafeEqual(a, b)) {
    return { ok: false, reason: "BAD_SECRET" };
  }
  return { ok: true };
}

/** HTTP status to return for each failure reason. */
export function cronAuthHttpStatus(reason: Exclude<CronAuthResult, { ok: true }>["reason"]): number {
  switch (reason) {
    case "NOT_CONFIGURED":
      return 503; // service is mis-configured; tell the caller to fix infra
    case "MISSING_HEADER":
    case "BAD_SCHEME":
    case "BAD_SECRET":
      return 401;
  }
}
