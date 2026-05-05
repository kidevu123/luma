// In-process notify bus.
//
// One pg LISTEN connection per Node process. Every workflow_event
// pg_notify lands here, and we fan it out to whatever HTTP handlers
// have subscribed (currently the SSE relay at /api/floor-board/stream).
//
// Why one connection? Each LISTEN ties up a postgres backend
// process. Doing it once at module load is cheap; doing it per
// request would 10× our pg connection count under any kind of load.

import postgres from "postgres";

export type FloorEvent = {
  eventType: string;
  workflowBagId: string;
  stationId: string | null;
  occurredAt: string;
};

type Subscriber = (ev: FloorEvent) => void;

let subscribers = new Set<Subscriber>();
let listenerSql: ReturnType<typeof postgres> | null = null;
let listenerStarted = false;

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  ensureListener();
  return () => {
    subscribers.delete(fn);
  };
}

function ensureListener() {
  if (listenerStarted) return;
  listenerStarted = true;

  const url = process.env.DATABASE_URL ?? "postgres://luma:luma@localhost:5432/luma";
  // postgres-js's listen() opens a dedicated connection. We keep it
  // open for the life of the process; on connection drop the driver
  // auto-reconnects and we re-subscribe via onnotify.
  listenerSql = postgres(url, { max: 1, idle_timeout: 0 });

  void listenerSql
    .listen(
      "luma_floor",
      (payload: string) => {
        try {
          const parsed = JSON.parse(payload) as FloorEvent;
          for (const sub of subscribers) {
            try {
              sub(parsed);
            } catch (err) {
              console.error("[notify-bus] subscriber threw", err);
            }
          }
        } catch (err) {
          console.error("[notify-bus] bad payload", err);
        }
      },
      () => {
        // onlisten — fires on initial subscribe and on every reconnect.
        console.log("[notify-bus] LISTEN luma_floor active");
      },
    )
    .catch((err) => {
      console.error("[notify-bus] listen failed; will retry", err);
      listenerStarted = false;
      setTimeout(ensureListener, 5000);
    });
}
