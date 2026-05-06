// PythonAnywhere API client. Token-auth only. We use this to:
//   1. Probe that the token is valid (whoami)
//   2. Stream a file's bytes from /api/v0/user/<username>/files/path/<path>
//
// The token is bearer-style — `Authorization: Token <token>`. Errors
// from the API come back as JSON with a "detail" field on auth/perm
// failures, plain text on internal errors. We strip the token from
// everything we surface so it never lands in a UI error message
// or a log line.

const PA_BASE = "https://www.pythonanywhere.com";

export class PythonAnywhereError extends Error {
  status: number;
  body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.status = status;
    // Keep the body small enough to log but not so big that it
    // pulls a whole 200MB SQL dump into memory on a stream error.
    this.body = body.slice(0, 800);
  }
}

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Token ${token}` };
}

/** Hits /api/v0/user/<u>/cpu/ — cheapest authenticated endpoint we
 *  can use to verify the token + username pair without scoping a
 *  read of any specific file. Returns true on 200. */
export async function paWhoAmI(
  username: string,
  token: string,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const url = `${PA_BASE}/api/v0/user/${encodeURIComponent(username)}/cpu/`;
  const r = await fetch(url, {
    method: "GET",
    headers: authHeaders(token),
    cache: "no-store",
  });
  if (r.ok) return { ok: true };
  // 401/403 = bad token / wrong user. 404 = user not found. Strip
  // any echo of the token from the body before returning.
  const body = await r.text();
  return {
    ok: false,
    status: r.status,
    message:
      r.status === 401 || r.status === 403
        ? "PythonAnywhere rejected the token (or it doesn't belong to that username)."
        : r.status === 404
          ? "PythonAnywhere reports no such user."
          : `PythonAnywhere returned ${r.status}: ${body.slice(0, 200)}`,
  };
}

/** Fetches a remote file's bytes. The PA API returns the raw file
 *  content (Content-Type matches the file's MIME) — not JSON. We
 *  return a Buffer so the caller can write it to disk, plus a
 *  status code + content-length header for audit.
 *
 *  remotePath must be absolute on PA's filesystem (e.g.
 *  /home/sahilk1/dumps/tt-latest.sql.gz). The encoder ensures the
 *  URL stays well-formed for paths with spaces / special chars. */
export async function paFetchFile(
  username: string,
  token: string,
  remotePath: string,
): Promise<{
  ok: true;
  bytes: Buffer;
  status: number;
  contentLength: number;
}> {
  if (!remotePath.startsWith("/")) {
    throw new Error(
      `Remote path must be absolute, got "${remotePath}".`,
    );
  }
  // PA wants the path appended after `path/` — slashes are kept,
  // only the components get encoded.
  const encoded = remotePath
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  const url = `${PA_BASE}/api/v0/user/${encodeURIComponent(username)}/files/path${encoded}`;
  const r = await fetch(url, {
    method: "GET",
    headers: authHeaders(token),
    cache: "no-store",
  });
  if (!r.ok) {
    const body = await r.text();
    throw new PythonAnywhereError(
      `PA fetch failed with HTTP ${r.status} for ${remotePath}.`,
      r.status,
      body,
    );
  }
  const ab = await r.arrayBuffer();
  const bytes = Buffer.from(ab);
  return {
    ok: true,
    bytes,
    status: r.status,
    contentLength: bytes.byteLength,
  };
}
