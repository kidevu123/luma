import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { stations } from "@/lib/db/schema";
import { requireSupervisorSession } from "@/lib/production/engine";

export const dynamic = "force-dynamic";

/** STATION-NAV-CLEANUP-3 / P5-SUPERVISOR Task 4 — bag allocation runs
 *  from station scan, not this page. The page stays reachable so a
 *  bookmark or handoff link does not 404, but a locked station renders
 *  the supervisor-required message instead of silently redirecting: the
 *  operator sees WHY the page will not open work for them, and where
 *  the unlock lives. When a supervisor session is OPEN we still send
 *  them back to the operator screen — this route has no dedicated UI. */
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

  const session = await db.transaction((tx) =>
    requireSupervisorSession(tx, row.id),
  );
  if (!session) {
    return (
      <main className="bg-page p-4 sm:p-6 max-w-2xl mx-auto">
        <section className="rounded-2xl border border-border bg-surface p-6 text-center space-y-3">
          <h1 className="text-lg font-semibold">Supervisor unlock required</h1>
          <p className="text-sm text-text-muted">
            This is a supervisor action. Open the station page, tap More,
            then Supervisor to unlock this station for 15 minutes.
          </p>
          <a
            href={`/floor/${token}`}
            className="inline-block rounded-lg border border-border bg-surface-2 px-4 py-2 text-sm font-medium hover:bg-surface"
          >
            Back to station
          </a>
        </section>
      </main>
    );
  }

  redirect(`/floor/${token}`);
}
