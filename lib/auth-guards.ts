// Authorization guards — call from server actions + page loaders.

import { redirect } from "next/navigation";
import { currentUser, type CurrentUser } from "@/lib/auth";

type Role = CurrentUser["role"];

export async function requireSession(): Promise<CurrentUser> {
  const u = await currentUser();
  if (!u) redirect("/login");
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
