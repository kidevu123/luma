// LOT-1F — Luma → Nexus / QIP finished-lot handoff contract.
//
// Contract + client only — no DB persistence in this phase. The
// admin action (sendFinishedLotToNexusAction) loads context, gates
// every payload, and posts to Nexus when configured; persistence of
// sent_at / last_sent_response / last_send_error belongs to LOT-1G
// after we decide what fields to track on shipment_finished_lots.
//
// Boundary (per LOT-1A §5):
//   - Luma owns trace code, raw-bag linkage, packaging-lot linkage,
//     QC events, customer-safe visibility rules.
//   - Nexus owns customer-facing complaint workflow, batch dropdown
//     UX, ticketing, customer comms.
//
// Strict invariants:
//   - schema_version = "1.0".
//   - supplier_lot is hidden unless customers.supplier_lot_visible = true.
//   - internal_receipt_number is NEVER on a customer-bound payload.
//   - trace_code is required; nexus_customer_id is required; shipment
//     link is required. Missing any of them → NOT_SENDABLE.
//   - The secret never appears in any logged / returned text.

import { shouldExposeSupplierLotForCustomer } from "@/lib/production/finished-lot-labels";

// ─── Env / config ────────────────────────────────────────────────────

export const NEXUS_FINISHED_LOT_URL_ENV = "NEXUS_FINISHED_LOT_URL";
export const NEXUS_FINISHED_LOT_SECRET_ENV = "NEXUS_FINISHED_LOT_SECRET";

export type NexusConfigStatus = {
  configured: boolean;
  endpointConfigured: boolean;
  secretConfigured: boolean;
  missing: string[];
};

export function validateNexusConfig(
  env: { url?: string | undefined; secret?: string | undefined } = {
    ...(process.env[NEXUS_FINISHED_LOT_URL_ENV] != null
      ? { url: process.env[NEXUS_FINISHED_LOT_URL_ENV] }
      : {}),
    ...(process.env[NEXUS_FINISHED_LOT_SECRET_ENV] != null
      ? { secret: process.env[NEXUS_FINISHED_LOT_SECRET_ENV] }
      : {}),
  },
): NexusConfigStatus {
  const endpointConfigured =
    typeof env.url === "string" && env.url.trim().length > 0;
  const secretConfigured =
    typeof env.secret === "string" && env.secret.trim().length > 0;
  const missing: string[] = [];
  if (!endpointConfigured) missing.push(NEXUS_FINISHED_LOT_URL_ENV);
  if (!secretConfigured) missing.push(NEXUS_FINISHED_LOT_SECRET_ENV);
  return {
    configured: endpointConfigured && secretConfigured,
    endpointConfigured,
    secretConfigured,
    missing,
  };
}

// ─── Payload contract ────────────────────────────────────────────────

export type NexusFinishedLotPayload = {
  schema_version: "1.0";
  source: "LUMA";
  customer: {
    customer_code: string;
    customer_name: string;
    nexus_customer_id: string;
  };
  finished_lot: {
    finished_lot_id: string;
    trace_code: string;
    product_name: string | null;
    product_sku: string | null;
    packed_at: string | null;
    expires_at: string | null;
    outputs: Array<{
      output_type: string;
      quantity: number;
      unit: string;
      trace_code_printed: string | null;
    }>;
  };
  shipment: {
    shipment_id: string;
    shipped_at: string | null;
    tracking_number: string | null;
    carrier: string | null;
  };
  recall_passport: {
    confidence: string;
    warnings: string[];
    missing_links: string[];
    qc_summary: Array<{
      event_type: string;
      occurred_at: string;
    }>;
    supplier_lot_visible: boolean;
    /** Present only when `supplier_lot_visible = true` AND a supplier
     *  lot exists. Omitted otherwise — never set to null when hidden. */
    supplier_lot_number?: string;
  };
  links: {
    luma_recall_url?: string;
    luma_finished_lot_url?: string;
  };
};

export type NexusPayloadInput = {
  finishedLotId: string;
  traceCode: string | null;
  productName: string | null;
  productSku: string | null;
  packedAt: Date | string | null;
  expiresAt: Date | string | null;
  outputs: Array<{
    outputType: string;
    quantity: number;
    unit: string;
    traceCodePrinted: string | null;
  }>;

  customer: {
    customerCode: string;
    customerName: string;
    nexusCustomerId: string | null;
    supplierLotVisible: boolean | null;
  };

  shipment: {
    shipmentId: string;
    shippedAt: Date | string | null;
    trackingNumber: string | null;
    carrier: string | null;
  } | null;

  recallPassport: {
    confidence: string;
    warnings: string[];
    missingLinks: string[];
    qcSummary: Array<{ eventType: string; occurredAt: Date | string }>;
    supplierLotNumber: string | null;
  };

  appBaseUrl?: string | null;
};

function toIsoZ(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** Build a customer-safe Nexus payload. Throws when required fields
 *  are missing — callers should pre-flight with isFinishedLotSendableToNexus. */
export function buildNexusFinishedLotPayload(
  input: NexusPayloadInput,
): NexusFinishedLotPayload {
  if (!input.traceCode || input.traceCode.trim().length === 0) {
    throw new Error("trace_code is required");
  }
  if (
    !input.customer.nexusCustomerId ||
    input.customer.nexusCustomerId.trim().length === 0
  ) {
    throw new Error("nexus_customer_id is required");
  }
  if (!input.shipment) {
    throw new Error("shipment is required for a Nexus customer dropdown");
  }

  const exposeSupplier = shouldExposeSupplierLotForCustomer({
    customerSupplierLotVisible: input.customer.supplierLotVisible ?? null,
  });

  const passport: NexusFinishedLotPayload["recall_passport"] = {
    confidence: input.recallPassport.confidence,
    warnings: input.recallPassport.warnings,
    missing_links: input.recallPassport.missingLinks,
    qc_summary: input.recallPassport.qcSummary.map((q) => ({
      event_type: q.eventType,
      occurred_at:
        typeof q.occurredAt === "string"
          ? q.occurredAt
          : (toIsoZ(q.occurredAt) ?? ""),
    })),
    supplier_lot_visible: exposeSupplier,
  };
  // Only embed supplier_lot when both visibility AND value exist.
  if (exposeSupplier && input.recallPassport.supplierLotNumber) {
    passport.supplier_lot_number = input.recallPassport.supplierLotNumber;
  }

  const links: NexusFinishedLotPayload["links"] = {};
  if (input.appBaseUrl && input.appBaseUrl.trim().length > 0) {
    const base = input.appBaseUrl.replace(/\/+$/, "");
    links.luma_recall_url = `${base}/recall?kind=finished_lot_trace_code&value=${encodeURIComponent(
      input.traceCode,
    )}`;
    links.luma_finished_lot_url = `${base}/finished-lots/${input.finishedLotId}`;
  }

  return {
    schema_version: "1.0",
    source: "LUMA",
    customer: {
      customer_code: input.customer.customerCode,
      customer_name: input.customer.customerName,
      nexus_customer_id: input.customer.nexusCustomerId,
    },
    finished_lot: {
      finished_lot_id: input.finishedLotId,
      trace_code: input.traceCode,
      product_name: input.productName,
      product_sku: input.productSku,
      packed_at: toIsoZ(input.packedAt),
      expires_at: toIsoZ(input.expiresAt),
      outputs: input.outputs.map((o) => ({
        output_type: o.outputType,
        quantity: o.quantity,
        unit: o.unit,
        trace_code_printed: o.traceCodePrinted,
      })),
    },
    shipment: {
      shipment_id: input.shipment.shipmentId,
      shipped_at: toIsoZ(input.shipment.shippedAt),
      tracking_number: input.shipment.trackingNumber,
      carrier: input.shipment.carrier,
    },
    recall_passport: passport,
    links,
  };
}

/** Batch helper — one input set may produce N payloads, one per
 *  shipment that customer received. */
export function buildNexusFinishedLotPayloadsForCustomer(
  inputs: NexusPayloadInput[],
): NexusFinishedLotPayload[] {
  return inputs.map(buildNexusFinishedLotPayload);
}

// ─── Sendability gate ─────────────────────────────────────────────────

export type SendabilityCheck = {
  sendable: boolean;
  reasons: string[];
};

export function isFinishedLotSendableToNexus(args: {
  traceCode: string | null | undefined;
  nexusCustomerId: string | null | undefined;
  shipmentLinkPresent: boolean;
  configured: boolean;
}): SendabilityCheck {
  const reasons: string[] = [];
  if (!args.traceCode || args.traceCode.trim().length === 0) {
    reasons.push("trace_code missing");
  }
  if (
    !args.nexusCustomerId ||
    args.nexusCustomerId.trim().length === 0
  ) {
    reasons.push("nexus_customer_id missing on customer");
  }
  if (!args.shipmentLinkPresent) {
    reasons.push("no shipment / customer linkage recorded");
  }
  if (!args.configured) {
    reasons.push("Nexus handoff not configured");
  }
  return { sendable: reasons.length === 0, reasons };
}

// ─── Send ─────────────────────────────────────────────────────────────

export type NexusSendResult =
  | {
      ok: true;
      status: number;
      sentAt: string;
      rawBody: unknown;
      message: string | null;
    }
  | {
      ok: false;
      reason: string;
      code:
        | "NOT_CONFIGURED"
        | "NOT_SENDABLE"
        | "HTTP_ERROR"
        | "NETWORK_ERROR"
        | "INVALID_RESPONSE";
      status?: number;
      bodySnippet?: string;
    };

type FetchLike = typeof fetch;

/** Defensive redaction — strip the secret out of any reflected
 *  response body before surfacing it to operators. */
export function stripNexusSecret(s: string, secret: string): string {
  if (!secret) return s;
  return s.split(secret).join("[REDACTED]");
}

export async function sendFinishedLotToNexus(
  payload: NexusFinishedLotPayload,
  opts: {
    config?: { url: string; secret: string };
    fetchImpl?: FetchLike;
    timeoutMs?: number;
  } = {},
): Promise<NexusSendResult> {
  const status = opts.config
    ? {
        configured: true,
        endpointConfigured: true,
        secretConfigured: true,
        missing: [] as string[],
      }
    : validateNexusConfig();
  if (!status.configured) {
    return {
      ok: false,
      code: "NOT_CONFIGURED",
      reason: `Nexus handoff not configured: missing ${status.missing.join(", ")}.`,
    };
  }
  const url = opts.config
    ? opts.config.url
    : (process.env[NEXUS_FINISHED_LOT_URL_ENV] ?? "");
  const secret = opts.config
    ? opts.config.secret
    : (process.env[NEXUS_FINISHED_LOT_SECRET_ENV] ?? "");

  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? 10_000,
  );

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-luma-nexus-secret": secret,
        "x-luma-finished-lot-id": payload.finished_lot.finished_lot_id,
        "x-luma-trace-code": payload.finished_lot.trace_code,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    const message = err instanceof Error ? err.message : "Unknown network error";
    return {
      ok: false,
      code: "NETWORK_ERROR",
      reason: `Network error contacting Nexus: ${stripNexusSecret(message, secret)}`,
    };
  }
  clearTimeout(timeout);

  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    /* ignore */
  }
  const bodySnippet = stripNexusSecret(bodyText.slice(0, 500), secret);

  if (!response.ok) {
    return {
      ok: false,
      code: "HTTP_ERROR",
      status: response.status,
      bodySnippet,
      reason: `Nexus responded HTTP ${response.status}.`,
    };
  }

  let parsed: unknown = null;
  if (bodyText.length > 0) {
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return {
        ok: false,
        code: "INVALID_RESPONSE",
        status: response.status,
        bodySnippet,
        reason: "Nexus response was not valid JSON. Treating as failure.",
      };
    }
  }

  let message: string | null = null;
  if (parsed && typeof parsed === "object" && parsed !== null) {
    const p = parsed as Record<string, unknown>;
    if (typeof p.message === "string") message = p.message;
  }

  return {
    ok: true,
    status: response.status,
    sentAt: new Date().toISOString(),
    rawBody: parsed,
    message,
  };
}
