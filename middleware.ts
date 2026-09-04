// SSO-NEXT-1 — expose the requested path to server components.
//
// Next.js gives a server component no way to read its own URL, so a guard
// that wants to send the operator back after login needs the path from
// somewhere. This middleware ONLY copies it into a request header. It makes
// no auth decision, reads no session state, and never redirects or
// rewrites — every guard stays exactly where it is (per-page
// requireSession/-Admin).
//
// API and floor-API routes are excluded: they never redirect to /login, and
// station-token auth must stay off this path entirely.

import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set("x-luma-pathname", `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: [
    // Everything except API routes, floor API routes, and static assets.
    "/((?!api/|floor/api/|_next/static|_next/image|favicon.ico|manifest|icons/).*)",
  ],
};
