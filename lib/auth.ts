// Lightweight session auth — signed JWT cookie + argon2id password
// hashes. Authentik OIDC will subsume this once the client lands;
// until then it's the "admin@luma" bootstrap path so the rest of the
// shell has someone to gate behind.

import { cookies } from "next/headers";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import argon2 from "argon2";

const COOKIE_NAME = "luma.session";
const COOKIE_MAX_AGE = 60 * 60 * 8; // 8h

type SessionPayload = {
  uid: string;
  role: "OWNER" | "ADMIN" | "MANAGER" | "LEAD" | "STAFF";
  email: string;
  exp: number;
};

function getSecret(): Uint8Array {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) {
    throw new Error("AUTH_SECRET must be set (32+ chars recommended)");
  }
  return new TextEncoder().encode(s);
}

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let str = "";
  for (let i = 0; i < bytes.byteLength; i++) str += String.fromCharCode(bytes[i]!);
  return Buffer.from(str, "binary").toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlDecode(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad) s += "=".repeat(4 - pad);
  const bin = Buffer.from(s, "base64").toString("binary");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(data: string): Promise<Uint8Array> {
  // WebCrypto wants a strict BufferSource; cast through ArrayBuffer to
  // satisfy TS strict checks on ArrayBufferLike vs ArrayBuffer.
  const secret = getSecret();
  const keyBuf = secret.buffer.slice(secret.byteOffset, secret.byteOffset + secret.byteLength) as ArrayBuffer;
  const key = await crypto.subtle.importKey(
    "raw",
    keyBuf,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const encoded = new TextEncoder().encode(data);
  const dataBuf = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
  const sig = await crypto.subtle.sign("HMAC", key, dataBuf);
  return new Uint8Array(sig);
}

async function signToken(payload: SessionPayload): Promise<string> {
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const data = `${header}.${body}`;
  const sig = b64url(await hmac(data));
  return `${data}.${sig}`;
}

async function verifyToken(token: string): Promise<SessionPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  if (!header || !body || !sig) return null;
  const expected = b64url(await hmac(`${header}.${body}`));
  if (expected !== sig) return null;
  try {
    const decoded = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as SessionPayload;
    if (decoded.exp < Math.floor(Date.now() / 1000)) return null;
    return decoded;
  } catch {
    return null;
  }
}

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

export async function signIn(email: string, password: string): Promise<{ ok: true } | { error: string }> {
  const [row] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`);
  if (!row || !row.passwordHash) return { error: "Invalid email or password." };
  if (row.disabledAt) return { error: "Account disabled." };
  const ok = await verifyPassword(password, row.passwordHash);
  if (!ok) return { error: "Invalid email or password." };
  await db
    .update(users)
    .set({ lastLoginAt: new Date() })
    .where(eq(users.id, row.id));
  const exp = Math.floor(Date.now() / 1000) + COOKIE_MAX_AGE;
  const token = await signToken({
    uid: row.id,
    role: row.role,
    email: row.email,
    exp,
  });
  const c = await cookies();
  c.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && (process.env.APP_URL ?? "").startsWith("https"),
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
  return { ok: true };
}

export async function signOut(): Promise<void> {
  const c = await cookies();
  c.delete(COOKIE_NAME);
}

export type CurrentUser = {
  id: string;
  email: string;
  role: SessionPayload["role"];
};

export async function currentUser(): Promise<CurrentUser | null> {
  const c = await cookies();
  const token = c.get(COOKIE_NAME)?.value;
  if (!token) return null;
  const payload = await verifyToken(token);
  if (!payload) return null;
  return { id: payload.uid, email: payload.email, role: payload.role };
}
