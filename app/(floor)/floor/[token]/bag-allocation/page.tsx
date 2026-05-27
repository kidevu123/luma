import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { stations } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

/** STATION-NAV-CLEANUP-3 — bag allocation runs from station scan, not this page. */
export default async function BagAllocationPage({
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
