"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { signIn } from "@/lib/auth";

const schema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
});

export async function loginAction(
  formData: FormData,
): Promise<{ error?: string } | void> {
  const parsed = schema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: "Invalid email or password." };
  }
  const result = await signIn(parsed.data.email, parsed.data.password);
  if ("error" in result) return result;
  redirect("/dashboard");
}
