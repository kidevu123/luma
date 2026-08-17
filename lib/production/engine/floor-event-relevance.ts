// P3-SSE-2 / P6-TASK-3 — pure filter the SSE client uses to decide
// whether a floor_events notify ping is worth reacting to. Every station
// tablet gets the same broadcast; this narrows it to "events this
// station cares about" so a refresh isn't triggered for unrelated floor
// activity.
//
// Phase 6 Task 3: the QUEUE_KEYS_BY_STATION_KIND table that used to live
// here is gone. The watched-queue set now derives from the data-driven
// RouteGraph (see queueKeysForStationKindFromGraph in route-data.ts).
// The SSE route loads the graph once at connect and threads it through.

import {
  queueKeysForStationKindFromGraph,
  type RouteGraph,
} from "@/lib/production/engine/route-data";

/** Queue stage keys this station kind claims from, across all routes.
 *  Graph-backed. Includes overlap-parking (e.g. PACKAGING watches
 *  SEALING_QUEUE on CARD_BLISTER, because a just-BLISTERED bag parks
 *  there and PACKAGING can overlap-claim from BLISTERED) and order-
 *  independent group asymmetry (BOTTLE_CAP_SEAL watches
 *  BOTTLE_STICKER_QUEUE, the canonical group entry, in addition to its
 *  own BOTTLE_INDUCTION_QUEUE). */
export function queueKeysForStationKind(
  graph: RouteGraph,
  kind: string,
): readonly string[] {
  return queueKeysForStationKindFromGraph(graph, kind);
}

/** An event is relevant to a station when it's the station's own
 *  event, a same-kind peer's event (affects the station's queue
 *  view), or a bag entering/leaving a queue the station claims from.
 *  Null fields never match — fail quiet, not chatty. */
export function floorEventRelevantToStation(
  graph: RouteGraph,
  ev: { stationId: string | null; stationKind: string | null; queueStageKey: string | null },
  station: { id: string; kind: string },
): boolean {
  if (ev.stationId !== null && ev.stationId === station.id) return true;
  if (ev.stationKind !== null && ev.stationKind === station.kind) return true;
  if (
    ev.queueStageKey !== null &&
    queueKeysForStationKind(graph, station.kind).includes(ev.queueStageKey)
  ) {
    return true;
  }
  return false;
}
