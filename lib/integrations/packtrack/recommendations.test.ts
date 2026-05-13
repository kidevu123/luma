// PT-7E — pure tests for the outbound PackTrack recommendation client.
//
// No DB, no real network — the client takes its config + fetchImpl via
// options so the test owns both. Coverage:
//   - validatePackTrackRecommendationConfig() reflects env presence
//   - buildPackTrackRecommendationPayload() maps every field
//   - mapPackTrackRecommendationResponse() handles known + unknown shapes
//   - sendRecommendationToPackTrack() refuses MISSING confidence
//   - sendRecommendationToPackTrack() refuses qty <= 0
//   - sendRecommendationToPackTrack() returns NOT_CONFIGURED when env missing
//   - sendRecommendationToPackTrack() posts JSON, sets headers, returns mapped result
//   - recommendation_id is used as the idempotency header
//   - HTTP error returns HTTP_ERROR with status + bodySnippet
//   - the secret never appears in error / body output
//   - non-JSON 200 response returns INVALID_RESPONSE

import { describe, expect, it } from "vitest";
import {
  buildPackTrackRecommendationPayload,
  mapPackTrackRecommendationResponse,
  PACKTRACK_RECOMMENDATION_SECRET_ENV,
  PACKTRACK_RECOMMENDATION_URL_ENV,
  sendRecommendationToPackTrack,
  validatePackTrackRecommendationConfig,
  type RecommendationPayloadInput,
} from "./recommendations";

function fixture(
  over: Partial<RecommendationPayloadInput> = {},
): RecommendationPayloadInput {
  return {
    recommendationId: "rec-1",
    materialCode: "LBL-001",
    materialName: "Bottle Label 30mL",
    productSku: "VIT-30",
    productName: "Vitamin C 30ct",
    compatibilityRole: "BOTTLE_LABEL",
    currentOnHand: 0,
    acceptedInventory: 0,
    projectedDemand: 350,
    projectedShortageQuantity: 350,
    recommendedOrderQuantity: 420,
    neededByDate: "2026-05-20",
    confidence: "HIGH",
    severity: "CRITICAL",
    reason: "Bottle Label runs out 2026-05-13",
    sourceSignals: [
      {
        kind: "CURRENT_ON_HAND",
        label: "On-hand",
        value: 0,
        confidence: "HIGH",
      },
    ],
    recommendedSupplierHint: "Acme Labels",
    generatedAt: new Date("2026-05-13T10:00:00Z"),
    ...over,
  };
}

describe("validatePackTrackRecommendationConfig", () => {
  it("reports both vars missing when both unset", () => {
    const s = validatePackTrackRecommendationConfig({});
    expect(s.configured).toBe(false);
    expect(s.endpointConfigured).toBe(false);
    expect(s.secretConfigured).toBe(false);
    expect(s.missing).toEqual([
      PACKTRACK_RECOMMENDATION_URL_ENV,
      PACKTRACK_RECOMMENDATION_SECRET_ENV,
    ]);
  });

  it("reports only secret missing when URL set without secret", () => {
    const s = validatePackTrackRecommendationConfig({
      url: "https://packtrack.example/recs",
    });
    expect(s.configured).toBe(false);
    expect(s.endpointConfigured).toBe(true);
    expect(s.secretConfigured).toBe(false);
    expect(s.missing).toEqual([PACKTRACK_RECOMMENDATION_SECRET_ENV]);
  });

  it("is configured when both env vars are set and non-empty", () => {
    const s = validatePackTrackRecommendationConfig({
      url: "https://packtrack.example/recs",
      secret: "shh",
    });
    expect(s.configured).toBe(true);
    expect(s.missing).toEqual([]);
  });

  it("treats whitespace-only env vars as missing", () => {
    const s = validatePackTrackRecommendationConfig({
      url: "   ",
      secret: "shh",
    });
    expect(s.configured).toBe(false);
    expect(s.endpointConfigured).toBe(false);
  });
});

describe("buildPackTrackRecommendationPayload", () => {
  it("maps every row field into the wire shape", () => {
    const row = fixture();
    const p = buildPackTrackRecommendationPayload(row);
    expect(p.schema_version).toBe("1.0");
    expect(p.source).toBe("LUMA");
    expect(p.recommendation_id).toBe(row.recommendationId);
    expect(p.material_code).toBe(row.materialCode);
    expect(p.material_name).toBe(row.materialName);
    expect(p.product_code).toBe(row.productSku);
    expect(p.product_name).toBe(row.productName);
    expect(p.compatibility_role).toBe(row.compatibilityRole);
    expect(p.current_on_hand).toBe(0);
    expect(p.accepted_inventory).toBe(0);
    expect(p.projected_demand).toBe(350);
    expect(p.projected_shortage_quantity).toBe(350);
    expect(p.recommended_order_quantity).toBe(420);
    expect(p.needed_by_date).toBe("2026-05-20");
    expect(p.confidence).toBe("HIGH");
    expect(p.severity).toBe("CRITICAL");
    expect(p.reason).toBe(row.reason);
    expect(p.supporting_signals).toEqual(row.sourceSignals);
    expect(p.recommended_supplier_hint).toBe("Acme Labels");
    expect(p.generated_at).toBe("2026-05-13T10:00:00.000Z");
    expect(p.luma_links).toEqual({});
  });

  it("populates luma_links.material_alerts when appBaseUrl is set", () => {
    const p = buildPackTrackRecommendationPayload(fixture(), {
      appBaseUrl: "https://luma.example/",
    });
    expect(p.luma_links.material_alerts).toBe(
      "https://luma.example/material-alerts",
    );
  });
});

describe("mapPackTrackRecommendationResponse", () => {
  it("extracts known fields and preserves the raw body", () => {
    const m = mapPackTrackRecommendationResponse({
      id: "pt-rec-1",
      status: "queued",
      message: "thanks",
      extra: "kept under raw",
    });
    expect(m.packtrack_recommendation_id).toBe("pt-rec-1");
    expect(m.status).toBe("queued");
    expect(m.message).toBe("thanks");
    expect(m.raw).toEqual({
      id: "pt-rec-1",
      status: "queued",
      message: "thanks",
      extra: "kept under raw",
    });
  });

  it("prefers recommendation_id over id when both present", () => {
    const m = mapPackTrackRecommendationResponse({
      recommendation_id: "pt-rec-2",
      id: "should-be-ignored",
    });
    expect(m.packtrack_recommendation_id).toBe("pt-rec-2");
  });

  it("returns { raw: body } for null / non-object", () => {
    expect(mapPackTrackRecommendationResponse(null).raw).toBeNull();
    expect(mapPackTrackRecommendationResponse(42).raw).toBe(42);
  });
});

describe("sendRecommendationToPackTrack — pre-flight gates", () => {
  it("refuses MISSING confidence rows even when called directly", async () => {
    const r = await sendRecommendationToPackTrack(
      fixture({ confidence: "MISSING" }),
      { config: { url: "https://x", secret: "y" } },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("BLOCKED_BY_CONFIDENCE");
  });

  it("refuses recommended_order_quantity <= 0", async () => {
    const r = await sendRecommendationToPackTrack(
      fixture({ recommendedOrderQuantity: 0 }),
      { config: { url: "https://x", secret: "y" } },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("BLOCKED_BY_QUANTITY");
  });

  it("returns NOT_CONFIGURED when no config is supplied and env is empty", async () => {
    const savedUrl = process.env[PACKTRACK_RECOMMENDATION_URL_ENV];
    const savedSecret = process.env[PACKTRACK_RECOMMENDATION_SECRET_ENV];
    delete process.env[PACKTRACK_RECOMMENDATION_URL_ENV];
    delete process.env[PACKTRACK_RECOMMENDATION_SECRET_ENV];
    try {
      const r = await sendRecommendationToPackTrack(fixture());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("NOT_CONFIGURED");
    } finally {
      if (savedUrl !== undefined)
        process.env[PACKTRACK_RECOMMENDATION_URL_ENV] = savedUrl;
      if (savedSecret !== undefined)
        process.env[PACKTRACK_RECOMMENDATION_SECRET_ENV] = savedSecret;
    }
  });
});

describe("sendRecommendationToPackTrack — happy path", () => {
  it("POSTs the payload with secret + idempotency headers and parses the response", async () => {
    const calls: Array<{
      url: string;
      init: RequestInit | undefined;
    }> = [];
    const fetchImpl: typeof fetch = (async (
      url: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({ recommendation_id: "pt-1", status: "queued" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    const r = await sendRecommendationToPackTrack(fixture(), {
      config: {
        url: "https://packtrack.example/recs",
        secret: "shh-keep-secret",
      },
      fetchImpl,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.status).toBe(200);
      expect(r.mapped.packtrack_recommendation_id).toBe("pt-1");
      expect(r.mapped.status).toBe("queued");
    }
    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0]!.init?.headers as HeadersInit);
    expect(headers.get("x-luma-packtrack-secret")).toBe("shh-keep-secret");
    expect(headers.get("x-luma-recommendation-id")).toBe("rec-1");
    expect(headers.get("content-type")).toBe("application/json");
    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body.recommendation_id).toBe("rec-1");
    expect(body.source).toBe("LUMA");
  });
});

describe("sendRecommendationToPackTrack — failure modes", () => {
  it("returns HTTP_ERROR with status + bodySnippet on 4xx/5xx", async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response("oops", { status: 500 })) as unknown as typeof fetch;
    const r = await sendRecommendationToPackTrack(fixture(), {
      config: { url: "https://x", secret: "shh" },
      fetchImpl,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("HTTP_ERROR");
      expect(r.status).toBe(500);
      expect(r.bodySnippet).toBe("oops");
    }
  });

  it("returns INVALID_RESPONSE when the body is not JSON", async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response("not json", {
        status: 200,
      })) as unknown as typeof fetch;
    const r = await sendRecommendationToPackTrack(fixture(), {
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
    const r = await sendRecommendationToPackTrack(fixture(), {
      config: { url: "https://x", secret: "shh" },
      fetchImpl,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("NETWORK_ERROR");
      expect(r.reason).toContain("connection refused");
    }
  });

  it("strips the secret from any reflected response body", async () => {
    // PackTrack returns the secret in its error message — we never
    // surface it to operators.
    const fetchImpl: typeof fetch = (async () =>
      new Response(`bad: shh-keep-secret`, {
        status: 401,
      })) as unknown as typeof fetch;
    const r = await sendRecommendationToPackTrack(fixture(), {
      config: { url: "https://x", secret: "shh-keep-secret" },
      fetchImpl,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.bodySnippet).toBe("bad: [REDACTED]");
    }
  });
});
