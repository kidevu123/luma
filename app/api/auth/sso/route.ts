import { NextResponse } from "next/server";
import * as crypto from "crypto";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const next = searchParams.get("next") ?? "/dashboard";

  const issuer = process.env.AUTHENTIK_ISSUER!;
  const clientId = process.env.AUTHENTIK_CLIENT_ID!;
  const appBase = process.env.APP_URL ?? "http://localhost:3000";

  const metaResp = await fetch(`${issuer}/.well-known/openid-configuration`);
  const meta = (await metaResp.json()) as { authorization_endpoint: string };

  const state = crypto.randomBytes(32).toString("hex");
  const redirectUri = `${appBase}/api/auth/callback`;

  const authUrl = new URL(meta.authorization_endpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("state", state);

  const response = NextResponse.redirect(authUrl.toString());
  response.cookies.set("oidc_state", `${state}:${next}`, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 300,
    path: "/",
  });
  return response;
}
