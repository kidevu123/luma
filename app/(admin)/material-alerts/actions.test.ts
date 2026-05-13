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
} from "./actions";

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

describe("no PackTrack outbound from PT-7D", () => {
  it("the actions module does not import any PackTrack client", () => {
    // Static import scan: the actions source must not reference the
    // PackTrack outbound module (which doesn't even exist yet — PT-7E
    // will add it). We do this as a string scan against the source
    // file rather than runtime, so adding the import later trips this
    // even if the action never executes.
    // Resolved relative to this test file.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "actions.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/packtrack-client|packtrack-outbound|packtrack\/send/i);
    expect(src).not.toMatch(/fetch\s*\(/);
  });
});
