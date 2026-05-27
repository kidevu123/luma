import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { stations } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

/** STATION-NAV-CLEANUP-2 — variety pack production starts from station scan. */
export default async function VarietyPackPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const [row] = await db
    .select({ id: stations.id })
    .from(stations)
    .where(eq(stations.scanToken, token));
  if (!row) notFound();
  redirect(`/floor/${token}`);
}
