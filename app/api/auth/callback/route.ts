import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { createSessionCookie } from "@/lib/auth";
import { safeNextPath } from "@/lib/auth/safe-next-path";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  const appBase = process.env.APP_URL ?? "http://localhost:3000";
  const loginUrl = new URL("/login", appBase);

  // Use request.cookies.get() — it decodes the value, so the ":" separator is literal.
  // Manual Cookie-header parsing fails because Next.js encodeURIComponent's the value
  // in Set-Cookie, turning ":" into "%3A", which indexOf(":") can't find.
  const raw = request.cookies.get("oidc_state")?.value ?? "";
  const colonIdx = raw.indexOf(":");
  const storedState = colonIdx >= 0 ? raw.slice(0, colonIdx) : raw;
  // SSO-NEXT-1 — the cookie is httpOnly, but this is the last gate before
  // new URL(): validate here too, so no crafted state can bounce a signed-in
  // operator off-site.
  const nextUrl = safeNextPath(colonIdx >= 0 ? raw.slice(colonIdx + 1) : null);

  if (!code || !state || state !== storedState) {
    loginUrl.searchParams.set("error", "sso_state");
    return NextResponse.redirect(loginUrl);
  }

  const issuer = process.env.AUTHENTIK_ISSUER!;
  const clientId = process.env.AUTHENTIK_CLIENT_ID!;
  const clientSecret = process.env.AUTHENTIK_CLIENT_SECRET!;
  const redirectUri = `${appBase}/api/auth/callback`;

  const meta = await fetch(`${issuer}/.well-known/openid-configuration`).then((r) => r.json()) as {
    token_endpoint: string;
    userinfo_endpoint: string;
  };

  const tokenResp = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret }),
  });
  if (!tokenResp.ok) {
    loginUrl.searchParams.set("error", "sso_token");
    return NextResponse.redirect(loginUrl);
  }
  const { access_token } = await tokenResp.json() as { access_token: string };

  const userinfoResp = await fetch(meta.userinfo_endpoint, { headers: { Authorization: `Bearer ${access_token}` } });
  if (!userinfoResp.ok) {
    loginUrl.searchParams.set("error", "sso_userinfo");
    return NextResponse.redirect(loginUrl);
  }
  const userinfo = await userinfoResp.json() as { sub: string; email?: string; name?: string; preferred_username?: string };

  const email = userinfo.email?.toLowerCase().trim();
  if (!email) {
    loginUrl.searchParams.set("error", "sso_no_email");
    return NextResponse.redirect(loginUrl);
  }

  // Subject-first lookup: the Authentik subject is the stable identity. An
  // email-only lookup 500s with a users_authentik_unique violation when the
  // IdP email changes for an already-provisioned account (the email misses,
  // the JIT insert collides on the subject).
  let [user] = await db.select().from(users).where(eq(users.authentikSubject, userinfo.sub));

  if (!user) {
    [user] = await db.select().from(users).where(sql`lower(${users.email}) = ${email}`);
  }

  if (!user) {
    // JIT provision: first SSO login auto-creates the account with STAFF role.
    // Admin assigns the correct role afterward in the office UI. Conflict-safe:
    // a concurrent callback for the same subject re-selects instead of 500ing.
    [user] = await db
      .insert(users)
      .values({ email, role: "STAFF", authentikSubject: userinfo.sub })
      .onConflictDoNothing()
      .returning();
    if (!user) {
      [user] = await db.select().from(users).where(eq(users.authentikSubject, userinfo.sub));
    }
  }

  if (!user || user.disabledAt) {
    loginUrl.searchParams.set("error", "sso_no_account");
    return NextResponse.redirect(loginUrl);
  }

  if (!user.authentikSubject) {
    await db.update(users).set({ authentikSubject: userinfo.sub }).where(eq(users.id, user.id));
  }

  const { name, value, options } = await createSessionCookie({ id: user.id, role: user.role, email: user.email });
  const response = NextResponse.redirect(new URL(nextUrl || "/dashboard", appBase));
  response.cookies.delete("oidc_state");
  response.cookies.set(name, value, options);
  return response;
}
