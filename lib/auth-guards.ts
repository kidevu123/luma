// Authorization guards — call from server actions + page loaders.

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { currentUser, type CurrentUser } from "@/lib/auth";
import { safeNextPath } from "@/lib/auth/safe-next-path";

type Role = CurrentUser["role"];

export async function requireSession(): Promise<CurrentUser> {
  const u = await currentUser();
  if (!u) {
    // SSO-NEXT-1 — come back here after signing in. The header is set by
    // middleware.ts; when it is absent (or unsafe) fall back to a plain
    // /login, which lands on /dashboard.
    let target: string | null = null;
    try {
      const h = await headers();
      const requested = h.get("x-luma-pathname");
      if (requested) {
        const safe = safeNextPath(requested, "");
        if (safe) target = safe;
      }
    } catch {
      // No request context (or headers unavailable) — plain login.
    }
    redirect(target ? `/login?next=${encodeURIComponent(target)}` : "/login");
  }
  return u;
}

export async function requireRole(...roles: Role[]): Promise<CurrentUser> {
  const u = await requireSession();
  if (!roles.includes(u.role)) redirect("/");
  return u;
}

export async function requireAdmin(): Promise<CurrentUser> {
  return requireRole("OWNER", "ADMIN");
}

export async function requireLead(): Promise<CurrentUser> {
  return requireRole("OWNER", "ADMIN", "MANAGER", "LEAD");
}

export async function requireOwner(): Promise<CurrentUser> {
  return requireRole("OWNER");
}
