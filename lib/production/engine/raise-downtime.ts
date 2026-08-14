// P4b Task 4 — Report Problem's "Machine" category.
//
// Before this, DOWNTIME_STARTED existed only as a schema.ts enum value
// (added in migration 0008, "Phase A additions") — grepping the repo
// for the literal turns up nothing that ever emitted it: no floor
// action, no engine function, no ops script. This is that path.
//
// MACHINE reports get two writes: the existing pauseBagAction (called
// by the client, best-effort — see report-problem.tsx) stops the
// bag's clock the same way any other pause does, and this function
// records the machine-level fact the Act Now rail surfaces. They are
// independent: a bag that is already paused (shift break, another
// report) must not block the downtime record, so the client does not
// treat pauseBagAction's failure as fatal to this call.
//
// Same total-function contract, same bag resolution and
// wrong-bag guard as raiseProductionException — see
// emit-stationed-event.ts's header for why both are shared.
//
// P4b Task 4 fix round 1 (MED 3) — "which machine" answers itself:
// station <-> machine is 1:1 on this floor (stations.machine_id, set
// once at machine setup — see station-kind-cache.ts's comment on why
// that relationship is treated as effectively static), so the
// station this report was filed from already names the machine. No
// picker needed; the payload just carries machine_id (and the name,
// since one extra cheap join beats a second lookup for whoever reads
// this event later) alongside the operator's detail.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { machines, stations } from "@/lib/db/schema";
import { blockerFor } from "./resolve-exceptions";
import { emitStationedExceptionEvent } from "./emit-stationed-event";
import type { Blocker } from "./types";

export type RaiseDowntimeInput = {
  stationId: string;
  /** Omit to attach to whatever bag is currently pinned at this
   *  station. See RaiseProductionExceptionInput's workflowBagId doc —
   *  same NOT NULL / wrong-bag-guard contract applies here. */
  workflowBagId?: string | undefined;
  detail: string;
  clientEventId?: string | undefined;
  overrideEmployeeCode?: string | undefined;
};

export type RaiseDowntimeResult =
  | { ok: true }
  | { ok: false; blocker: Blocker };

export async function raiseDowntimeStarted(
  input: RaiseDowntimeInput,
): Promise<RaiseDowntimeResult> {
  const detail = input.detail.trim();
  if (!detail) {
    return { ok: false, blocker: blockerFor("PRODUCTION_EXCEPTION_DETAIL_REQUIRED") };
  }

  // Best-effort context, not a precondition: a station with no
  // machine_id set (or a station row emit-stationed-event.ts is about
  // to reject as unresolved anyway) still gets the detail recorded —
  // this just omits machine_id/machine_name from the payload rather
  // than failing the report. Fix round 2 (nit): the lookup itself is
  // now inside the try/catch too — a DB blip here must not make this
  // function throw, or the "total function, every failure is a
  // Blocker" contract this file's header claims stops being true.
  let machineRow: { machineId: string | null; machineName: string | null } | undefined;
  try {
    [machineRow] = await db
      .select({ machineId: stations.machineId, machineName: machines.name })
      .from(stations)
      .leftJoin(machines, eq(stations.machineId, machines.id))
      .where(eq(stations.id, input.stationId));
  } catch {
    // Swallow: machine context is best-effort. emitStationedExceptionEvent
    // below still does its own real station-existence check and will
    // surface a proper Blocker if the station itself is the problem.
    machineRow = undefined;
  }

  return emitStationedExceptionEvent({
    stationId: input.stationId,
    eventType: "DOWNTIME_STARTED",
    payload: {
      detail,
      ...(machineRow?.machineId ? { machine_id: machineRow.machineId } : {}),
      ...(machineRow?.machineName ? { machine_name: machineRow.machineName } : {}),
    },
    ...(input.workflowBagId != null ? { workflowBagId: input.workflowBagId } : {}),
    ...(input.clientEventId != null ? { clientEventId: input.clientEventId } : {}),
    ...(input.overrideEmployeeCode != null
      ? { overrideEmployeeCode: input.overrideEmployeeCode }
      : {}),
  });
}
