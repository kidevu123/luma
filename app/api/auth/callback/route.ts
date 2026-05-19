import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { createSessionCookie } from "@/lib/auth";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const loginUrl = new URL("/login", request.url);

  const cookieHeader = request.headers.get("cookie") ?? "";
  const raw = cookieHeader.split(";").find((c) => c.trim().startsWith("oidc_state="))?.split("=").slice(1).join("=") ?? "";
  const colonIdx = raw.indexOf(":");
  const storedState = colonIdx >= 0 ? raw.slice(0, colonIdx) : raw;
  const nextUrl = colonIdx >= 0 ? decodeURIComponent(raw.slice(colonIdx + 1)) : "/dashboard";

  if (!code || !state || state !== storedState) {
    loginUrl.searchParams.set("error", "sso_state");
    return NextResponse.redirect(loginUrl);
  }

  const issuer = process.env.AUTHENTIK_ISSUER!;
  const clientId = process.env.AUTHENTIK_CLIENT_ID!;
  const clientSecret = process.env.AUTHENTIK_CLIENT_SECRET!;
  const appBase = process.env.APP_URL ?? "http://localhost:3000";
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
  const userinfo = await userinfoResp.json() as { sub: string; email?: string };

  const email = userinfo.email?.toLowerCase().trim();
  if (!email) {
    loginUrl.searchParams.set("error", "sso_no_email");
    return NextResponse.redirect(loginUrl);
  }

  const [user] = await db.select().from(users).where(sql`lower(${users.email}) = ${email}`);
  if (!user || user.disabledAt) {
    loginUrl.searchParams.set("error", "sso_no_account");
    return NextResponse.redirect(loginUrl);
  }

  if (!user.authentikSubject) {
    await db.update(users).set({ authentikSubject: userinfo.sub }).where(eq(users.id, user.id));
  }

  const { name, value, options } = await createSessionCookie({ id: user.id, role: user.role, email: user.email });
  const response = NextResponse.redirect(new URL(nextUrl || "/dashboard", request.url));
  response.cookies.delete("oidc_state");
  response.cookies.set(name, value, options);
  return response;
}
