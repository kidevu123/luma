// LOT-1F — Nexus finished-lot handoff contract tests.

import { describe, expect, it } from "vitest";
import {
  buildNexusFinishedLotPayload,
  buildNexusFinishedLotPayloadsForCustomer,
  isFinishedLotSendableToNexus,
  NEXUS_FINISHED_LOT_SECRET_ENV,
  NEXUS_FINISHED_LOT_URL_ENV,
  sendFinishedLotToNexus,
  stripNexusSecret,
  validateNexusConfig,
  type NexusPayloadInput,
} from "./finished-lots";

function baseInput(over: Partial<NexusPayloadInput> = {}): NexusPayloadInput {
  return {
    finishedLotId: "fl-1",
    traceCode: "FL-2026-001",
    productName: "Mango Peach 30",
    productSku: "MP-30",
    packedAt: new Date("2026-05-10T13:00:00Z"),
    expiresAt: new Date("2027-05-10T13:00:00Z"),
    outputs: [
      {
        outputType: "MASTER_CASE",
        quantity: 12,
        unit: "each",
        traceCodePrinted: "FL-2026-001",
      },
    ],
    customer: {
      customerCode: "ACME",
      customerName: "Acme Foods",
      nexusCustomerId: "nx-acme-1",
      supplierLotVisible: false,
    },
    shipment: {
      shipmentId: "shp-1",
      shippedAt: new Date("2026-05-11T10:00:00Z"),
      trackingNumber: "FX123",
      carrier: "FedEx",
    },
    recallPassport: {
      confidence: "HIGH",
      warnings: [],
      missingLinks: [],
      qcSummary: [
        {
          eventType: "PACKAGING_DAMAGE_RETURN",
          occurredAt: new Date("2026-05-10T11:00:00Z"),
        },
      ],
      supplierLotNumber: "HN-LOT-555",
    },
    ...over,
  };
}

describe("validateNexusConfig", () => {
  it("reports both vars missing when both unset", () => {
    const s = validateNexusConfig({});
    expect(s.configured).toBe(false);
    expect(s.missing).toEqual([
      NEXUS_FINISHED_LOT_URL_ENV,
      NEXUS_FINISHED_LOT_SECRET_ENV,
    ]);
  });

  it("is configured when both vars are non-empty", () => {
    const s = validateNexusConfig({
      url: "https://nexus.example/inbox",
      secret: "shh",
    });
    expect(s.configured).toBe(true);
    expect(s.missing).toEqual([]);
  });

  it("treats whitespace-only as missing", () => {
    expect(
      validateNexusConfig({ url: "   ", secret: "shh" }).configured,
    ).toBe(false);
  });
});

describe("isFinishedLotSendableToNexus", () => {
  it("blocks every missing input with a reason", () => {
    const r = isFinishedLotSendableToNexus({
      traceCode: null,
      nexusCustomerId: null,
      shipmentLinkPresent: false,
      configured: false,
    });
    expect(r.sendable).toBe(false);
    expect(r.reasons.length).toBe(4);
  });

  it("returns sendable=true only when everything is present", () => {
    const r = isFinishedLotSendableToNexus({
      traceCode: "FL-1",
      nexusCustomerId: "nx-1",
      shipmentLinkPresent: true,
      configured: true,
    });
    expect(r.sendable).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("treats whitespace traceCode / nexusCustomerId as missing", () => {
    const r = isFinishedLotSendableToNexus({
      traceCode: "   ",
      nexusCustomerId: "   ",
      shipmentLinkPresent: true,
      configured: true,
    });
    expect(r.sendable).toBe(false);
    expect(r.reasons.length).toBe(2);
  });
});

describe("buildNexusFinishedLotPayload — happy path", () => {
  it("includes schema_version, source, every customer/shipment/finished_lot/recall_passport block", () => {
    const p = buildNexusFinishedLotPayload(baseInput());
    expect(p.schema_version).toBe("1.0");
    expect(p.source).toBe("LUMA");
    expect(p.customer.nexus_customer_id).toBe("nx-acme-1");
    expect(p.customer.customer_code).toBe("ACME");
    expect(p.finished_lot.trace_code).toBe("FL-2026-001");
    expect(p.finished_lot.outputs).toHaveLength(1);
    expect(p.shipment.shipment_id).toBe("shp-1");
    expect(p.recall_passport.confidence).toBe("HIGH");
    expect(p.recall_passport.qc_summary).toHaveLength(1);
  });

  it("populates luma_recall_url + luma_finished_lot_url when appBaseUrl is set", () => {
    const p = buildNexusFinishedLotPayload({
      ...baseInput(),
      appBaseUrl: "https://luma.example/",
    });
    expect(p.links.luma_recall_url).toBe(
      "https://luma.example/recall?kind=finished_lot_trace_code&value=FL-2026-001",
    );
    expect(p.links.luma_finished_lot_url).toBe(
      "https://luma.example/finished-lots/fl-1",
    );
  });

  it("omits luma_* links when appBaseUrl is not set", () => {
    const p = buildNexusFinishedLotPayload(baseInput());
    expect(p.links).toEqual({});
  });
});

describe("buildNexusFinishedLotPayload — customer-safe visibility", () => {
  it("supplier_lot hidden by default (no field at all)", () => {
    const p = buildNexusFinishedLotPayload(baseInput());
    expect(p.recall_passport.supplier_lot_visible).toBe(false);
    expect("supplier_lot_number" in p.recall_passport).toBe(false);
  });

  it("supplier_lot exposed only when customer.supplierLotVisible=true AND lot exists", () => {
    const p = buildNexusFinishedLotPayload(
      baseInput({
        customer: {
          customerCode: "ACME",
          customerName: "Acme Foods",
          nexusCustomerId: "nx-acme-1",
          supplierLotVisible: true,
        },
      }),
    );
    expect(p.recall_passport.supplier_lot_visible).toBe(true);
    expect(p.recall_passport.supplier_lot_number).toBe("HN-LOT-555");
  });

  it("supplier_lot omitted when customer opted in but no lot value exists", () => {
    const p = buildNexusFinishedLotPayload(
      baseInput({
        customer: {
          customerCode: "ACME",
          customerName: "Acme Foods",
          nexusCustomerId: "nx-acme-1",
          supplierLotVisible: true,
        },
        recallPassport: {
          confidence: "MEDIUM",
          warnings: [],
          missingLinks: [],
          qcSummary: [],
          supplierLotNumber: null,
        },
      }),
    );
    expect(p.recall_passport.supplier_lot_visible).toBe(true);
    expect("supplier_lot_number" in p.recall_passport).toBe(false);
  });

  it("internal_receipt_number never appears in the customer payload (schema check)", () => {
    const p = buildNexusFinishedLotPayload(baseInput());
    const j = JSON.stringify(p);
    expect(j).not.toMatch(/internal_receipt_number/);
  });

  it("warnings + missing_links + confidence are preserved", () => {
    const p = buildNexusFinishedLotPayload(
      baseInput({
        recallPassport: {
          confidence: "LOW",
          warnings: ["legacy bag QR missing"],
          missingLinks: ["no QC events recorded"],
          qcSummary: [],
          supplierLotNumber: null,
        },
      }),
    );
    expect(p.recall_passport.confidence).toBe("LOW");
    expect(p.recall_passport.warnings).toEqual(["legacy bag QR missing"]);
    expect(p.recall_passport.missing_links).toEqual([
      "no QC events recorded",
    ]);
  });
});

describe("buildNexusFinishedLotPayload — required-field guards", () => {
  it("throws when trace_code is null", () => {
    expect(() =>
      buildNexusFinishedLotPayload(baseInput({ traceCode: null })),
    ).toThrow(/trace_code/);
  });

  it("throws when nexus_customer_id is null", () => {
    expect(() =>
      buildNexusFinishedLotPayload(
        baseInput({
          customer: {
            customerCode: "ACME",
            customerName: "Acme",
            nexusCustomerId: null,
            supplierLotVisible: false,
          },
        }),
      ),
    ).toThrow(/nexus_customer_id/);
  });

  it("throws when shipment is null", () => {
    expect(() =>
      buildNexusFinishedLotPayload(baseInput({ shipment: null })),
    ).toThrow(/shipment/);
  });
});

describe("buildNexusFinishedLotPayloadsForCustomer", () => {
  it("batch-builds N payloads", () => {
    const inputs = [
      baseInput(),
      baseInput({
        finishedLotId: "fl-2",
        traceCode: "FL-2026-002",
      }),
    ];
    const ps = buildNexusFinishedLotPayloadsForCustomer(inputs);
    expect(ps).toHaveLength(2);
    expect(ps.map((p) => p.finished_lot.trace_code)).toEqual([
      "FL-2026-001",
      "FL-2026-002",
    ]);
  });
});

describe("stripNexusSecret", () => {
  it("replaces every occurrence of the secret with [REDACTED]", () => {
    expect(stripNexusSecret("oops shh oops shh", "shh")).toBe(
      "oops [REDACTED] oops [REDACTED]",
    );
  });

  it("returns input unchanged when secret is empty", () => {
    expect(stripNexusSecret("anything", "")).toBe("anything");
  });
});

describe("sendFinishedLotToNexus", () => {
  function fakePayload() {
    return buildNexusFinishedLotPayload(baseInput());
  }

  it("returns NOT_CONFIGURED when env / config missing", async () => {
    const prevUrl = process.env[NEXUS_FINISHED_LOT_URL_ENV];
    const prevSecret = process.env[NEXUS_FINISHED_LOT_SECRET_ENV];
    delete process.env[NEXUS_FINISHED_LOT_URL_ENV];
    delete process.env[NEXUS_FINISHED_LOT_SECRET_ENV];
    try {
      const r = await sendFinishedLotToNexus(fakePayload());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("NOT_CONFIGURED");
    } finally {
      if (prevUrl !== undefined)
        process.env[NEXUS_FINISHED_LOT_URL_ENV] = prevUrl;
      if (prevSecret !== undefined)
        process.env[NEXUS_FINISHED_LOT_SECRET_ENV] = prevSecret;
    }
  });

  it("POSTs JSON with secret + finished_lot_id + trace_code headers (happy path)", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: typeof fetch = (async (
      url: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({ status: "received", message: "ok" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    const r = await sendFinishedLotToNexus(fakePayload(), {
      config: { url: "https://nexus.example/inbox", secret: "shh" },
      fetchImpl,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.status).toBe(200);
      expect(r.message).toBe("ok");
    }
    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0]!.init?.headers as HeadersInit);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-luma-nexus-secret")).toBe("shh");
    expect(headers.get("x-luma-finished-lot-id")).toBe("fl-1");
    expect(headers.get("x-luma-trace-code")).toBe("FL-2026-001");
  });

  it("returns HTTP_ERROR on non-2xx with bodySnippet", async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response("nope", { status: 503 })) as unknown as typeof fetch;
    const r = await sendFinishedLotToNexus(fakePayload(), {
      config: { url: "https://x", secret: "shh" },
      fetchImpl,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("HTTP_ERROR");
      expect(r.status).toBe(503);
      expect(r.bodySnippet).toBe("nope");
    }
  });

  it("returns INVALID_RESPONSE when body is not JSON", async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response("not json", { status: 200 })) as unknown as typeof fetch;
    const r = await sendFinishedLotToNexus(fakePayload(), {
      config: { url: "https://x", secret: "shh" },
      fetchImpl,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_RESPONSE");
  });

  it("returns NETWORK_ERROR when fetch throws", async () => {
    const fetchImpl: typeof fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const r = await sendFinishedLotToNexus(fakePayload(), {
      config: { url: "https://x", secret: "shh" },
      fetchImpl,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("NETWORK_ERROR");
      expect(r.reason).toContain("connection refused");
    }
  });

  it("redacts a reflected secret from bodySnippet", async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response("error contains shh somewhere", {
        status: 401,
      })) as unknown as typeof fetch;
    const r = await sendFinishedLotToNexus(fakePayload(), {
      config: { url: "https://x", secret: "shh" },
      fetchImpl,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.bodySnippet).toBe("error contains [REDACTED] somewhere");
    }
  });
});
