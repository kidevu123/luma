// PT-7C — projector / rebuilder tests for read_material_recommendations.
//
// The projector composes pure PT-7B helpers with a drizzle `tx`. The
// pure math is exhaustively covered by lib/production/packtrack-
// shortage.test.ts; this file proves the DB ↔ helper wiring is honest:
//   - machine-consumable kinds are skipped
//   - product-scope inference matches PT-7A §11.3
//   - upsert preserves operator state across rebuilds
//   - null derivations delete active rows but leave acknowledged ones
//   - the new packaging_materials ordering fields flow into the input
//
// We stub the drizzle chain rather than booting a real DB — same
// pattern as material-reconciliation-v2.test.ts / qc-events.test.ts.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { transaction: () => Promise.resolve(undefined) },
}));

import { rebuildMaterialRecommendations } from "./packtrack-recommendations";

// ─────────────────────────────────────────────────────────────────────────────
// Stub tx builder
// ─────────────────────────────────────────────────────────────────────────────

type MaterialFixture = {
  id: string;
  sku: string;
  name: string;
  kind: string;
  parLevel: number | null;
  minOrderQuantity: string | null;
  safetyBufferPercent: string | null;
  orderMultiple: string | null;
};

type CompatFixture = {
  productId: string;
  role: string;
  required: boolean;
  isDefault: boolean;
  scope: string;
};

type ScopeFixture = {
  // Inputs available for this (material × scope) pair.
  compatRows: CompatFixture[];
  // Inventory aggregates (lotAgg).
  onHand: number | null;
  minConfidence: string | null;
  // Accepted-inventory aggregate.
  accepted: number | null;
  anyPacktrack?: boolean;
  anyImport?: boolean;
  anyManual?: boolean;
  allCounted?: boolean;
  // Recent receipt — null = none.
  recentReceipt: {
    received_at: string;
    qty: number;
    source_system: "PACKTRACK" | "MANUAL_LUMA" | "ZOHO" | "IMPORT" | null;
    supplier: string | null;
  } | null;
  // Daily usage.
  usageRate: number | null;
  usageDays: number;
  // hasActiveRecommendation? (drives PT-7B hysteresis).
  hadActive: boolean;
  // findActiveRow result.
  existing: {
    id: string;
    acknowledgedAt: Date | null;
    dismissedAt: Date | null;
  } | null;
  // Product context (only used when product-scoped).
  product?: { name: string; sku: string };
  bom?: Array<{ qtyPerUnit: number; perScope: "UNIT" | "DISPLAY" | "CASE" }>;
};

type Captured = {
  inserts: Array<Record<string, unknown>>;
  updates: Array<{ id: string; set: Record<string, unknown> }>;
  deletes: Array<{ id: string }>;
};

function buildStubTx(args: {
  materials: MaterialFixture[];
  scopes: ScopeFixture[];
  captured: Captured;
}) {
  const { materials, scopes, captured } = args;
  let materialSelectsServed = false;
  let scopeIdx = 0;
  let scopeSelectStep = 0;
  let scopeExecuteStep = 0;
  // 'INPUT'        — hydrate / pre-decide
  // 'POST_FIND'    — findActiveRow has returned; either a write op
  //                  follows (same scope) or any other op means
  //                  the upsert decided to noop / preserve and we
  //                  must advance to the next scope.
  let phase: "INPUT" | "POST_FIND" = "INPUT";

  const currentScope = () => scopes[scopeIdx];

  const advanceScope = () => {
    scopeIdx += 1;
    scopeSelectStep = 0;
    scopeExecuteStep = 0;
    phase = "INPUT";
  };

  const tx: Record<string, unknown> = {
    select: (_cols?: unknown) => {
      // First select call always returns the materials list.
      if (!materialSelectsServed) {
        materialSelectsServed = true;
        const rows = materials.map((m) => ({ ...m }));
        return {
          from: () => ({ where: () => Promise.resolve(rows) }),
        };
      }
      // Any select after the upsert decided to noop / preserve must
      // belong to the NEXT scope — advance before dispatching.
      if (phase === "POST_FIND") advanceScope();

      const scope = currentScope();
      const step = scopeSelectStep;
      scopeSelectStep += 1;

      const productScoped = scope?.product != null;

      if (productScoped) {
        if (step === 0) {
          return {
            from: () => ({
              where: () =>
                Promise.resolve(scope?.product ? [scope.product] : []),
            }),
          };
        }
        if (step === 1) {
          return {
            from: () => ({
              where: () => Promise.resolve(scope?.bom ?? []),
            }),
          };
        }
        // step >= 2 → findActiveRow
      }

      // findActiveRow: 1st select for material-wide, 3rd for
      // product-scoped. Mark phase so we know an upsert decision
      // is imminent.
      phase = "POST_FIND";
      const existingRows = scope?.existing
        ? [
            {
              id: scope.existing.id,
              acknowledgedAt: scope.existing.acknowledgedAt,
              dismissedAt: scope.existing.dismissedAt,
            },
          ]
        : [];
      return {
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(existingRows),
          }),
        }),
      };
    },
    execute: async (_sql: unknown) => {
      // Any execute after a POST_FIND means the previous scope ended
      // without a write (noop / preserve) and this is the next scope.
      if (phase === "POST_FIND") advanceScope();
      const scope = currentScope();
      const step = scopeExecuteStep;
      scopeExecuteStep += 1;
      if (!scope) return [];
      switch (step) {
        case 0:
          return scope.compatRows;
        case 1:
          return [
            {
              onHand: scope.onHand,
              maxConfidence: scope.minConfidence,
              minConfidence: scope.minConfidence,
            },
          ];
        case 2:
          return [
            {
              accepted: scope.accepted,
              anyPacktrack: scope.anyPacktrack ?? false,
              anyImport: scope.anyImport ?? false,
              anyManual: scope.anyManual ?? false,
              allCounted: scope.allCounted ?? false,
            },
          ];
        case 3:
          return scope.recentReceipt ? [scope.recentReceipt] : [];
        case 4:
          return [{ rate: scope.usageRate, days: scope.usageDays }];
        case 5:
          return scope.hadActive ? [{ "?column?": 1 }] : [];
        default:
          return [];
      }
    },
    insert: () => ({
      values: (vals: Record<string, unknown>) => {
        captured.inserts.push(vals);
        // After the write the scope is done.
        advanceScope();
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: (vals: Record<string, unknown>) => ({
        where: () => {
          const existing = currentScope()?.existing ?? null;
          captured.updates.push({
            id: existing?.id ?? "(unknown)",
            set: vals,
          });
          advanceScope();
          return Promise.resolve();
        },
      }),
    }),
    delete: () => ({
      where: () => {
        const existing = currentScope()?.existing ?? null;
        captured.deletes.push({ id: existing?.id ?? "(unknown)" });
        advanceScope();
        return Promise.resolve();
      },
    }),
  };

  return tx;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

function mat(over: Partial<MaterialFixture> = {}): MaterialFixture {
  return {
    id: "mat-1",
    sku: "LBL-001",
    name: "Bottle Label 30mL",
    kind: "LABEL",
    parLevel: null,
    minOrderQuantity: null,
    safetyBufferPercent: null,
    orderMultiple: null,
    ...over,
  };
}

function scope(over: Partial<ScopeFixture> = {}): ScopeFixture {
  return {
    compatRows: [],
    onHand: 0,
    minConfidence: "HIGH",
    accepted: 0,
    recentReceipt: null,
    usageRate: 10,
    usageDays: 7,
    hadActive: false,
    existing: null,
    ...over,
  };
}

function freshCaptured(): Captured {
  return { inserts: [], updates: [], deletes: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("rebuildMaterialRecommendations — kind filtering", () => {
  it("skips PVC_ROLL (machine consumable)", async () => {
    const captured = freshCaptured();
    const tx = buildStubTx({
      materials: [mat({ kind: "PVC_ROLL" })],
      scopes: [],
      captured,
    });
    const result = await rebuildMaterialRecommendations(
      tx as unknown as Parameters<typeof rebuildMaterialRecommendations>[0],
    );
    expect(result.scanned).toBe(1);
    expect(result.skippedMachineConsumable).toBe(1);
    expect(result.written).toBe(0);
    expect(captured.inserts).toEqual([]);
  });

  it("skips FOIL_ROLL (machine consumable)", async () => {
    const captured = freshCaptured();
    const tx = buildStubTx({
      materials: [mat({ kind: "FOIL_ROLL" })],
      scopes: [],
      captured,
    });
    const result = await rebuildMaterialRecommendations(
      tx as unknown as Parameters<typeof rebuildMaterialRecommendations>[0],
    );
    expect(result.skippedMachineConsumable).toBe(1);
    expect(captured.inserts).toEqual([]);
  });

  it("skips BLISTER_FOIL (machine consumable)", async () => {
    const captured = freshCaptured();
    const tx = buildStubTx({
      materials: [mat({ kind: "BLISTER_FOIL" })],
      scopes: [],
      captured,
    });
    const result = await rebuildMaterialRecommendations(
      tx as unknown as Parameters<typeof rebuildMaterialRecommendations>[0],
    );
    expect(result.skippedMachineConsumable).toBe(1);
    expect(captured.inserts).toEqual([]);
  });
});

describe("rebuildMaterialRecommendations — product-scope inference (PT-7A §11.3)", () => {
  it("0 compat rows → material-wide row (product_id = null)", async () => {
    const captured = freshCaptured();
    const tx = buildStubTx({
      materials: [mat({ kind: "LABEL" })],
      scopes: [
        scope({
          compatRows: [],
          onHand: 0,
          accepted: 0,
          usageRate: 50,
          usageDays: 7,
        }),
      ],
      captured,
    });
    const result = await rebuildMaterialRecommendations(
      tx as unknown as Parameters<typeof rebuildMaterialRecommendations>[0],
    );
    expect(result.scanned).toBe(1);
    expect(captured.inserts).toHaveLength(1);
    expect(captured.inserts[0]!.productId).toBeNull();
  });

  it("1 compat row → product-scoped row", async () => {
    const captured = freshCaptured();
    const tx = buildStubTx({
      materials: [mat({ kind: "LABEL" })],
      scopes: [
        scope({
          compatRows: [
            {
              productId: "prod-1",
              role: "BOTTLE_LABEL",
              required: true,
              isDefault: true,
              scope: "PRODUCT",
            },
          ],
          onHand: 0,
          accepted: 0,
          usageRate: 50,
          usageDays: 7,
          product: { name: "Vitamin C 30ct", sku: "VITC-30" },
          bom: [{ qtyPerUnit: 1, perScope: "UNIT" }],
        }),
      ],
      captured,
    });
    await rebuildMaterialRecommendations(
      tx as unknown as Parameters<typeof rebuildMaterialRecommendations>[0],
    );
    expect(captured.inserts).toHaveLength(1);
    expect(captured.inserts[0]!.productId).toBe("prod-1");
    expect(captured.inserts[0]!.productName).toBe("Vitamin C 30ct");
    expect(captured.inserts[0]!.productSku).toBe("VITC-30");
  });

  it("2+ compat rows → material-wide row (multi-product)", async () => {
    const captured = freshCaptured();
    const tx = buildStubTx({
      materials: [mat({ kind: "LABEL" })],
      scopes: [
        scope({
          compatRows: [
            {
              productId: "prod-a",
              role: "BOTTLE_LABEL",
              required: true,
              isDefault: true,
              scope: "PRODUCT",
            },
            {
              productId: "prod-b",
              role: "BOTTLE_LABEL",
              required: true,
              isDefault: false,
              scope: "PRODUCT",
            },
          ],
          onHand: 0,
          accepted: 0,
          usageRate: 50,
          usageDays: 7,
        }),
      ],
      captured,
    });
    await rebuildMaterialRecommendations(
      tx as unknown as Parameters<typeof rebuildMaterialRecommendations>[0],
    );
    expect(captured.inserts).toHaveLength(1);
    expect(captured.inserts[0]!.productId).toBeNull();
  });
});

describe("rebuildMaterialRecommendations — sendable / confidence", () => {
  it("missing material_code marks sendable_to_packtrack=false", async () => {
    const captured = freshCaptured();
    const tx = buildStubTx({
      materials: [mat({ sku: "", kind: "LABEL" })],
      scopes: [
        scope({
          onHand: 0,
          accepted: 0,
          minConfidence: null,
          usageRate: 50,
          usageDays: 7,
        }),
      ],
      captured,
    });
    await rebuildMaterialRecommendations(
      tx as unknown as Parameters<typeof rebuildMaterialRecommendations>[0],
    );
    expect(captured.inserts).toHaveLength(1);
    expect(captured.inserts[0]!.sendableToPackTrack).toBe(false);
  });

  it("HIGH-confidence inputs with code + qty → sendable_to_packtrack=true", async () => {
    const captured = freshCaptured();
    const tx = buildStubTx({
      materials: [
        mat({
          sku: "LBL-HI",
          kind: "LABEL",
          minOrderQuantity: "100",
        }),
      ],
      scopes: [
        scope({
          onHand: 0,
          accepted: 0,
          minConfidence: "HIGH",
          allCounted: true,
          usageRate: 50,
          usageDays: 7,
          recentReceipt: {
            received_at: "2026-05-01",
            qty: 500,
            source_system: "PACKTRACK",
            supplier: "Acme Labels",
          },
        }),
      ],
      captured,
    });
    await rebuildMaterialRecommendations(
      tx as unknown as Parameters<typeof rebuildMaterialRecommendations>[0],
    );
    expect(captured.inserts).toHaveLength(1);
    expect(captured.inserts[0]!.sendableToPackTrack).toBe(true);
    expect(captured.inserts[0]!.confidence).not.toBe("MISSING");
  });
});

describe("rebuildMaterialRecommendations — ordering fields flow through", () => {
  it("min_order_quantity raises recommended_order_quantity to the floor", async () => {
    const captured = freshCaptured();
    const tx = buildStubTx({
      materials: [
        mat({
          sku: "LBL-MOQ",
          kind: "LABEL",
          minOrderQuantity: "1000",
        }),
      ],
      scopes: [
        scope({
          onHand: 0,
          accepted: 0,
          minConfidence: "HIGH",
          allCounted: true,
          usageRate: 50,
          usageDays: 7,
        }),
      ],
      captured,
    });
    await rebuildMaterialRecommendations(
      tx as unknown as Parameters<typeof rebuildMaterialRecommendations>[0],
    );
    expect(captured.inserts).toHaveLength(1);
    // Demand over the 7-day lead time ≈ 350, but MOQ=1000 forces ≥1000.
    const recQty = Number(captured.inserts[0]!.recommendedOrderQuantity);
    expect(recQty).toBeGreaterThanOrEqual(1000);
  });

  it("order_multiple rounds recommended quantity up to a multiple", async () => {
    const captured = freshCaptured();
    const tx = buildStubTx({
      materials: [
        mat({
          sku: "LBL-OM",
          kind: "LABEL",
          orderMultiple: "100",
        }),
      ],
      scopes: [
        scope({
          onHand: 0,
          accepted: 0,
          minConfidence: "HIGH",
          allCounted: true,
          usageRate: 33,
          usageDays: 7,
        }),
      ],
      captured,
    });
    await rebuildMaterialRecommendations(
      tx as unknown as Parameters<typeof rebuildMaterialRecommendations>[0],
    );
    expect(captured.inserts).toHaveLength(1);
    const recQty = Number(captured.inserts[0]!.recommendedOrderQuantity);
    expect(recQty % 100).toBe(0);
  });
});

describe("rebuildMaterialRecommendations — upsert / preservation", () => {
  it("no recommendation + no existing row → noop", async () => {
    const captured = freshCaptured();
    const tx = buildStubTx({
      materials: [mat({ kind: "LABEL" })],
      scopes: [
        scope({
          onHand: 1_000_000,
          accepted: 1_000_000,
          minConfidence: "HIGH",
          allCounted: true,
          usageRate: 1,
          usageDays: 7,
          existing: null,
        }),
      ],
      captured,
    });
    const result = await rebuildMaterialRecommendations(
      tx as unknown as Parameters<typeof rebuildMaterialRecommendations>[0],
    );
    expect(result.written).toBe(0);
    expect(result.deleted).toBe(0);
    expect(result.preservedAcknowledged).toBe(0);
    expect(captured.inserts).toEqual([]);
    expect(captured.deletes).toEqual([]);
  });

  it("no recommendation + existing active row → delete", async () => {
    const captured = freshCaptured();
    const tx = buildStubTx({
      materials: [mat({ kind: "LABEL" })],
      scopes: [
        scope({
          onHand: 1_000_000,
          accepted: 1_000_000,
          minConfidence: "HIGH",
          allCounted: true,
          usageRate: 1,
          usageDays: 7,
          existing: {
            id: "rec-existing",
            acknowledgedAt: null,
            dismissedAt: null,
          },
        }),
      ],
      captured,
    });
    const result = await rebuildMaterialRecommendations(
      tx as unknown as Parameters<typeof rebuildMaterialRecommendations>[0],
    );
    expect(result.deleted).toBe(1);
    expect(captured.deletes).toEqual([{ id: "rec-existing" }]);
  });

  it("no recommendation + acknowledged existing row → preserved (no delete)", async () => {
    const captured = freshCaptured();
    const tx = buildStubTx({
      materials: [mat({ kind: "LABEL" })],
      scopes: [
        scope({
          onHand: 1_000_000,
          accepted: 1_000_000,
          minConfidence: "HIGH",
          allCounted: true,
          usageRate: 1,
          usageDays: 7,
          existing: {
            id: "rec-ack",
            acknowledgedAt: new Date("2026-04-01"),
            dismissedAt: null,
          },
        }),
      ],
      captured,
    });
    const result = await rebuildMaterialRecommendations(
      tx as unknown as Parameters<typeof rebuildMaterialRecommendations>[0],
    );
    expect(result.preservedAcknowledged).toBe(1);
    expect(result.deleted).toBe(0);
    expect(captured.deletes).toEqual([]);
  });

  it("recommendation + existing row → update (preserves recommendation_id)", async () => {
    const captured = freshCaptured();
    const tx = buildStubTx({
      materials: [mat({ kind: "LABEL", sku: "LBL-UP" })],
      scopes: [
        scope({
          onHand: 0,
          accepted: 0,
          minConfidence: "HIGH",
          allCounted: true,
          usageRate: 50,
          usageDays: 7,
          existing: {
            id: "rec-existing",
            acknowledgedAt: null,
            dismissedAt: null,
          },
        }),
      ],
      captured,
    });
    const result = await rebuildMaterialRecommendations(
      tx as unknown as Parameters<typeof rebuildMaterialRecommendations>[0],
    );
    expect(result.written).toBe(1);
    expect(captured.inserts).toEqual([]);
    expect(captured.updates).toHaveLength(1);
    expect(captured.updates[0]!.id).toBe("rec-existing");
    // The update payload should NOT carry a recommendationId — that
    // field is left untouched so PackTrack's idempotency key holds.
    expect(captured.updates[0]!.set.recommendationId).toBeUndefined();
  });

  it("recommendation persisted: sourceSignals + missingInputs + warnings as jsonb-shaped arrays", async () => {
    const captured = freshCaptured();
    const tx = buildStubTx({
      materials: [mat({ kind: "LABEL", sku: "LBL-SIG" })],
      scopes: [
        scope({
          onHand: 0,
          accepted: 0,
          minConfidence: "HIGH",
          allCounted: true,
          usageRate: 50,
          usageDays: 7,
        }),
      ],
      captured,
    });
    await rebuildMaterialRecommendations(
      tx as unknown as Parameters<typeof rebuildMaterialRecommendations>[0],
    );
    expect(captured.inserts).toHaveLength(1);
    const row = captured.inserts[0]!;
    expect(Array.isArray(row.sourceSignals)).toBe(true);
    expect(Array.isArray(row.missingInputs)).toBe(true);
    expect(Array.isArray(row.warnings)).toBe(true);
  });
});
