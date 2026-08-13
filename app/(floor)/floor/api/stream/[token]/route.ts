// SSE relay for a single floor station tablet. Mirrors
// app/api/floor-board/stream/route.ts's stream mechanics exactly, but
// authenticates via station scan-token (no office session) and filters
// the broadcast down to events relevant to this one station so a
// tablet doesn't re-render for unrelated floor activity.
//
// Why SSE and not websockets? Same rationale as the floor board relay:
// one-way fan-out, no client->server messages, runs over plain HTTP,
// survives reverse proxies, and the browser handles reconnect for us.

import { NextRequest } from "next/server";
import {
  resolveStationByToken,
  floorEventRelevantToStation,
} from "@/lib/production/engine";
import { subscribe, type FloorEvent } from "@/lib/projector/notify-bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  const station = await resolveStationByToken(token);
  if (!station || !station.isActive) {
    return new Response("Not found", { status: 404 });
  }

  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      let closed = false;

      function send(data: string, eventName?: string) {
        if (closed) return;
        const lines: string[] = [];
        if (eventName) lines.push(`event: ${eventName}`);
        for (const line of data.split("\n")) lines.push(`data: ${line}`);
        lines.push("", "");
        try {
          controller.enqueue(enc.encode(lines.join("\n")));
        } catch {
          closed = true;
        }
      }

      // Initial hello so the client knows the channel is open.
      send(JSON.stringify({ ok: true, ts: Date.now() }), "hello");

      const unsub = subscribe((ev: FloorEvent) => {
        if (!floorEventRelevantToStation(ev, { id: station.id, kind: station.kind })) return;
        send(JSON.stringify(ev), "floor");
      });

      // Heartbeat every 25s — keeps proxies from killing the
      // connection on idle and lets us detect a dead peer.
      const heartbeat = setInterval(() => {
        send(JSON.stringify({ ts: Date.now() }), "ping");
      }, 25_000);

      const abort = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsub();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      req.signal.addEventListener("abort", abort);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
