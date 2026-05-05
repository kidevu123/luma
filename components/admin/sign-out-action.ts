"use server";

import { redirect } from "next/navigation";
import { signOut } from "@/lib/auth";

export async function signOutAction(): Promise<void> {
  await signOut();
  redirect("/login");
}
