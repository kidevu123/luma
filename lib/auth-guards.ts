// Authorization guards — call from server actions + page loaders.

import { redirect } from "next/navigation";
import { currentUser, type CurrentUser } from "@/lib/auth";
import { safeNextPath } from "@/lib/auth/safe-next-path";

type Role = CurrentUser["role"];

type GuardOptions = { next?: string };

// SSO-NEXT-1 — come back here after signing in. A middleware.ts that reads
// the request path would force Next.js to compile an Edge bundle, which
// pulls instrumentation.ts (OpenTelemetry / @grpc/grpc-js, needing Node
// builtins) into that Edge compile and breaks `next build`. So instead:
// deep-linkable pages pass their own path explicitly via `options.next`.
// Callers that don't (most of them — dashboards, actions, API routes) get a
// plain /login, which lands on /dashboard.
export async function requireSession(options?: GuardOptions): Promise<CurrentUser> {
  const u = await currentUser();
  if (!u) {
    const safe = safeNextPath(options?.next, "");
    redirect(safe ? `/login?next=${encodeURIComponent(safe)}` : "/login");
  }
  return u;
}

export async function requireRole(roles: Role[], options?: GuardOptions): Promise<CurrentUser> {
  const u = await requireSession(options);
  if (!roles.includes(u.role)) redirect("/");
  return u;
}

export async function requireAdmin(options?: GuardOptions): Promise<CurrentUser> {
  return requireRole(["OWNER", "ADMIN"], options);
}

export async function requireLead(options?: GuardOptions): Promise<CurrentUser> {
  return requireRole(["OWNER", "ADMIN", "MANAGER", "LEAD"], options);
}

export async function requireOwner(options?: GuardOptions): Promise<CurrentUser> {
  return requireRole(["OWNER"], options);
}
