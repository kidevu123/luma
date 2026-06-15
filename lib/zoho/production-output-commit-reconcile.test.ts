import { describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import {
  finalizeAfterReplayAttempt,
  reconcileProductionOutputCommitAfterGatewayFailure,
} from "@/lib/zoho/production-output-commit-reconcile";
import type { ProductionOutputPreviewPayload } from "@/lib/zoho/production-output-preview";

const ACTOR: CurrentUser = {
  id: "admin-1",
  email: "admin@example.com",
  role: "OWNER",
  employeeId: null,
};

const SWEET_TRIP_LOT = "79c41fa1-7267-4911-9017-8565039290be";
const SWEET_TRIP_BUNDLE = "5254962000006782128";
const OP_ID = "7bef5edc-2010-4834-815c-8fcc999e4945";

const servicePayload: ProductionOutputPreviewPayload = {
  purchaseorder_id: "5254962000005946455",
  purchaseorder_line_item_id: "5254962000005946461",
  quantity_good: 10,
  receive_date: "2026-06-15",
  warehouse_id: "",
  unit_composite_item_id: "5254962000006219038",
  unit_assembly_quantity: 10,
  luma_operation_id: `luma-production-output:${SWEET_TRIP_LOT}`,
  quantity_damaged: 0,
  quantity_ripped: 0,
  quantity_loose: 0,
  display_assembly_quantity: 0,
  case_assembly_quantity: 0,
  assembly_only: true,
};

const successBody = {
  committed: true,
  planned_commit_sequence: ["unit_assembly"],
  steps: [
    {
      step: "unit_assembly",
      status: "succeeded",
      zoho_entity_id: SWEET_TRIP_BUNDLE,
      zoho_entity_type: "bundle",
    },
  ],
};

const completeSuccess = vi.fn(
  async (_opId: string, _actor: unknown, _input: unknown) => ({
    ok: true as const,
    op: {
      id: OP_ID,
      status: "COMMITTED",
      zohoBundleIds: [SWEET_TRIP_BUNDLE],
    },
  }),
);

const completeFailure = vi.fn(
  async (_opId: string, _actor: unknown, _input: unknown) => ({
    ok: true as const,
    op: { id: OP_ID, status: "FAILED", commitError: "failed" },
  }),
);

const completeAmbiguous = vi.fn(
  async (_opId: string, _actor: unknown, _input: unknown) => ({
    ok: true as const,
    op: {
      id: OP_ID,
      status: "FAILED",
      commitStatus: "ambiguous_needs_review",
      commitError: "ambiguous",
    },
  }),
);

vi.mock("@/lib/db/queries/zoho-production-output", () => ({
  completeZohoProductionOutputCommitSuccess: (
    opId: string,
    actor: unknown,
    input: unknown,
  ) => completeSuccess(opId, actor, input),
  completeZohoProductionOutputCommitFailure: (
    opId: string,
    actor: unknown,
    input: unknown,
  ) => completeFailure(opId, actor, input),
  completeZohoProductionOutputCommitAmbiguous: (
    opId: string,
    actor: unknown,
    input: unknown,
  ) => completeAmbiguous(opId, actor, input),
}));

vi.mock("@/lib/zoho/production-output-service-client", () => ({
  callProductionOutputCommit: vi.fn(),
}));

import { callProductionOutputCommit } from "@/lib/zoho/production-output-service-client";

describe("finalizeAfterReplayAttempt", () => {
  it("reconciles to COMMITTED when replay returns success body", async () => {
    const result = await finalizeAfterReplayAttempt({
      opId: OP_ID,
      actor: ACTOR,
      replay: {
        ok: true,
        httpStatus: 200,
        body: successBody,
        externalReferenceId: null,
        idempotencyReplay: true,
      },
      initial: {
        ok: false,
        kind: "network",
        httpStatus: null,
        body: null,
        message: "fetch failed",
        idempotencyReplay: null,
      },
      servicePayloadHash: "abc",
    });
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.reconciled).toBe(true);
    expect(completeSuccess).toHaveBeenCalled();
  });

  it("marks ambiguous on idempotency conflict replay", async () => {
    const result = await finalizeAfterReplayAttempt({
      opId: OP_ID,
      actor: ACTOR,
      replay: {
        ok: false,
        kind: "service",
        httpStatus: 409,
        body: { detail: { error: { code: "ZOHO_IDEMPOTENCY_CONFLICT" } } },
        message: "conflict",
        idempotencyReplay: null,
      },
      initial: {
        ok: false,
        kind: "service",
        httpStatus: 409,
        body: { detail: { error: { code: "ZOHO_IDEMPOTENCY_CONFLICT" } } },
        message: "conflict",
        idempotencyReplay: null,
      },
      servicePayloadHash: "abc",
    });
    expect(result.kind).toBe("ambiguous");
    expect(completeAmbiguous).toHaveBeenCalled();
  });
});

describe("reconcileProductionOutputCommitAfterGatewayFailure", () => {
  it("reconciles when initial failure is idempotency replay success", async () => {
    const result = await reconcileProductionOutputCommitAfterGatewayFailure({
      opId: OP_ID,
      actor: ACTOR,
      idempotencyKey: `luma-production-output:${SWEET_TRIP_LOT}`,
      servicePayload,
      servicePayloadHash: "hash",
      initial: {
        ok: false,
        kind: "service",
        httpStatus: 409,
        body: successBody,
        message: "conflict",
        idempotencyReplay: true,
      },
    });
    expect(result.kind).toBe("success");
  });

  it("does not blindly retry when guard blocked", async () => {
    const result = await reconcileProductionOutputCommitAfterGatewayFailure({
      opId: OP_ID,
      actor: ACTOR,
      idempotencyKey: `luma-production-output:${SWEET_TRIP_LOT}`,
      servicePayload,
      servicePayloadHash: "hash",
      initial: {
        ok: false,
        kind: "guard",
        httpStatus: null,
        body: null,
        message: "disabled",
        idempotencyReplay: null,
      },
    });
    expect(result.kind).toBe("failed");
    expect(vi.mocked(callProductionOutputCommit)).not.toHaveBeenCalled();
  });
});

describe("409 after successful Zoho commit (Sweet Trip class)", () => {
  it("network failure then replay success reconciles bundle id", async () => {
    vi.mocked(callProductionOutputCommit).mockResolvedValueOnce({
      ok: true,
      httpStatus: 200,
      body: successBody,
      externalReferenceId: null,
      idempotencyReplay: true,
    });

    const result = await reconcileProductionOutputCommitAfterGatewayFailure({
      opId: OP_ID,
      actor: ACTOR,
      idempotencyKey: `luma-production-output:${SWEET_TRIP_LOT}`,
      servicePayload,
      servicePayloadHash: "hash",
      initial: {
        ok: false,
        kind: "network",
        httpStatus: null,
        body: null,
        message: "fetch failed",
        idempotencyReplay: null,
      },
    });

    expect(result.kind).toBe("success");
    expect(completeSuccess).toHaveBeenCalled();
  });
});
