import { describe, it, expect } from "vitest";
import {
  buildDryRunIdempotencyKey,
  buildTabletReceivePayload,
  buildAssemblyPayload,
  type TabletReceiveInput,
  type AssemblyInput,
} from "./operation-payloads";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_TABLET_INPUT: TabletReceiveInput = {
  opId: "op-111",
  finishedLotId: "lot-222",
  sourceInventoryBagId: "bag-333",
  zohoTabletItemId: "zoho-item-444",
  zohoPoId: "zoho-po-555",
  zohoLineItemId: "zoho-line-666",
  quantity: 1000,
  date: "2026-05-19",
  internalIdempotencyKey: "internal-key-abc",
};

const BASE_ASSEMBLY_INPUT: AssemblyInput = {
  opId: "op-777",
  finishedLotId: "lot-888",
  opKind: "UNIT_ASSEMBLE",
  zohoCompositeItemId: "zoho-composite-999",
  quantity: 500,
  date: "2026-05-19",
  upstreamReceiveOpId: "op-111",
  upstreamAssemblyOpId: null,
};

// ---------------------------------------------------------------------------
// buildDryRunIdempotencyKey
// ---------------------------------------------------------------------------

describe("buildDryRunIdempotencyKey", () => {
  it("TABLET_RECEIVE returns luma-purchase-receive-<id>", () => {
    expect(buildDryRunIdempotencyKey("abc123", "TABLET_RECEIVE")).toBe(
      "luma-purchase-receive-abc123",
    );
  });

  it("UNIT_ASSEMBLE returns luma-assembly-<id>", () => {
    expect(buildDryRunIdempotencyKey("abc123", "UNIT_ASSEMBLE")).toBe(
      "luma-assembly-abc123",
    );
  });

  it("DISPLAY_ASSEMBLE returns luma-assembly-<id>", () => {
    expect(buildDryRunIdempotencyKey("abc123", "DISPLAY_ASSEMBLE")).toBe(
      "luma-assembly-abc123",
    );
  });

  it("CASE_ASSEMBLE returns luma-assembly-<id>", () => {
    expect(buildDryRunIdempotencyKey("abc123", "CASE_ASSEMBLE")).toBe(
      "luma-assembly-abc123",
    );
  });
});

// ---------------------------------------------------------------------------
// buildTabletReceivePayload — ok cases
// ---------------------------------------------------------------------------

describe("buildTabletReceivePayload — ok cases", () => {
  it("all fields present → ok: true with correct payload shape", () => {
    const result = buildTabletReceivePayload(BASE_TABLET_INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.payload.dry_run).toBe(true);
    expect(result.payload.luma_operation_id).toBe("op-111");
    expect(result.payload.luma_workflow_session_id).toBe("lot-222");
    expect(result.payload.luma_bag_id).toBe("bag-333");
    expect(result.payload.purchaseorder_id).toBe("zoho-po-555");
    expect(result.payload.date).toBe("2026-05-19");
    expect(result.payload.line_items).toHaveLength(1);
    const li = result.payload.line_items[0]!;
    expect(li.item_id).toBe("zoho-item-444");
    expect(li.line_item_id).toBe("zoho-line-666");
    expect(li.quantity).toBe(1000);
    expect(li.unit).toBe("pcs");
    expect(result.warnings).toHaveLength(0);
  });

  it("zohoLineItemId null → ok: true, warning on line_items[0].line_item_id, payload line_item_id is null", () => {
    const input: TabletReceiveInput = {
      ...BASE_TABLET_INPUT,
      zohoLineItemId: null,
    };
    const result = buildTabletReceivePayload(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.payload.line_items[0]!.line_item_id).toBeNull();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe("line_items[0].line_item_id");
  });

  it("sourceInventoryBagId null → ok: true, warning on luma_bag_id, payload luma_bag_id is null", () => {
    const input: TabletReceiveInput = {
      ...BASE_TABLET_INPUT,
      sourceInventoryBagId: null,
    };
    const result = buildTabletReceivePayload(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.payload.luma_bag_id).toBeNull();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe("luma_bag_id");
  });

  it("both zohoLineItemId and sourceInventoryBagId null → ok: true with two warnings", () => {
    const input: TabletReceiveInput = {
      ...BASE_TABLET_INPUT,
      zohoLineItemId: null,
      sourceInventoryBagId: null,
    };
    const result = buildTabletReceivePayload(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.warnings).toHaveLength(2);
    const fields = result.warnings.map((w) => w.field);
    expect(fields).toContain("line_items[0].line_item_id");
    expect(fields).toContain("luma_bag_id");
  });
});

// ---------------------------------------------------------------------------
// buildTabletReceivePayload — blocker cases
// ---------------------------------------------------------------------------

describe("buildTabletReceivePayload — blocker cases", () => {
  it("zohoPoId null → ok: false, blocker on purchaseorder_id", () => {
    const input: TabletReceiveInput = { ...BASE_TABLET_INPUT, zohoPoId: null };
    const result = buildTabletReceivePayload(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]!.field).toBe("purchaseorder_id");
  });

  it("zohoTabletItemId null → ok: false, blocker on line_items[0].item_id", () => {
    const input: TabletReceiveInput = {
      ...BASE_TABLET_INPUT,
      zohoTabletItemId: null,
    };
    const result = buildTabletReceivePayload(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]!.field).toBe("line_items[0].item_id");
  });

  it("both zohoPoId and zohoTabletItemId null → ok: false, two blockers", () => {
    const input: TabletReceiveInput = {
      ...BASE_TABLET_INPUT,
      zohoPoId: null,
      zohoTabletItemId: null,
    };
    const result = buildTabletReceivePayload(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.blockers).toHaveLength(2);
    const fields = result.blockers.map((b) => b.field);
    expect(fields).toContain("purchaseorder_id");
    expect(fields).toContain("line_items[0].item_id");
  });

  it("zohoPoId empty string → ok: false, blocker on purchaseorder_id", () => {
    const input: TabletReceiveInput = { ...BASE_TABLET_INPUT, zohoPoId: "" };
    const result = buildTabletReceivePayload(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.blockers[0]!.field).toBe("purchaseorder_id");
  });
});

// ---------------------------------------------------------------------------
// buildAssemblyPayload — ok cases
// ---------------------------------------------------------------------------

describe("buildAssemblyPayload — ok cases", () => {
  it("UNIT_ASSEMBLE → ok: true, assembly_level = unit, dry_run: true", () => {
    const result = buildAssemblyPayload({
      ...BASE_ASSEMBLY_INPUT,
      opKind: "UNIT_ASSEMBLE",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.payload.dry_run).toBe(true);
    expect(result.payload.assembly_level).toBe("unit");
    expect(result.payload.is_backorder_allowed).toBe(false);
    expect(result.payload.luma_operation_id).toBe("op-777");
    expect(result.payload.luma_workflow_session_id).toBe("lot-888");
    expect(result.payload.composite_item_id).toBe("zoho-composite-999");
    expect(result.payload.quantity).toBe(500);
    expect(result.payload.date).toBe("2026-05-19");
    expect(result.warnings).toHaveLength(0);
  });

  it("DISPLAY_ASSEMBLE → assembly_level = display", () => {
    const result = buildAssemblyPayload({
      ...BASE_ASSEMBLY_INPUT,
      opKind: "DISPLAY_ASSEMBLE",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.payload.assembly_level).toBe("display");
  });

  it("CASE_ASSEMBLE → assembly_level = case", () => {
    const result = buildAssemblyPayload({
      ...BASE_ASSEMBLY_INPUT,
      opKind: "CASE_ASSEMBLE",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.payload.assembly_level).toBe("case");
  });

  it("upstream_receive_id passes through from input", () => {
    const result = buildAssemblyPayload({
      ...BASE_ASSEMBLY_INPUT,
      upstreamReceiveOpId: "recv-op-123",
      upstreamAssemblyOpId: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.payload.upstream_receive_id).toBe("recv-op-123");
    expect(result.payload.upstream_assembly_id).toBeNull();
  });

  it("upstream_assembly_id passes through from input", () => {
    const result = buildAssemblyPayload({
      ...BASE_ASSEMBLY_INPUT,
      opKind: "DISPLAY_ASSEMBLE",
      upstreamReceiveOpId: "recv-op-123",
      upstreamAssemblyOpId: "unit-op-456",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.payload.upstream_assembly_id).toBe("unit-op-456");
  });

  it("both upstream IDs null pass through as null", () => {
    const result = buildAssemblyPayload({
      ...BASE_ASSEMBLY_INPUT,
      upstreamReceiveOpId: null,
      upstreamAssemblyOpId: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.payload.upstream_receive_id).toBeNull();
    expect(result.payload.upstream_assembly_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildAssemblyPayload — blocker cases
// ---------------------------------------------------------------------------

describe("buildAssemblyPayload — blocker cases", () => {
  it("zohoCompositeItemId null → ok: false, blocker on composite_item_id", () => {
    const result = buildAssemblyPayload({
      ...BASE_ASSEMBLY_INPUT,
      zohoCompositeItemId: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]!.field).toBe("composite_item_id");
    expect(result.blockers[0]!.message).toContain(
      "Zoho composite item ID not mapped",
    );
  });

  it("zohoCompositeItemId empty string → ok: false, blocker on composite_item_id", () => {
    const result = buildAssemblyPayload({
      ...BASE_ASSEMBLY_INPUT,
      zohoCompositeItemId: "",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.blockers[0]!.field).toBe("composite_item_id");
  });
});

// ---------------------------------------------------------------------------
// Type safety checks (runtime verification of literal types)
// ---------------------------------------------------------------------------

describe("type safety — literal constants", () => {
  it("PurchaseReceivePayload dry_run is exactly true (not just boolean)", () => {
    const result = buildTabletReceivePayload(BASE_TABLET_INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Verify it is strictly true (not false, not any other truthy value)
    expect(result.payload.dry_run).toStrictEqual(true);
  });

  it("AssemblyPayload dry_run is exactly true", () => {
    const result = buildAssemblyPayload(BASE_ASSEMBLY_INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.payload.dry_run).toStrictEqual(true);
  });

  it("AssemblyPayload is_backorder_allowed is exactly false", () => {
    const result = buildAssemblyPayload(BASE_ASSEMBLY_INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.payload.is_backorder_allowed).toStrictEqual(false);
  });
});
