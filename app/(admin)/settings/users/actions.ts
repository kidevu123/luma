"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { hashPassword } from "@/lib/auth";
import { requireAdmin } from "@/lib/auth-guards";
import { writeAudit } from "@/lib/db/audit";
import {
  DELETED_USER_LABEL,
  deletedUserTombstoneEmail,
} from "@/lib/users/display";

const ASSIGNABLE_ROLES = ["ADMIN", "MANAGER", "LEAD", "STAFF"] as const;
type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

const createSchema = z.object({
  email: z.string().min(3).max(254).regex(/^.+@.+$/, "Email must contain @"),
  name: z.string().max(120).optional(),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
  role: z.enum(ASSIGNABLE_ROLES),
});

export async function createUserAction(
  formData: FormData,
): Promise<{ error: string } | { ok: true }> {
  await requireAdmin();

  const parsed = createSchema.safeParse({
    email: formData.get("email"),
    name: formData.get("name") || undefined,
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
    ...(parsed.data.name?.trim() ? { name: parsed.data.name.trim() } : {}),
    passwordHash,
    role: parsed.data.role,
    mustChangePassword: true,
  });

  revalidatePath("/settings/users");
  return { ok: true };
}

// ── P3-USERS · edit profile (name + email) ──────────────────────────

const updateProfileSchema = z.object({
  userId: z.string().uuid(),
  name: z.string().max(120).optional(),
  email: z.string().min(3).max(254).regex(/^.+@.+$/, "Email must contain @"),
});

export async function updateUserProfileAction(
  formData: FormData,
): Promise<{ error: string } | { ok: true }> {
  const me = await requireAdmin();

  const parsed = updateProfileSchema.safeParse({
    userId: formData.get("userId"),
    name: formData.get("name") || undefined,
    email: formData.get("email"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const [target] = await db
    .select({
      id: users.id,
      role: users.role,
      name: users.name,
      email: users.email,
      deletedAt: users.deletedAt,
    })
    .from(users)
    .where(eq(users.id, parsed.data.userId));
  if (!target) return { error: "User not found." };
  if (target.deletedAt) return { error: "User is deleted." };
  if (target.role === "OWNER" && me.role !== "OWNER") {
    return { error: "Only owners can modify owner accounts." };
  }

  const [emailTaken] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        sql`lower(${users.email}) = lower(${parsed.data.email})`,
        ne(users.id, parsed.data.userId),
      ),
    );
  if (emailTaken) return { error: "Another user already has that email." };

  await db
    .update(users)
    .set({
      name: parsed.data.name?.trim() || null,
      email: parsed.data.email.toLowerCase(),
      updatedAt: new Date(),
    })
    .where(eq(users.id, parsed.data.userId));

  await writeAudit({
    actorId: me.id,
    actorRole: me.role,
    action: "user.update_profile",
    targetType: "User",
    targetId: parsed.data.userId,
    before: { name: target.name, email: target.email },
    after: {
      name: parsed.data.name?.trim() || null,
      email: parsed.data.email.toLowerCase(),
    },
  });

  revalidatePath("/settings/users");
  return { ok: true };
}

// ── P3-USERS · delete user ───────────────────────────────────────────
//
// Deletion anonymizes the row in place (per the repo's soft-delete
// convention nothing leaves the DB): name becomes "Deleted user",
// email becomes a unique tombstone, credentials/OIDC link are cleared,
// and disabled_at + deleted_at are set. Every FK to the user keeps
// resolving, so workflows/logs display under the canonical Deleted
// user identity. Guards: only OWNER deletes OWNERs, no self-delete,
// and never delete the last active OWNER/ADMIN.

export async function deleteUserAction(
  formData: FormData,
): Promise<{ error: string } | { ok: true }> {
  const me = await requireAdmin();

  const userId = z.string().uuid().safeParse(formData.get("userId"));
  if (!userId.success) return { error: "Invalid input." };
  if (userId.data === me.id) {
    return { error: "You cannot delete your own account." };
  }

  const [target] = await db
    .select({
      id: users.id,
      role: users.role,
      name: users.name,
      email: users.email,
      deletedAt: users.deletedAt,
    })
    .from(users)
    .where(eq(users.id, userId.data));
  if (!target) return { error: "User not found." };
  if (target.deletedAt) return { error: "User is already deleted." };
  if (target.role === "OWNER" && me.role !== "OWNER") {
    return { error: "Only owners can delete owner accounts." };
  }

  if (target.role === "OWNER" || target.role === "ADMIN") {
    // Count REMAINING active owner/admin accounts after this delete.
    const [remaining] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(
        and(
          sql`${users.role} IN ('OWNER','ADMIN')`,
          isNull(users.disabledAt),
          isNull(users.deletedAt),
          ne(users.id, userId.data),
        ),
      );
    if (Number(remaining?.n ?? 0) < 1) {
      return {
        error:
          "Cannot delete the last active Owner/Admin — promote another user first.",
      };
    }
  }

  await db
    .update(users)
    .set({
      name: DELETED_USER_LABEL,
      email: deletedUserTombstoneEmail(target.id),
      passwordHash: null,
      authentikSubject: null,
      mustChangePassword: false,
      disabledAt: new Date(),
      deletedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId.data));

  await writeAudit({
    actorId: me.id,
    actorRole: me.role,
    action: "user.delete",
    targetType: "User",
    targetId: userId.data,
    before: { name: target.name, email: target.email, role: target.role },
    after: { deleted: true, display: DELETED_USER_LABEL },
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
