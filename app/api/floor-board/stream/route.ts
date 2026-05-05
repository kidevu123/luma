// SSE relay for the live floor board. Streams a tiny JSON envelope
// every time a workflow_event is committed (via pg_notify). The
// client uses each ping as a "now is a good time to refetch" signal
// and re-runs the read-model queries it cares about.
//
// Why SSE and not websockets? One-way fan-out, no client→server
// messages, runs over plain HTTP, survives reverse proxies, and the
// browser handles reconnect for us. Websockets would buy us nothing.
//
// Why don't we send the full bag/station rows? The notify payload is
// 8KB-capped and the read-model queries are already cheap. Pushing a
// "something changed for bag X" ping and letting the client re-read
// is simpler than maintaining a per-client query cache here.

import { NextRequest } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { subscribe, type FloorEvent } from "@/lib/projector/notify-bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  await requireSession();

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
