// VALIDATION-1.1 — Authenticated route smoke.
//
// Mints a JWT cookie matching lib/auth.ts's signing scheme, then
// hits every admin route. Reports HTTP status and the Server
// Components digest from the body when a 500 happens.
//
// Run inside the staging container (where AUTH_SECRET + DATABASE_URL
// live):
//
//   ALLOW_STAGING_QA_DATA=true tsx scripts/smoke-authenticated-routes.ts
//
// Refuses to run when NODE_ENV=production unless ALLOW_STAGING_QA_DATA=true.

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

const PORT = Number(process.env.PORT ?? "3000");
const HOST = process.env.HOST ?? "127.0.0.1";

function refuseInProduction() {
  const envSaysProd = process.env.NODE_ENV === "production";
  const allow = process.env.ALLOW_STAGING_QA_DATA === "true";
  if (envSaysProd && !allow) {
    console.error(
      "[smoke-auth] Refusing to run: NODE_ENV=production and ALLOW_STAGING_QA_DATA != true.",
    );
    process.exit(2);
  }
}

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let str = "";
  for (let i = 0; i < bytes.byteLength; i++) str += String.fromCharCode(bytes[i]!);
  return Buffer.from(str, "binary")
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function hmac(data: string, secret: Uint8Array): Promise<Uint8Array> {
  const keyBuf = secret.buffer.slice(secret.byteOffset, secret.byteOffset + secret.byteLength) as ArrayBuffer;
  const key = await crypto.subtle.importKey(
    "raw",
    keyBuf,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const encoded = new TextEncoder().encode(data);
  const dataBuf = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
  const sig = await crypto.subtle.sign("HMAC", key, dataBuf);
  return new Uint8Array(sig);
}

async function signToken(payload: object, secret: Uint8Array): Promise<string> {
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const data = `${header}.${body}`;
  const sig = b64url(await hmac(data, secret));
  return `${data}.${sig}`;
}

const ROUTES: ReadonlyArray<{ path: string; group: string }> = [
  { group: "Overview",     path: "/dashboard" },
  { group: "Overview",     path: "/floor-board" },
  { group: "Operations",   path: "/inbound" },
  { group: "Operations",   path: "/inbound/packaging-materials" },
  { group: "Operations",   path: "/batches" },
  { group: "Operations",   path: "/finished-lots" },
  { group: "Operations",   path: "/qr-cards" },
  { group: "Operations",   path: "/recall" },
  { group: "Operations",   path: "/reports" },
  { group: "Operations",   path: "/metrics" },
  { group: "Operations",   path: "/metrics/forecast" },
  { group: "Production",   path: "/genealogy" },
  { group: "Production",   path: "/material-reconciliation" },
  { group: "Production",   path: "/operator-productivity" },
  { group: "Production",   path: "/packaging-output" },
  { group: "Production",   path: "/standards" },
  { group: "Production",   path: "/standards/calendars" },
  { group: "Production",   path: "/standards/due-targets" },
  { group: "Production",   path: "/standards/labor-rates" },
  { group: "Production",   path: "/standards/station-standards" },
  { group: "Materials",    path: "/packaging-inventory" },
  { group: "Materials",    path: "/active-rolls" },
  { group: "Materials",    path: "/roll-variance" },
  { group: "Materials",    path: "/material-alerts" },
  { group: "Materials",    path: "/po-reconciliation" },
  { group: "Materials",    path: "/packaging-receipts" },
  { group: "System",       path: "/workflow-validation" },
  { group: "System",       path: "/settings/integrations/packtrack" },
  { group: "System",       path: "/settings" },
  { group: "System",       path: "/settings/materials" },
  { group: "System",       path: "/settings/packaging-bom" },
  { group: "System",       path: "/settings/blister-standards" },
  { group: "System",       path: "/settings/product-structure" },
  { group: "System",       path: "/settings/raw-item-weights" },
  { group: "System",       path: "/settings/integrations/zoho-items" },
  { group: "System",       path: "/settings/zoho" },
  { group: "System",       path: "/settings/danger-zone" },
  { group: "System",       path: "/settings/legacy-import" },
  { group: "System",       path: "/products" },
  { group: "System",       path: "/tablet-types" },
  { group: "System",       path: "/machines" },
  { group: "System",       path: "/qr-cards/labels" },
  { group: "System",       path: "/packaging" },
];

async function main() {
  refuseInProduction();
  const databaseUrl = process.env.DATABASE_URL;
  const authSecret = process.env.AUTH_SECRET;
  if (!databaseUrl) throw new Error("DATABASE_URL missing");
  if (!authSecret || authSecret.length < 16)
    throw new Error("AUTH_SECRET missing or too short");

  // Pick the most-privileged user: OWNER, then ADMIN.
  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client);
  const rows = (await db.execute(sql`
    SELECT id::text AS id, email, role::text AS role
    FROM users
    WHERE disabled_at IS NULL AND role IN ('OWNER','ADMIN')
    ORDER BY CASE role WHEN 'OWNER' THEN 0 ELSE 1 END
    LIMIT 1
  `)) as unknown as Array<{ id: string; email: string; role: string }>;
  if (rows.length === 0) {
    console.error("[smoke-auth] No OWNER/ADMIN user found.");
    process.exit(1);
  }
  const u = rows[0]!;
  await client.end();

  const secret = new TextEncoder().encode(authSecret);
  const exp = Math.floor(Date.now() / 1000) + 60 * 5; // 5 min
  const token = await signToken({ uid: u.id, role: u.role, email: u.email, exp }, secret);
  const cookie = `luma.session=${token}`;

  console.log(`[smoke-auth] running ${ROUTES.length} routes as ${u.email} (${u.role})`);
  console.log(`[smoke-auth] target http://${HOST}:${PORT}\n`);

  type Result = {
    path: string;
    group: string;
    status: number;
    digest: string | null;
    excerpt: string | null;
  };
  const results: Result[] = [];

  for (const r of ROUTES) {
    const url = `http://${HOST}:${PORT}${r.path}`;
    let status = -1;
    let body = "";
    try {
      const res = await fetch(url, {
        method: "GET",
        redirect: "manual",
        headers: { Cookie: cookie, Accept: "text/html" },
      });
      status = res.status;
      // Only read body for 5xx — too noisy otherwise.
      if (status >= 500) {
        body = await res.text();
      }
    } catch (err) {
      status = -1;
      body = err instanceof Error ? err.message : String(err);
    }
    let digest: string | null = null;
    let excerpt: string | null = null;
    if (status >= 500 && body) {
      const m = body.match(/digest['"]?\s*[:=]\s*['"]?(\d+)/i);
      digest = m?.[1] ?? null;
      // Capture a meaningful excerpt — Next.js renders a generic
      // error page in prod; the digest is what links to logs.
      const errMatch = body.match(/<h2[^>]*>([^<]+)<\/h2>/);
      excerpt = errMatch?.[1] ?? body.slice(0, 200);
    }
    results.push({ path: r.path, group: r.group, status, digest, excerpt });
  }

  // Group output.
  const byGroup = new Map<string, Result[]>();
  for (const r of results) {
    const arr = byGroup.get(r.group) ?? [];
    arr.push(r);
    byGroup.set(r.group, arr);
  }

  let pass = 0;
  let redirect = 0;
  let fail = 0;
  for (const [group, items] of byGroup) {
    console.log(`── ${group} ──`);
    for (const r of items) {
      const tag =
        r.status === 200
          ? "PASS "
          : r.status >= 300 && r.status < 400
            ? "REDIR"
            : "FAIL ";
      if (r.status === 200) pass++;
      else if (r.status >= 300 && r.status < 400) redirect++;
      else fail++;
      const digestPart = r.digest ? `  digest=${r.digest}` : "";
      const excerptPart = r.excerpt ? `  msg="${r.excerpt}"` : "";
      console.log(`  ${tag} ${String(r.status).padStart(3)} ${r.path.padEnd(44)}${digestPart}${excerptPart}`);
    }
    console.log();
  }
  console.log(`[smoke-auth] PASS=${pass}  REDIR=${redirect}  FAIL=${fail}`);

  // Exit 1 if any FAIL — caller can detect.
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
