"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { signIn } from "@/lib/auth";
import { safeNextPath } from "@/lib/auth/safe-next-path";

const schema = z.object({
  // Accept anything with an "@" — Zod's `.email()` rejects single-
  // segment hosts like "admin@luma" which seeded users were using.
  email: z.string().min(3, "Enter your email").max(254, "Email is too long").regex(/^.+@.+$/, "Email must contain @"),
  password: z.string().min(1, "Enter your password").max(200, "Password is too long"),
  next: z.string().optional(),
});

export async function loginAction(
  formData: FormData,
): Promise<{ error?: string } | void> {
  const parsed = schema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    next: formData.get("next"),
  });
  if (!parsed.success) {
    // Surface the actual validator complaint so misleading "invalid
    // password" never hides a missing-@ or empty-field issue.
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const next = safeNextPath(parsed.data.next);
  const result = await signIn(parsed.data.email, parsed.data.password);
  if ("error" in result) return result;
  redirect(next);
}
