"use server";

// LOT-1F — admin server action that POSTs a finished-lot handoff to
// Nexus. Contract-only this phase: the action returns the outbound
// result for the operator to inspect but does NOT persist sent_at /
// last_sent_response / last_send_error on shipment_finished_lots.
// LOT-1G picks up persistence after deciding which fields to add.

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-guards";
import {
  customers,
  finishedLotOutputs,
  finishedLotQcEvents,
  finishedLotRawBags,
  finishedLots,
  inventoryBags,
  batches,
  products,
  shipmentFinishedLots,
  shipments,
} from "@/lib/db/schema";
import {
  buildNexusFinishedLotPayload,
  isFinishedLotSendableToNexus,
  sendFinishedLotToNexus,
  validateNexusConfig,
} from "@/lib/integrations/nexus/finished-lots";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ActionResult =
  | {
      ok: true;
      status: number;
      message: string | null;
      sentAt: string;
    }
  | { ok: false; error: string; code?: string };

export async function sendFinishedLotToNexusAction(
  formData: FormData,
): Promise<ActionResult> {
  await requireAdmin();
  const finishedLotId = z
    .string()
    .regex(UUID_RE)
    .safeParse(formData.get("finishedLotId"));
  if (!finishedLotId.success) {
    return { ok: false, error: "Invalid finishedLotId" };
  }

  // ── Config gate (fast path) ──────────────────────────────────
  const config = validateNexusConfig();
  if (!config.configured) {
    return {
      ok: false,
      error: `Nexus handoff not configured: missing ${config.missing.join(", ")}.`,
      code: "NOT_CONFIGURED",
    };
  }

  // ── Load finished lot + customer + shipment context ──────────
  const [lot] = await db
    .select({
      id: finishedLots.id,
      finishedLotNumber: finishedLots.finishedLotNumber,
      traceCode: finishedLots.traceCode,
      packedAt: finishedLots.packedAt,
      expiresAt: finishedLots.expiresAt,
      productName: products.name,
      productSku: products.sku,
    })
    .from(finishedLots)
    .leftJoin(products, eq(finishedLots.productId, products.id))
    .where(eq(finishedLots.id, finishedLotId.data));
  if (!lot) return { ok: false, error: "Finished lot not found" };

  // First shipment_finished_lots link for this lot. If multiple
  // exist, LOT-1G will add a multi-shipment fan-out; for now we
  // surface the first link.
  const [shipmentLink] = await db
    .select({
      shipmentFinishedLotId: shipmentFinishedLots.id,
      shipmentId: shipmentFinishedLots.shipmentId,
      customerId: shipmentFinishedLots.customerId,
      quantity: shipmentFinishedLots.quantity,
      unit: shipmentFinishedLots.unit,
      shippedAtLink: shipmentFinishedLots.shippedAt,
      carrier: shipments.carrier,
      trackingNumber: shipments.trackingNumber,
      shippedAt: shipments.shippedAt,
    })
    .from(shipmentFinishedLots)
    .leftJoin(shipments, eq(shipmentFinishedLots.shipmentId, shipments.id))
    .where(eq(shipmentFinishedLots.finishedLotId, finishedLotId.data));
  let customerRow:
    | {
        customerCode: string;
        customerName: string;
        nexusCustomerId: string | null;
        supplierLotVisible: boolean;
      }
    | null = null;
  if (shipmentLink?.customerId) {
    const [c] = await db
      .select({
        customerCode: customers.customerCode,
        customerName: customers.name,
        nexusCustomerId: customers.nexusCustomerId,
        supplierLotVisible: customers.supplierLotVisible,
      })
      .from(customers)
      .where(eq(customers.id, shipmentLink.customerId));
    customerRow = c ?? null;
  }

  // ── Sendability gate ─────────────────────────────────────────
  const check = isFinishedLotSendableToNexus({
    traceCode: lot.traceCode,
    nexusCustomerId: customerRow?.nexusCustomerId,
    shipmentLinkPresent: !!shipmentLink,
    configured: true,
  });
  if (!check.sendable) {
    return {
      ok: false,
      code: "NOT_SENDABLE",
      error: `Not sendable: ${check.reasons.join("; ")}.`,
    };
  }
  if (!shipmentLink) {
    // Belt-and-braces — gate already covered this but the type
    // narrowing for the payload builder needs it.
    return { ok: false, error: "shipment link missing", code: "NOT_SENDABLE" };
  }
  if (!customerRow) {
    return { ok: false, error: "customer missing", code: "NOT_SENDABLE" };
  }

  // ── Outputs + QC summary (small lookups) ─────────────────────
  const outputs = await db
    .select({
      outputType: finishedLotOutputs.outputType,
      quantity: finishedLotOutputs.quantity,
      unit: finishedLotOutputs.unit,
      traceCodePrinted: finishedLotOutputs.traceCodePrinted,
    })
    .from(finishedLotOutputs)
    .where(eq(finishedLotOutputs.finishedLotId, finishedLotId.data));
  const qcEvents = await db
    .select({
      eventType: finishedLotQcEvents.eventType,
      occurredAt: finishedLotQcEvents.occurredAt,
    })
    .from(finishedLotQcEvents)
    .where(eq(finishedLotQcEvents.finishedLotId, finishedLotId.data));

  // Representative supplier lot (one customer-visible lot is enough;
  // multi-bag lots can disclose more under LOT-1G if needed). Pulled
  // only for the payload builder's exposure decision.
  const [supplierLotRow] = await db
    .select({ supplierLotNumber: batches.vendorLotNumber })
    .from(finishedLotRawBags)
    .leftJoin(
      inventoryBags,
      eq(finishedLotRawBags.inventoryBagId, inventoryBags.id),
    )
    .leftJoin(batches, eq(inventoryBags.batchId, batches.id))
    .where(
      and(
        eq(finishedLotRawBags.finishedLotId, finishedLotId.data),
      ),
    );

  // ── Build + send ─────────────────────────────────────────────
  let payload;
  try {
    payload = buildNexusFinishedLotPayload({
      finishedLotId: lot.id,
      traceCode: lot.traceCode,
      productName: lot.productName,
      productSku: lot.productSku,
      packedAt: lot.packedAt,
      expiresAt: lot.expiresAt,
      outputs: outputs.map((o) => ({
        outputType: o.outputType,
        quantity: o.quantity,
        unit: o.unit,
        traceCodePrinted: o.traceCodePrinted,
      })),
      customer: {
        customerCode: customerRow.customerCode,
        customerName: customerRow.customerName,
        nexusCustomerId: customerRow.nexusCustomerId,
        supplierLotVisible: customerRow.supplierLotVisible,
      },
      shipment: {
        shipmentId: shipmentLink.shipmentId,
        shippedAt: shipmentLink.shippedAt ?? shipmentLink.shippedAtLink,
        trackingNumber: shipmentLink.trackingNumber,
        carrier: shipmentLink.carrier,
      },
      recallPassport: {
        confidence: "MEDIUM",
        warnings: [],
        missingLinks: [],
        qcSummary: qcEvents.map((q) => ({
          eventType: q.eventType,
          occurredAt: q.occurredAt,
        })),
        supplierLotNumber: supplierLotRow?.supplierLotNumber ?? null,
      },
      ...(process.env.APP_URL ? { appBaseUrl: process.env.APP_URL } : {}),
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to build payload",
      code: "NOT_SENDABLE",
    };
  }

  const result = await sendFinishedLotToNexus(payload);
  if (!result.ok) {
    return { ok: false, error: result.reason, code: result.code };
  }
  return {
    ok: true,
    status: result.status,
    message: result.message,
    sentAt: result.sentAt,
  };
}
