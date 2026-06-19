// Route-level contract tests for POST /api/integrations/packtrack/items.
//
// Locks the upsert + backfill rules so the bug that caused
// `packaging_materials.zoho_item_id` to stay null after PackTrack
// re-registered an item with a now-known Zoho id cannot regress:
//
//   • existing material with null zoho_item_id + incoming non-null → UPDATED
//   • existing material with matching zoho_item_id                 → ALREADY_MAPPED
//   • existing material with a *different* zoho_item_id            → 409 CONFLICT
//   • new material with zoho_item_id                               → REGISTERED w/ id set
//
// The route uses Drizzle's fluent builder + db.transaction; we provide a
// hand-rolled fake `tx` (and a thin select-builder shim) so the test
// stays pure — no Drizzle, no Postgres, no Next runtime DB.

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({ db: { transaction: vi.fn() } }));

vi.mock("@/lib/db/schema", () => ({
  packagingMaterials: { __tbl: "packagingMaterials" } as unknown,
  externalSystems: { __tbl: "externalSystems" } as unknown,
  externalItemMappings: { __tbl: "externalItemMappings" } as unknown,
}));

import { db } from "@/lib/db";
import {
  packagingMaterials,
  externalSystems,
  externalItemMappings,
} from "@/lib/db/schema";

import { POST } from "./route";

const SECRET = "test-secret-2026";

type FakeMaterial = { id: string; zohoItemId: string | null };
type FakeMapping = { id: string; materialItemId: string | null };

interface World {
  systemId: string;
  materialBySku: Map<string, FakeMaterial>;
  mappingByExternalId: Map<string, FakeMapping>;
  // For assertions:
  updates: {
    packagingMaterials: Array<{ id: string; set: Record<string, unknown> }>;
    externalItemMappings: Array<{ id: string; set: Record<string, unknown> }>;
  };
  inserts: {
    packagingMaterials: Array<Record<string, unknown>>;
    externalItemMappings: Array<Record<string, unknown>>;
  };
}

function makeTx(world: World) {
  // Each select(...) call returns a "chain" object capturing which
  // table it points at and (optionally) the where predicate. We keep
  // the chain trivially typed so the test stays readable.
  return {
    select(_fields?: Record<string, unknown>) {
      let target: unknown = null;
      const chain: Record<string, unknown> = {
        from(tbl: unknown) {
          target = tbl;
          return chain;
        },
        async where(_pred: unknown) {
          if (target === externalSystems) return [{ id: world.systemId }];
          if (target === externalItemMappings) {
            // Mapping is looked up by external_item_id (material_code) — the
            // call site builds an `and(...)` predicate but we don't introspect
            // it; the test sets one mapping per material_code at most.
            const m = world.mappingByExternalId.values().next().value as
              | FakeMapping
              | undefined;
            return m ? [m] : [];
          }
          if (target === packagingMaterials) {
            const m = world.materialBySku.values().next().value as
              | FakeMaterial
              | undefined;
            return m ? [m] : [];
          }
          throw new Error(
            `unexpected select target: ${String((target as { __tbl?: string })?.__tbl)}`,
          );
        },
        // Chain helpers Drizzle exposes — not used in this route but kept
        // for safety so future edits don't NPE.
        innerJoin() {
          return chain;
        },
        leftJoin() {
          return chain;
        },
        limit() {
          return chain;
        },
      };
      return chain;
    },
    insert(tbl: unknown) {
      return {
        values(rec: Record<string, unknown>) {
          if (tbl === packagingMaterials) {
            world.inserts.packagingMaterials.push(rec);
            const id = `pm-${world.inserts.packagingMaterials.length}`;
            world.materialBySku.set(
              (rec.sku ?? "") as string,
              { id, zohoItemId: (rec.zohoItemId ?? null) as string | null },
            );
            return {
              async returning(_cols: unknown) {
                return [{ id }];
              },
            };
          }
          if (tbl === externalItemMappings) {
            world.inserts.externalItemMappings.push(rec);
            const id = `em-${world.inserts.externalItemMappings.length}`;
            world.mappingByExternalId.set(
              (rec.externalItemId ?? "") as string,
              { id, materialItemId: rec.materialItemId as string | null },
            );
            return undefined;
          }
          throw new Error("unexpected insert target");
        },
      };
    },
    update(tbl: unknown) {
      return {
        set(s: Record<string, unknown>) {
          return {
            async where(_pred: unknown) {
              if (tbl === packagingMaterials) {
                // We don't decode the predicate — there is at most one row
                // per test world, take it.
                const mat = [...world.materialBySku.values()][0];
                if (mat) {
                  world.updates.packagingMaterials.push({ id: mat.id, set: s });
                  if ("zohoItemId" in s) {
                    mat.zohoItemId = s.zohoItemId as string | null;
                  }
                }
                return undefined;
              }
              if (tbl === externalItemMappings) {
                const map = [...world.mappingByExternalId.values()][0];
                if (map) {
                  world.updates.externalItemMappings.push({
                    id: map.id,
                    set: s,
                  });
                  if ("materialItemId" in s) {
                    map.materialItemId = s.materialItemId as string | null;
                  }
                }
                return undefined;
              }
              throw new Error("unexpected update target");
            },
          };
        },
      };
    },
  };
}

function makeReq(body: Record<string, unknown>, secret = SECRET): Request {
  return new Request("http://localhost/api/integrations/packtrack/items", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-packtrack-secret": secret,
    },
    body: JSON.stringify(body),
  });
}

function freshWorld(overrides: Partial<World> = {}): World {
  return {
    systemId: "ext-sys-packtrack",
    materialBySku: overrides.materialBySku ?? new Map(),
    mappingByExternalId: overrides.mappingByExternalId ?? new Map(),
    updates: {
      packagingMaterials: [],
      externalItemMappings: [],
    },
    inserts: {
      packagingMaterials: [],
      externalItemMappings: [],
    },
  };
}

function arm(world: World) {
  vi.mocked(db.transaction).mockImplementation(
    async (cb: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) =>
      cb(makeTx(world)),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PACKTRACK_INTEGRATION_SECRET", SECRET);
});

const PAYLOAD = {
  material_code: "PT-00095",
  material_name: "Hyroxi MIT-B 4ct Sweet Trip - 100mg - Blister Card",
  kind: "BLISTER_CARD",
  unit_of_measure: "each",
  zoho_item_id: "ZHO-001",
};

describe("POST /api/integrations/packtrack/items", () => {
  it("rejects missing/invalid secret with 401", async () => {
    const res = await POST(makeReq(PAYLOAD, "wrong-secret"));
    expect(res.status).toBe(401);
  });

  it("registers a brand-new material with zoho_item_id (201 REGISTERED)", async () => {
    const world = freshWorld();
    arm(world);

    const res = await POST(makeReq(PAYLOAD));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      outcome: "REGISTERED",
      created: true,
      material_code: PAYLOAD.material_code,
    });
    expect(world.inserts.packagingMaterials).toHaveLength(1);
    expect(world.inserts.packagingMaterials[0]).toMatchObject({
      sku: PAYLOAD.material_code,
      zohoItemId: "ZHO-001",
    });
    expect(world.inserts.externalItemMappings).toHaveLength(1);
  });

  it("backfills zoho_item_id on an existing material whose zoho_item_id is null (200 UPDATED)", async () => {
    const world = freshWorld({
      materialBySku: new Map([
        [PAYLOAD.material_code, { id: "pm-pre", zohoItemId: null }],
      ]),
      mappingByExternalId: new Map([
        [PAYLOAD.material_code, { id: "em-pre", materialItemId: "pm-pre" }],
      ]),
    });
    arm(world);

    const res = await POST(makeReq(PAYLOAD));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      outcome: "UPDATED",
      created: false,
      luma_material_id: "pm-pre",
    });
    expect(world.updates.packagingMaterials).toEqual([
      { id: "pm-pre", set: { zohoItemId: "ZHO-001" } },
    ]);
  });

  it("does nothing when existing zoho_item_id matches incoming (200 ALREADY_MAPPED)", async () => {
    const world = freshWorld({
      materialBySku: new Map([
        [PAYLOAD.material_code, { id: "pm-pre", zohoItemId: "ZHO-001" }],
      ]),
      mappingByExternalId: new Map([
        [PAYLOAD.material_code, { id: "em-pre", materialItemId: "pm-pre" }],
      ]),
    });
    arm(world);

    const res = await POST(makeReq(PAYLOAD));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      outcome: "ALREADY_MAPPED",
      created: false,
      luma_material_id: "pm-pre",
    });
    expect(world.updates.packagingMaterials).toEqual([]);
  });

  it("flags a conflicting zoho_item_id with 409 ZOHO_ID_CONFLICT_REVIEW_REQUIRED", async () => {
    const world = freshWorld({
      materialBySku: new Map([
        [PAYLOAD.material_code, { id: "pm-pre", zohoItemId: "ZHO-OTHER" }],
      ]),
      mappingByExternalId: new Map([
        [PAYLOAD.material_code, { id: "em-pre", materialItemId: "pm-pre" }],
      ]),
    });
    arm(world);

    const res = await POST(makeReq(PAYLOAD));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: false,
      outcome: "ZOHO_ID_CONFLICT_REVIEW_REQUIRED",
      error: "ZOHO_ID_CONFLICT_REVIEW_REQUIRED",
      material_code: PAYLOAD.material_code,
      existing_zoho_item_id: "ZHO-OTHER",
      incoming_zoho_item_id: "ZHO-001",
    });
    // Critical: we MUST NOT silently overwrite.
    expect(world.updates.packagingMaterials).toEqual([]);
  });

  it("ignores missing zoho_item_id — never wipes an existing one", async () => {
    const world = freshWorld({
      materialBySku: new Map([
        [PAYLOAD.material_code, { id: "pm-pre", zohoItemId: "ZHO-PREVIOUS" }],
      ]),
      mappingByExternalId: new Map([
        [PAYLOAD.material_code, { id: "em-pre", materialItemId: "pm-pre" }],
      ]),
    });
    arm(world);

    const { zoho_item_id: _unused, ...withoutZohoId } = PAYLOAD;
    const res = await POST(makeReq(withoutZohoId));
    expect(res.status).toBe(200);
    expect(world.updates.packagingMaterials).toEqual([]);
  });
});
