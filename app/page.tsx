import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";

export default async function Home() {
  const u = await currentUser();
  if (u) redirect("/dashboard");
  redirect("/login");
}
