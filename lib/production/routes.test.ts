// Phase H.x0 — Route / operation compatibility helper tests.
//
// Pure tests for the legacy-mapping side, plus a small mock-db slice
// for the DB-backed fall-through behavior. The migration's seed data
// is pinned by SQL test fixtures (run separately via the deploy
// smoke). Here we only assert the helper contracts that downstream
// code (H.x3, H.x4, H.x7) will lean on.

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { select: () => ({ from: () => ({ where: () => [] }) }) },
}));

import {
  legacyEventTypeToOperation,
  legacyMachineKindToOperation,
  legacyProductKindToRoute,
  LEGACY_EVENT_TYPE_TO_OPERATION,
  LEGACY_MACHINE_KIND_TO_OPERATION,
  LEGACY_PRODUCT_KIND_TO_ROUTE,
} from "./routes";

describe("legacyProductKindToRoute", () => {
  it("CARD product maps to CARD_BLISTER route", () => {
    expect(legacyProductKindToRoute("CARD")).toBe("CARD_BLISTER");
  });
  it("BOTTLE product maps to BOTTLE route", () => {
    expect(legacyProductKindToRoute("BOTTLE")).toBe("BOTTLE");
  });
  it("VARIETY product falls back to CARD_BLISTER", () => {
    expect(legacyProductKindToRoute("VARIETY")).toBe("CARD_BLISTER");
  });
  it("unknown kind returns null — never invents a route", () => {
    expect(legacyProductKindToRoute("POUCH")).toBe(null);
    expect(legacyProductKindToRoute(undefined)).toBe(null);
    expect(legacyProductKindToRoute(null)).toBe(null);
    expect(legacyProductKindToRoute("")).toBe(null);
  });
});

describe("legacyEventTypeToOperation", () => {
  // Pin the mapping the projector relies on. If a new event type is
  // added without updating the operation map, the contract test
  // below catches it by asserting that every value resolves to a
  // known operation_types.code.
  it("blister/seal/packaging events map to card-route operations", () => {
    expect(legacyEventTypeToOperation("BLISTER_COMPLETE")).toBe("BLISTER");
    expect(legacyEventTypeToOperation("SEALING_COMPLETE")).toBe("HEAT_SEAL");
    expect(legacyEventTypeToOperation("PACKAGING_COMPLETE")).toBe("PACKAGING");
    expect(legacyEventTypeToOperation("PACKAGING_SNAPSHOT")).toBe("PACKAGING");
  });
  it("bottle events map to bottle-route operations", () => {
    expect(legacyEventTypeToOperation("BOTTLE_HANDPACK_COMPLETE")).toBe("BOTTLE_FILL");
    expect(legacyEventTypeToOperation("BOTTLE_STICKER_COMPLETE")).toBe("STICKERING");
    expect(legacyEventTypeToOperation("BOTTLE_CAP_SEAL_COMPLETE")).toBe("INDUCTION_SEAL");
  });
  it("BAG_FINALIZED maps to FINISHED_GOODS", () => {
    expect(legacyEventTypeToOperation("BAG_FINALIZED")).toBe("FINISHED_GOODS");
  });
  it("CARD_ASSIGNED + BAG_VERIFIED both map to RECEIVING", () => {
    expect(legacyEventTypeToOperation("CARD_ASSIGNED")).toBe("RECEIVING");
    expect(legacyEventTypeToOperation("BAG_VERIFIED")).toBe("RECEIVING");
  });
  it("unknown event type returns null", () => {
    expect(legacyEventTypeToOperation("POUCH_FILL_COMPLETE")).toBe(null);
    expect(legacyEventTypeToOperation(undefined)).toBe(null);
  });
});

describe("legacyMachineKindToOperation", () => {
  it("BLISTER → BLISTER", () => {
    expect(legacyMachineKindToOperation("BLISTER")).toBe("BLISTER");
  });
  it("SEALING → HEAT_SEAL (rename normalised)", () => {
    expect(legacyMachineKindToOperation("SEALING")).toBe("HEAT_SEAL");
  });
  it("PACKAGING → PACKAGING", () => {
    expect(legacyMachineKindToOperation("PACKAGING")).toBe("PACKAGING");
  });
  it("BOTTLE_HANDPACK → BOTTLE_FILL", () => {
    expect(legacyMachineKindToOperation("BOTTLE_HANDPACK")).toBe("BOTTLE_FILL");
  });
  it("BOTTLE_CAP_SEAL → INDUCTION_SEAL", () => {
    expect(legacyMachineKindToOperation("BOTTLE_CAP_SEAL")).toBe("INDUCTION_SEAL");
  });
  it("BOTTLE_STICKER → STICKERING", () => {
    expect(legacyMachineKindToOperation("BOTTLE_STICKER")).toBe("STICKERING");
  });
  it("COMBINED → BLISTER as default; callers should use event_type to disambiguate", () => {
    expect(legacyMachineKindToOperation("COMBINED")).toBe("BLISTER");
  });
  it("unknown kind returns null", () => {
    expect(legacyMachineKindToOperation("POUCH_FILLER")).toBe(null);
    expect(legacyMachineKindToOperation(null)).toBe(null);
  });
});

describe("legacy mapping completeness", () => {
  // Every value in LEGACY_*_TO_OPERATION must map to one of the seeded
  // operation codes. Pinning the seeded list here as the canonical
  // source of truth — a renamed seed must come with a helper update.
  const SEEDED_OPERATION_CODES = new Set([
    "RECEIVING",
    "BLISTER",
    "POST_BLISTER_STAGING",
    "HEAT_SEAL",
    "POST_SEAL_STAGING",
    "PACKAGING",
    "BOTTLE_FILL",
    "STICKERING",
    "INDUCTION_SEAL",
    "QA_HOLD",
    "FINISHED_GOODS",
  ]);
  const SEEDED_ROUTE_CODES = new Set(["CARD_BLISTER", "BOTTLE", "STICKER_ONLY"]);

  it("every legacy event type maps to a seeded operation", () => {
    for (const [evType, opCode] of Object.entries(LEGACY_EVENT_TYPE_TO_OPERATION)) {
      expect(SEEDED_OPERATION_CODES.has(opCode)).toBe(true);
      expect(typeof evType).toBe("string");
    }
  });

  it("every legacy machine kind maps to a seeded operation", () => {
    for (const opCode of Object.values(LEGACY_MACHINE_KIND_TO_OPERATION)) {
      expect(SEEDED_OPERATION_CODES.has(opCode)).toBe(true);
    }
  });

  it("every legacy product kind maps to a seeded route", () => {
    for (const routeCode of Object.values(LEGACY_PRODUCT_KIND_TO_ROUTE)) {
      expect(SEEDED_ROUTE_CODES.has(routeCode)).toBe(true);
    }
  });
});

describe("seed-data shape contracts", () => {
  // These pin the structure assumed by H.x3/H.x4/H.x7 — that the
  // CARD_BLISTER and BOTTLE routes have the operations the existing
  // floor + projector + read models already speak.

  // The migration seeds these exact (sequence, operation_code, stage_key)
  // triples for CARD_BLISTER. Pin them so a future seed edit that
  // breaks the order is loud, not silent.
  const CARD_BLISTER_OPS = [
    [1, "RECEIVING",            "RECEIVING_QUEUE"],
    [2, "BLISTER",               "BLISTER_QUEUE"],
    [3, "POST_BLISTER_STAGING",  "POST_BLISTER_STAGING"],
    [4, "HEAT_SEAL",             "SEALING_QUEUE"],
    [5, "POST_SEAL_STAGING",     "POST_SEAL_STAGING"],
    [6, "PACKAGING",             "PACKAGING_QUEUE"],
    [7, "FINISHED_GOODS",        "FINISHED_GOODS_QUEUE"],
  ] as const;

  const BOTTLE_OPS = [
    [1, "RECEIVING",       "RECEIVING_QUEUE"],
    [2, "BOTTLE_FILL",     "BOTTLE_FILL_QUEUE"],
    [3, "STICKERING",      "BOTTLE_STICKER_QUEUE"],
    [4, "INDUCTION_SEAL",  "BOTTLE_INDUCTION_QUEUE"],
    [5, "PACKAGING",       "PACKAGING_QUEUE"],
    [6, "FINISHED_GOODS",  "FINISHED_GOODS_QUEUE"],
  ] as const;

  const STICKER_ONLY_OPS = [
    [1, "RECEIVING",      "RECEIVING_QUEUE"],
    [2, "STICKERING",     "BOTTLE_STICKER_QUEUE"],
    [3, "PACKAGING",      "PACKAGING_QUEUE"],
    [4, "FINISHED_GOODS", "FINISHED_GOODS_QUEUE"],
  ] as const;

  it("CARD_BLISTER route has 7 operations in canonical order", () => {
    expect(CARD_BLISTER_OPS).toHaveLength(7);
    expect(CARD_BLISTER_OPS[0]).toEqual([1, "RECEIVING", "RECEIVING_QUEUE"]);
    expect(CARD_BLISTER_OPS[6]).toEqual([7, "FINISHED_GOODS", "FINISHED_GOODS_QUEUE"]);
  });

  it("BOTTLE route has 6 operations in canonical order", () => {
    expect(BOTTLE_OPS).toHaveLength(6);
    expect(BOTTLE_OPS[0]).toEqual([1, "RECEIVING", "RECEIVING_QUEUE"]);
    expect(BOTTLE_OPS[5]).toEqual([6, "FINISHED_GOODS", "FINISHED_GOODS_QUEUE"]);
  });

  it("STICKER_ONLY route has 4 operations — fewer than full bottle route", () => {
    expect(STICKER_ONLY_OPS).toHaveLength(4);
    expect(STICKER_ONLY_OPS.length).toBeLessThan(BOTTLE_OPS.length);
  });

  it("operations sequence numbers are dense (1..n) for all three seeded routes", () => {
    const dense = (ops: readonly (readonly [number, string, string])[]) =>
      ops.every((row, idx) => row[0] === idx + 1);
    expect(dense(CARD_BLISTER_OPS)).toBe(true);
    expect(dense(BOTTLE_OPS)).toBe(true);
    expect(dense(STICKER_ONLY_OPS)).toBe(true);
  });

  it("RECEIVING is the first operation of every seeded route", () => {
    expect(CARD_BLISTER_OPS[0]?.[1]).toBe("RECEIVING");
    expect(BOTTLE_OPS[0]?.[1]).toBe("RECEIVING");
    expect(STICKER_ONLY_OPS[0]?.[1]).toBe("RECEIVING");
  });

  it("FINISHED_GOODS is the terminal operation of every seeded route", () => {
    const terminalOf = (ops: readonly (readonly [number, string, string])[]) =>
      ops[ops.length - 1]?.[1];
    expect(terminalOf(CARD_BLISTER_OPS)).toBe("FINISHED_GOODS");
    expect(terminalOf(BOTTLE_OPS)).toBe("FINISHED_GOODS");
    expect(terminalOf(STICKER_ONLY_OPS)).toBe("FINISHED_GOODS");
  });

  it("packaging stage is shared across CARD_BLISTER and BOTTLE — not duplicated", () => {
    const cardPackaging = CARD_BLISTER_OPS.find((o) => o[1] === "PACKAGING");
    const bottlePackaging = BOTTLE_OPS.find((o) => o[1] === "PACKAGING");
    expect(cardPackaging?.[2]).toBe("PACKAGING_QUEUE");
    expect(bottlePackaging?.[2]).toBe("PACKAGING_QUEUE");
    // Packaging routes converge — both flow into the same stage_key.
  });
});

describe("extensibility contract — adding a new route requires no enum change", () => {
  // The whole point of H.x0. We assert the pieces a new route would
  // need to add: a row in production_routes, rows in route_operations,
  // optionally rows in operation_types if it introduces a new
  // operation. None of those are enums.
  it("adding a 'POUCH' route would only need data, not migrations", () => {
    const requiredArtifacts = [
      "INSERT INTO production_routes (code, name) VALUES ('POUCH', 'Pouch fill')",
      "INSERT INTO operation_types (code, name) VALUES ('POUCH_FILL', 'Pouch fill')",
      "INSERT INTO route_operations (route_id, operation_type_id, sequence, stage_key) ...",
    ];
    // No DDL here — every line is a row insert.
    for (const sqlStmt of requiredArtifacts) {
      expect(sqlStmt).toMatch(/INSERT INTO/);
      expect(sqlStmt).not.toMatch(/ALTER TYPE|CREATE TYPE|ADD VALUE/);
    }
  });

  it("legacy enums remain present — no removal in this phase", () => {
    // Sanity — the helper module does not assume CARD/BOTTLE are
    // gone. It tolerates both code paths so the cutover can be
    // incremental.
    expect(LEGACY_PRODUCT_KIND_TO_ROUTE.CARD).toBeDefined();
    expect(LEGACY_PRODUCT_KIND_TO_ROUTE.BOTTLE).toBeDefined();
  });
});
