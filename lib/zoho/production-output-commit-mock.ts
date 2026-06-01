/**
 * C3a mock-only production-output commit gateway.
 * No network I/O — for unit tests and future C3b wiring only.
 */

export type MockProductionOutputCommitFixture =
  | {
      outcome: "success";
      externalReferenceId?: string;
      body?: unknown;
    }
  | {
      outcome: "failure";
      message: string;
      httpStatus?: number;
      body?: unknown;
    };

export type MockProductionOutputCommitInput = {
  requestPayload: Record<string, unknown>;
  commitIdempotencyKey: string;
  fixture: MockProductionOutputCommitFixture;
};

export type MockProductionOutputCommitSuccess = {
  ok: true;
  idempotencyKey: string;
  requestPayload: Record<string, unknown>;
  externalReferenceId: string | null;
  body: unknown;
};

export type MockProductionOutputCommitFailure = {
  ok: false;
  idempotencyKey: string;
  requestPayload: Record<string, unknown>;
  httpStatus: number | null;
  message: string;
  body: unknown;
};

export type MockProductionOutputCommitResult =
  | MockProductionOutputCommitSuccess
  | MockProductionOutputCommitFailure;

/**
 * Simulates a Zoho production-output commit without HTTP.
 * Always echoes the stored request payload and idempotency key for verification.
 */
export function mockCallZohoProductionOutputCommit(
  input: MockProductionOutputCommitInput,
): MockProductionOutputCommitResult {
  const base = {
    idempotencyKey: input.commitIdempotencyKey,
    requestPayload: input.requestPayload,
  };

  if (input.fixture.outcome === "success") {
    return {
      ok: true,
      ...base,
      externalReferenceId: input.fixture.externalReferenceId ?? "mock-zoho-ref-1",
      body: input.fixture.body ?? {
        mock: true,
        committed: true,
        idempotency_key: input.commitIdempotencyKey,
      },
    };
  }

  return {
    ok: false,
    ...base,
    httpStatus: input.fixture.httpStatus ?? 422,
    message: input.fixture.message,
    body: input.fixture.body ?? {
      mock: true,
      error: input.fixture.message,
    },
  };
}
