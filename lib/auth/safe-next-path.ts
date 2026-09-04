// SSO-NEXT-1 — validate a post-login destination.
//
// The only safe shape is a SITE-RELATIVE path: exactly one leading slash,
// with the next character neither "/" nor "\". Both of those turn the value
// into a protocol-relative URL that `new URL(value, appBase)` resolves to a
// FOREIGN origin — the open-redirect this guard exists to prevent. Query
// strings and hashes are preserved: closeout deep links carry them.

const MAX_LENGTH = 512;

export function safeNextPath(
  // Next.js hands an array when a query param repeats (?next=a&next=b);
  // the `typeof raw !== "string"` guard below already rejects that shape
  // and falls back, so callers can pass a raw searchParams value straight
  // through without narrowing it first.
  raw: string | string[] | null | undefined,
  fallback = "/dashboard",
): string {
  if (typeof raw !== "string") return fallback;
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_LENGTH) return fallback;
  if (!value.startsWith("/")) return fallback;
  // Second character decides: "//host" and "/\host" both escape the origin.
  const second = value.charAt(1);
  if (second === "/" || second === "\\") return fallback;
  // Control characters could smuggle headers when interpolated.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return fallback;
  // Bouncing back to the login page would loop the operator.
  if (value === "/login" || value.startsWith("/login?") || value.startsWith("/login/")) {
    return fallback;
  }
  return value;
}
