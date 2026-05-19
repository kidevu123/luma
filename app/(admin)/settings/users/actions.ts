"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { hashPassword } from "@/lib/auth";
import { requireAdmin } from "@/lib/auth-guards";

const ASSIGNABLE_ROLES = ["ADMIN", "MANAGER", "LEAD", "STAFF"] as const;
type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

const createSchema = z.object({
  email: z.string().min(3).max(254).regex(/^.+@.+$/, "Email must contain @"),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
  role: z.enum(ASSIGNABLE_ROLES),
});

export async function createUserAction(
  formData: FormData,
): Promise<{ error: string } | { ok: true }> {
  await requireAdmin();

  const parsed = createSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    role: formData.get("role"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = lower(${parsed.data.email})`);
  if (existing) {
    return { error: "A user with that email already exists." };
  }

  const passwordHash = await hashPassword(parsed.data.password);
  await db.insert(users).values({
    email: parsed.data.email.toLowerCase(),
    passwordHash,
    role: parsed.data.role,
    mustChangePassword: true,
  });

  revalidatePath("/settings/users");
  return { ok: true };
}

const updateRoleSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(ASSIGNABLE_ROLES),
});

export async function updateRoleAction(
  formData: FormData,
): Promise<{ error: string } | { ok: true }> {
  const me = await requireAdmin();

  const parsed = updateRoleSchema.safeParse({
    userId: formData.get("userId"),
    role: formData.get("role"),
  });
  if (!parsed.success) return { error: "Invalid input." };

  if (parsed.data.userId === me.id) {
    return { error: "You cannot change your own role." };
  }

  const [target] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, parsed.data.userId));
  if (!target) return { error: "User not found." };
  if (target.role === "OWNER" && me.role !== "OWNER") {
    return { error: "Only owners can modify owner accounts." };
  }

  await db
    .update(users)
    .set({ role: parsed.data.role as AssignableRole, updatedAt: new Date() })
    .where(eq(users.id, parsed.data.userId));

  revalidatePath("/settings/users");
  return { ok: true };
}

export async function disableUserAction(
  formData: FormData,
): Promise<{ error: string } | { ok: true }> {
  const me = await requireAdmin();

  const userId = z.string().uuid().safeParse(formData.get("userId"));
  if (!userId.success) return { error: "Invalid input." };

  if (userId.data === me.id) {
    return { error: "You cannot disable your own account." };
  }

  const [target] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId.data));
  if (!target) return { error: "User not found." };
  if (target.role === "OWNER" && me.role !== "OWNER") {
    return { error: "Only owners can disable owner accounts." };
  }

  await db
    .update(users)
    .set({ disabledAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, userId.data));

  revalidatePath("/settings/users");
  return { ok: true };
}

export async function enableUserAction(
  formData: FormData,
): Promise<{ error: string } | { ok: true }> {
  await requireAdmin();

  const userId = z.string().uuid().safeParse(formData.get("userId"));
  if (!userId.success) return { error: "Invalid input." };

  await db
    .update(users)
    .set({ disabledAt: null, updatedAt: new Date() })
    .where(eq(users.id, userId.data));

  revalidatePath("/settings/users");
  return { ok: true };
}

const resetPasswordSchema = z.object({
  userId: z.string().uuid(),
  newPassword: z.string().min(8, "Password must be at least 8 characters").max(200),
});

export async function resetPasswordAction(
  formData: FormData,
): Promise<{ error: string } | { ok: true }> {
  await requireAdmin();

  const parsed = resetPasswordSchema.safeParse({
    userId: formData.get("userId"),
    newPassword: formData.get("newPassword"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const [target] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, parsed.data.userId));
  if (!target) return { error: "User not found." };

  const passwordHash = await hashPassword(parsed.data.newPassword);
  await db
    .update(users)
    .set({ passwordHash, mustChangePassword: true, updatedAt: new Date() })
    .where(eq(users.id, parsed.data.userId));

  revalidatePath("/settings/users");
  return { ok: true };
}
