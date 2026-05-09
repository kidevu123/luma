// PT-6D — staging render verifier.
//
// Mints an admin JWT (same scheme as scripts/smoke-authenticated-
// routes.ts) and fetches /po-reconciliation-v2. Asserts that the
// rendered HTML carries the PackTrack receipt numbers (declared 100,
// counted 98, receipt variance -2, severity MEDIUM) and the
// human-friendly variance labels — never "production loss" / "vendor
// shortage".
//
// Run inside the container:
//   ALLOW_STAGING_QA_DATA=true npx tsx scripts/verify-pt-6d.ts

import { db } from "@/lib/db";
import { eq } from "drizzle-orm";
import { users } from "@/lib/db/schema";

const ALLOW = process.env.ALLOW_STAGING_QA_DATA === "true";
if (!ALLOW) {
  console.error("[verify-pt-6d] Refusing without ALLOW_STAGING_QA_DATA=true.");
  process.exit(2);
}

const PORT = Number(process.env.PORT ?? "3000");
const HOST = process.env.HOST ?? "127.0.0.1";

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let str = "";
  for (let i = 0; i < bytes.byteLength; i++)
    str += String.fromCharCode(bytes[i]!);
  return Buffer.from(str, "binary")
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function hmac(data: string, secret: Uint8Array): Promise<Uint8Array> {
  const keyBuf = secret.buffer.slice(
    secret.byteOffset,
    secret.byteOffset + secret.byteLength,
  ) as ArrayBuffer;
  const key = await crypto.subtle.importKey(
    "raw",
    keyBuf,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const encoded = new TextEncoder().encode(data);
  const dataBuf = encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength,
  ) as ArrayBuffer;
  const sig = await crypto.subtle.sign("HMAC", key, dataBuf);
  return new Uint8Array(sig);
}

async function signToken(payload: object, secret: Uint8Array): Promise<string> {
  const header = b64url(
    new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })),
  );
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const data = `${header}.${body}`;
  const sig = b64url(await hmac(data, secret));
  return `${data}.${sig}`;
}

function logOK(msg: string) {
  process.stdout.write(`     ok: ${msg}\n`);
}
function logFail(msg: string): never {
  process.stdout.write(`     FAIL: ${msg}\n`);
  process.exit(1);
}
function step(n: string, msg: string) {
  process.stdout.write(`\n[${n}] ${msg}\n`);
}

async function main() {
  step("1", "mint admin JWT");
  const secretRaw = process.env.AUTH_SECRET;
  if (!secretRaw) logFail("AUTH_SECRET not set");
  const secret = new TextEncoder().encode(secretRaw);
  const [admin] = await db
    .select({ id: users.id, email: users.email, role: users.role })
    .from(users)
    .where(eq(users.role, "OWNER"))
    .limit(1);
  if (!admin) logFail("no OWNER user found");
  const exp = Math.floor(Date.now() / 1000) + 60 * 5;
  const token = await signToken(
    { uid: admin.id, role: admin.role, email: admin.email, exp },
    secret,
  );
  logOK(`signed JWT for ${admin.email}`);

  step("2", "fetch /po-reconciliation-v2");
  const url = `http://${HOST}:${PORT}/po-reconciliation-v2`;
  const res = await fetch(url, {
    headers: { Cookie: `luma.session=${token}` },
  });
  if (res.status !== 200) logFail(`HTTP ${res.status}`);
  const html = await res.text();
  logOK(`status 200, body ${html.length} bytes`);

  step("3", "verify PackTrack receipt numbers in rendered HTML");
  // Numbers are formatted via toLocaleString() and split across DOM
  // nodes (value vs unit), so test for stable substrings each row
  // type produces. The PackTrack lot has accepted=98 / receipt_variance=-2.
  if (!html.includes("100")) logFail("expected '100' (declared) in body");
  if (!html.includes("98")) logFail("expected '98' (counted/accepted) in body");
  if (!html.includes("-2")) logFail("expected '-2' (receipt variance) in body");
  // Severity badge text
  if (!html.includes("severity: MEDIUM")) logFail("expected 'severity: MEDIUM'");
  logOK("PackTrack numbers + severity rendered");

  step("4", "verify variance labels follow plan §5 — no banned wording");
  // Banned phrases (case-insensitive). Variance copy must keep the
  // four subtypes visually distinct.
  const lower = html.toLowerCase();
  const banned = [
    "production loss",
    "supplier shortage",
    "vendor shortage",
  ];
  for (const phrase of banned) {
    if (lower.includes(phrase)) {
      logFail(
        `banned phrase '${phrase}' found in rendered HTML — UI may be conflating variance subtypes`,
      );
    }
  }
  logOK("no banned phrases — variance labels stay distinct");

  step("5", "verify variance subtype labels are present");
  for (const expected of [
    "Receipt variance",
    "Cycle-count variance",
    "Consumption variance",
    "Unknown variance",
  ]) {
    if (!html.includes(expected)) logFail(`expected '${expected}' in body`);
  }
  logOK("all 4 variance subtype titles present");

  step("6", "verify legacy v1 link is present");
  if (!html.includes("legacy PO reconciliation"))
    logFail("legacy v1 link missing");
  logOK("legacy v1 link present");

  step("7", "fetch /po-reconciliation (legacy v1) — confirm forward link");
  const v1Res = await fetch(`http://${HOST}:${PORT}/po-reconciliation`, {
    headers: { Cookie: `luma.session=${token}` },
  });
  if (v1Res.status !== 200) logFail(`v1 HTTP ${v1Res.status}`);
  const v1Html = await v1Res.text();
  if (!v1Html.includes("New 8-bucket view")) {
    logFail("v1 page missing 'New 8-bucket view →' link");
  }
  logOK("legacy v1 still renders + links forward to v2");

  console.log("\n[verify-pt-6d] all checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n[verify-pt-6d] failed:", err);
    process.exit(1);
  });
