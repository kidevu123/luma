// PT-7D — action tests. Acknowledge + dismiss exercised against a
// stubbed drizzle tx + a stubbed requireAdmin. Verifies:
//   - acknowledge sets acknowledged_at and writes audit
//   - acknowledge is idempotent (no second write when already ack'd)
//   - dismiss sets dismissed_at and appends to warnings[]
//   - dismiss is idempotent
//   - invalid recommendationId is rejected before any tx work
//   - no PackTrack outbound call happens (no fetch / no integration import)

import { describe, expect, it, vi, beforeEach } from "vitest";

// Stub `@/lib/db` BEFORE importing actions.ts so the action's `db`
// import resolves to our queue-based stub. Vitest hoists vi.mock above
// the imports automatically.
const txState: {
  rows: Array<Record<string, unknown>>;
  updates: Array<{ set: Record<string, unknown> }>;
  audits: Array<{ action: string; targetId: string | null }>;
} = { rows: [], updates: [], audits: [] };

vi.mock("@/lib/db", () => ({
  db: {
    // Top-level read used by the send action before opening a tx.
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => txState.rows,
        }),
      }),
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => txState.rows,
            }),
          }),
        }),
        update: () => ({
          set: (vals: Record<string, unknown>) => ({
            where: async () => {
              txState.updates.push({ set: vals });
            },
          }),
        }),
        insert: () => ({
          values: async (vals: Record<string, unknown>) => {
            // The action only inserts via writeAudit → auditLog. We
            // capture the action + targetId.
            txState.audits.push({
              action: String(vals.action),
              targetId: vals.targetId as string | null,
            });
          },
        }),
      };
      return fn(tx);
    },
  },
}));

vi.mock("@/lib/auth-guards", () => ({
  requireAdmin: async () => ({ id: "user-admin", role: "ADMIN" as const }),
}));

vi.mock("next/cache", () => ({
  revalidatePath: () => undefined,
}));

import {
  acknowledgeMaterialRecommendationAction,
  dismissMaterialRecommendationAction,
  sendMaterialRecommendationToPackTrackAction,
} from "./actions";
import {
  PACKTRACK_RECOMMENDATION_SECRET_ENV,
  PACKTRACK_RECOMMENDATION_URL_ENV,
} from "@/lib/integrations/packtrack/recommendations";

const VALID_ID = "11111111-1111-1111-1111-111111111111";

function seedActiveRow() {
  txState.rows = [
    {
      id: VALID_ID,
      acknowledgedAt: null,
      dismissedAt: null,
      warnings: [],
    },
  ];
  txState.updates = [];
  txState.audits = [];
}

beforeEach(() => {
  txState.rows = [];
  txState.updates = [];
  txState.audits = [];
});

describe("acknowledgeMaterialRecommendationAction", () => {
  it("rejects invalid recommendationId without writing", async () => {
    const fd = new FormData();
    fd.set("recommendationId", "not-a-uuid");
    const result = await acknowledgeMaterialRecommendationAction(fd);
    expect(result.error).toBeDefined();
    expect(result.ok).toBeUndefined();
    expect(txState.updates).toEqual([]);
    expect(txState.audits).toEqual([]);
  });

  it("sets acknowledgedAt and writes an audit row on the active row", async () => {
    seedActiveRow();
    const fd = new FormData();
    fd.set("recommendationId", VALID_ID);
    const result = await acknowledgeMaterialRecommendationAction(fd);
    expect(result.ok).toBe(true);
    expect(txState.updates).toHaveLength(1);
    expect(txState.updates[0]!.set.acknowledgedAt).toBeInstanceOf(Date);
    expect(txState.audits).toEqual([
      { action: "material_recommendation.acknowledge", targetId: VALID_ID },
    ]);
  });

  it("is idempotent — second call on already-acknowledged row is a noop", async () => {
    txState.rows = [
      {
        id: VALID_ID,
        acknowledgedAt: new Date("2026-05-12"),
        dismissedAt: null,
        warnings: [],
      },
    ];
    const fd = new FormData();
    fd.set("recommendationId", VALID_ID);
    const result = await acknowledgeMaterialRecommendationAction(fd);
    expect(result.ok).toBe(true);
    expect(txState.updates).toEqual([]);
    expect(txState.audits).toEqual([]);
  });

  it("returns an error when the row does not exist", async () => {
    txState.rows = [];
    const fd = new FormData();
    fd.set("recommendationId", VALID_ID);
    const result = await acknowledgeMaterialRecommendationAction(fd);
    expect(result.error).toBe("Recommendation not found");
    expect(result.ok).toBeUndefined();
  });
});

describe("dismissMaterialRecommendationAction", () => {
  it("rejects invalid recommendationId without writing", async () => {
    const fd = new FormData();
    fd.set("recommendationId", "not-a-uuid");
    const result = await dismissMaterialRecommendationAction(fd);
    expect(result.error).toBeDefined();
    expect(txState.updates).toEqual([]);
  });

  it("sets dismissedAt and appends a [dismissed: ...] tag to warnings[]", async () => {
    seedActiveRow();
    const fd = new FormData();
    fd.set("recommendationId", VALID_ID);
    fd.set("reason", "Already on order");
    fd.set("notes", "PO-12345 issued yesterday");
    const result = await dismissMaterialRecommendationAction(fd);
    expect(result.ok).toBe(true);
    expect(txState.updates).toHaveLength(1);
    const update = txState.updates[0]!.set;
    expect(update.dismissedAt).toBeInstanceOf(Date);
    expect(update.warnings).toEqual([
      "[dismissed: Already on order — PO-12345 issued yesterday]",
    ]);
    expect(txState.audits).toEqual([
      { action: "material_recommendation.dismiss", targetId: VALID_ID },
    ]);
  });

  it("preserves prior warnings when dismissing", async () => {
    txState.rows = [
      {
        id: VALID_ID,
        acknowledgedAt: null,
        dismissedAt: null,
        warnings: ["prior warning"],
      },
    ];
    const fd = new FormData();
    fd.set("recommendationId", VALID_ID);
    const result = await dismissMaterialRecommendationAction(fd);
    expect(result.ok).toBe(true);
    const update = txState.updates[0]!.set;
    expect(update.warnings).toEqual(["prior warning", "[dismissed]"]);
  });

  it("is idempotent — second call on already-dismissed row is a noop", async () => {
    txState.rows = [
      {
        id: VALID_ID,
        acknowledgedAt: null,
        dismissedAt: new Date("2026-05-12"),
        warnings: ["[dismissed]"],
      },
    ];
    const fd = new FormData();
    fd.set("recommendationId", VALID_ID);
    const result = await dismissMaterialRecommendationAction(fd);
    expect(result.ok).toBe(true);
    expect(txState.updates).toEqual([]);
    expect(txState.audits).toEqual([]);
  });

  it("returns an error when the row does not exist", async () => {
    txState.rows = [];
    const fd = new FormData();
    fd.set("recommendationId", VALID_ID);
    const result = await dismissMaterialRecommendationAction(fd);
    expect(result.error).toBe("Recommendation not found");
  });
});

describe("PackTrack discipline in actions.ts", () => {
  it("acknowledge and dismiss never call the outbound client", () => {
    // Static scan: only sendMaterialRecommendationToPackTrackAction is
    // allowed to mention sendRecommendationToPackTrack. The
    // acknowledge / dismiss helpers must not.
     
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "actions.ts"),
      "utf8",
    );
    // Find acknowledge + dismiss function bodies; both should be free
    // of any send-side identifiers.
    const ackIdx = src.indexOf(
      "export async function acknowledgeMaterialRecommendationAction",
    );
    const dismissIdx = src.indexOf(
      "export async function dismissMaterialRecommendationAction",
    );
    const sendIdx = src.indexOf(
      "export async function sendMaterialRecommendationToPackTrackAction",
    );
    expect(ackIdx).toBeGreaterThan(-1);
    expect(dismissIdx).toBeGreaterThan(-1);
    expect(sendIdx).toBeGreaterThan(-1);
    // ack function body ends where the next export begins
    const ackEnd = Math.min(dismissIdx, sendIdx);
    const ackBody = src.slice(ackIdx, ackEnd);
    expect(ackBody).not.toContain("sendRecommendationToPackTrack");
    expect(ackBody).not.toContain("fetch(");
    const dismissEnd = Math.max(dismissIdx, sendIdx) === dismissIdx
      ? src.length
      : Math.max(dismissIdx, sendIdx);
    const dismissBody = src.slice(dismissIdx, dismissEnd);
    expect(dismissBody).not.toContain("sendRecommendationToPackTrack");
    expect(dismissBody).not.toContain("fetch(");
  });

  it("actions.ts does not contain PO-creation language", () => {
     
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "actions.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/\bcreateP[Oo]\b|createPurchaseOrder/i);
    expect(src).not.toMatch(/luma ordered/i);
  });
});

describe("sendMaterialRecommendationToPackTrackAction", () => {
  function seedSendableRow(over: Record<string, unknown> = {}) {
    txState.rows = [
      {
        id: VALID_ID,
        recommendationId: "rec-1",
        materialCode: "LBL-001",
        materialName: "Bottle Label",
        productId: null,
        productName: null,
        productSku: null,
        compatibilityRole: null,
        currentOnHand: "0",
        acceptedInventory: "0",
        projectedDemand: "350",
        projectedShortageQuantity: "350",
        recommendedOrderQuantity: "420",
        neededByDate: "2026-05-20",
        confidence: "HIGH",
        severity: "CRITICAL",
        reason: "Runs out 2026-05-13",
        sourceSignals: [],
        missingInputs: [],
        warnings: [],
        sendableToPackTrack: true,
        generatedAt: new Date("2026-05-13T10:00:00Z"),
        expiresAt: null,
        acknowledgedAt: new Date("2026-05-13T09:00:00Z"),
        dismissedAt: null,
        recommendedSupplierHint: null,
        lastSendError: null,
        sentAt: null,
        lastSentResponse: null,
        ...over,
      },
    ];
    txState.updates = [];
    txState.audits = [];
  }

  function withConfig(fn: () => Promise<void>) {
    const prevUrl = process.env[PACKTRACK_RECOMMENDATION_URL_ENV];
    const prevSecret = process.env[PACKTRACK_RECOMMENDATION_SECRET_ENV];
    process.env[PACKTRACK_RECOMMENDATION_URL_ENV] =
      "https://packtrack.example/recs";
    process.env[PACKTRACK_RECOMMENDATION_SECRET_ENV] = "shh";
    return fn().finally(() => {
      if (prevUrl === undefined)
        delete process.env[PACKTRACK_RECOMMENDATION_URL_ENV];
      else process.env[PACKTRACK_RECOMMENDATION_URL_ENV] = prevUrl;
      if (prevSecret === undefined)
        delete process.env[PACKTRACK_RECOMMENDATION_SECRET_ENV];
      else process.env[PACKTRACK_RECOMMENDATION_SECRET_ENV] = prevSecret;
    });
  }

  it("refuses when env is not configured", async () => {
    seedSendableRow();
    // env explicitly cleared
    delete process.env[PACKTRACK_RECOMMENDATION_URL_ENV];
    delete process.env[PACKTRACK_RECOMMENDATION_SECRET_ENV];
    const fd = new FormData();
    fd.set("recommendationId", VALID_ID);
    const r = await sendMaterialRecommendationToPackTrackAction(fd);
    expect("error" in r ? r.code : null).toBe("NOT_CONFIGURED");
    expect(txState.updates).toEqual([]);
  });

  it("refuses when not acknowledged", async () => {
    await withConfig(async () => {
      seedSendableRow({ acknowledgedAt: null });
      const fd = new FormData();
      fd.set("recommendationId", VALID_ID);
      const r = await sendMaterialRecommendationToPackTrackAction(fd);
      expect("error" in r ? r.code : null).toBe("NOT_ACKNOWLEDGED");
      expect(txState.updates).toEqual([]);
    });
  });

  it("refuses when dismissed", async () => {
    await withConfig(async () => {
      seedSendableRow({ dismissedAt: new Date() });
      const fd = new FormData();
      fd.set("recommendationId", VALID_ID);
      const r = await sendMaterialRecommendationToPackTrackAction(fd);
      expect("error" in r ? r.code : null).toBe("DISMISSED");
    });
  });

  it("refuses when sendable_to_packtrack=false", async () => {
    await withConfig(async () => {
      seedSendableRow({ sendableToPackTrack: false });
      const fd = new FormData();
      fd.set("recommendationId", VALID_ID);
      const r = await sendMaterialRecommendationToPackTrackAction(fd);
      expect("error" in r ? r.code : null).toBe("NOT_SENDABLE");
    });
  });

  it("refuses MISSING confidence", async () => {
    await withConfig(async () => {
      seedSendableRow({ confidence: "MISSING" });
      const fd = new FormData();
      fd.set("recommendationId", VALID_ID);
      const r = await sendMaterialRecommendationToPackTrackAction(fd);
      expect("error" in r ? r.code : null).toBe("BLOCKED_BY_CONFIDENCE");
    });
  });

  it("refuses recommended_order_quantity <= 0", async () => {
    await withConfig(async () => {
      seedSendableRow({ recommendedOrderQuantity: "0" });
      const fd = new FormData();
      fd.set("recommendationId", VALID_ID);
      const r = await sendMaterialRecommendationToPackTrackAction(fd);
      expect("error" in r ? r.code : null).toBe("BLOCKED_BY_QUANTITY");
    });
  });

  it("on HTTP failure writes last_send_error and audits send_failed", async () => {
    await withConfig(async () => {
      seedSendableRow();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response("rejected", { status: 422 })) as typeof fetch;
      try {
        const fd = new FormData();
        fd.set("recommendationId", VALID_ID);
        const r = await sendMaterialRecommendationToPackTrackAction(fd);
        expect("error" in r ? r.code : null).toBe("HTTP_ERROR");
        expect(txState.updates).toHaveLength(1);
        expect(txState.updates[0]!.set.lastSendError).toContain("HTTP 422");
        expect(txState.updates[0]!.set.sentAt).toBeUndefined();
        expect(txState.audits).toEqual([
          {
            action: "material_recommendation.send_failed",
            targetId: VALID_ID,
          },
        ]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  it("on success writes sent_at + last_sent_response and audits send", async () => {
    await withConfig(async () => {
      seedSendableRow();
      const originalFetch = globalThis.fetch;
      const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
      globalThis.fetch = (async (
        url: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        calls.push({ url: String(url), init });
        return new Response(
          JSON.stringify({ recommendation_id: "pt-1", status: "queued" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch;
      try {
        const fd = new FormData();
        fd.set("recommendationId", VALID_ID);
        const r = await sendMaterialRecommendationToPackTrackAction(fd);
        expect("ok" in r ? r.ok : false).toBe(true);
        // recommendation_id is used as the idempotency header
        const headers = new Headers(calls[0]!.init?.headers as HeadersInit);
        expect(headers.get("x-luma-recommendation-id")).toBe("rec-1");
        expect(headers.get("x-luma-packtrack-secret")).toBe("shh");
        expect(txState.updates).toHaveLength(1);
        expect(txState.updates[0]!.set.sentAt).toBeInstanceOf(Date);
        expect(txState.updates[0]!.set.lastSendError).toBeNull();
        expect(txState.audits).toEqual([
          {
            action: "material_recommendation.send",
            targetId: VALID_ID,
          },
        ]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
