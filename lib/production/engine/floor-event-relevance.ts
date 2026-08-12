// P3-SSE-2 — pure filter the SSE client uses to decide whether a
// floor_events notify ping is worth reacting to. Every station tablet
// gets the same broadcast; this narrows it to "events this station
// cares about" so a refresh isn't triggered for unrelated floor
// activity.

const QUEUE_KEYS_BY_STATION_KIND: Record<string, readonly string[]> = {
  BLISTER: [],
  HANDPACK_BLISTER: [],
  COMBINED: [],
  SEALING: ["SEALING_QUEUE"],
  // Packaging may overlap-claim at BLISTERED (STATION_PICKUP_FROM_STAGE.PACKAGING),
  // and a just-BLISTERED bag parks under the sealing queue key — mirror of
  // STATION_PICKUP_FROM_STAGE, remove when P4 drives the page from read_bag_queue.
  PACKAGING: ["SEALING_QUEUE", "PACKAGING_QUEUE"],
  BOTTLE_STICKER: ["BOTTLE_STICKER_QUEUE"],
  // Order-flex: a bag eligible for either finishing queue parks under
  // the sticker key, so cap-seal must watch both to see it arrive.
  BOTTLE_CAP_SEAL: ["BOTTLE_STICKER_QUEUE", "BOTTLE_INDUCTION_QUEUE"],
  BOTTLE_HANDPACK: [],
};

export function queueKeysForStationKind(kind: string): readonly string[] {
  return QUEUE_KEYS_BY_STATION_KIND[kind] ?? [];
}

/** An event is relevant to a station when it's the station's own
 *  event, a same-kind peer's event (affects the station's queue
 *  view), or a bag entering/leaving a queue the station claims from.
 *  Null fields never match — fail quiet, not chatty. */
export function floorEventRelevantToStation(
  ev: { stationId: string | null; stationKind: string | null; queueStageKey: string | null },
  station: { id: string; kind: string },
): boolean {
  if (ev.stationId !== null && ev.stationId === station.id) return true;
  if (ev.stationKind !== null && ev.stationKind === station.kind) return true;
  if (ev.queueStageKey !== null && queueKeysForStationKind(station.kind).includes(ev.queueStageKey)) {
    return true;
  }
  return false;
}
