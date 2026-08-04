// SHIPMENT-INTAKE-1 — shipment records for tablet receiving. A shipment
// groups the per-flavor receives of one physical delivery. Legacy receives
// (shipment_id null) are untouched; the UI shows them as "Earlier receives".

import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { shipments } from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import type { CurrentUser } from "@/lib/auth";

export type PoShipmentOption = {
  id: string;
  carrier: string | null;
  trackingNumber: string | null;
  receiveCount: number;
  firstReceivedAt: Date | null;
  label: string;
};

export async function listShipmentsForPo(poId: string): Promise<PoShipmentOption[]> {
  const rows = await db
    .select({
      id: shipments.id,
      carrier: shipments.carrier,
      trackingNumber: shipments.trackingNumber,
      receiveCount: sql<number>`(
        SELECT COUNT(*)::int FROM receives r WHERE r.shipment_id = ${shipments.id}
      )`,
      firstReceivedAt: sql<Date | null>`(
        SELECT MIN(r.received_at) FROM receives r WHERE r.shipment_id = ${shipments.id}
      )`,
    })
    .from(shipments)
    .where(eq(shipments.poId, poId))
    .orderBy(asc(sql`(SELECT MIN(r.received_at) FROM receives r WHERE r.shipment_id = ${shipments.id})`), asc(shipments.id));

  return rows.map((r, i) => ({
    ...r,
    firstReceivedAt: r.firstReceivedAt ? new Date(r.firstReceivedAt) : null,
    label: buildShipmentLabel({ index: i, carrier: r.carrier, trackingNumber: r.trackingNumber, receiveCount: r.receiveCount }),
  }));
}

/** Pure; exported for tests. "Shipment 2 — FedEx 771234 (3 receives)". */
export function buildShipmentLabel(args: {
  index: number;
  carrier: string | null;
  trackingNumber: string | null;
  receiveCount: number;
}): string {
  const base = `Shipment ${args.index + 1}`;
  const meta = [args.carrier, args.trackingNumber].filter(Boolean).join(" ");
  const receives = `${args.receiveCount} ${args.receiveCount === 1 ? "receive" : "receives"}`;
  return meta ? `${base} — ${meta} (${receives})` : `${base} (${receives})`;
}

export async function createShipmentForPo(
  args: { poId: string; carrier?: string | null; trackingNumber?: string | null },
  actor: CurrentUser,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(shipments)
    .values({
      poId: args.poId,
      carrier: args.carrier?.trim() || null,
      trackingNumber: args.trackingNumber?.trim() || null,
    })
    .returning({ id: shipments.id });
  if (!row) throw new Error("createShipmentForPo: insert empty");
  await writeAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: "shipment.create",
    targetType: "Shipment",
    targetId: row.id,
    after: { po_id: args.poId, carrier: args.carrier ?? null, tracking_number: args.trackingNumber ?? null },
  });
  return row;
}
