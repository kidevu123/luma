// Pure-function tests for the production-output commit wrapper.
// The stateful end-to-end (claim/gateway/transition) lives behind the
// DB and is covered by integration tests in Phase H once the DB-mock
// pattern from zoho-production-output.test.ts is extended.

import { describe, expect, it } from "vitest";
import { buildProductionOutputCommitIdempotencyKey } from "./shared-production-output-commit";

describe("buildProductionOutputCommitIdempotencyKey", () => {
  it("derives a stable namespaced key from the luma operation id", () => {
    // pop- = production-output prefix so logs can distinguish key kinds
    // at a glance from the rbg- raw-bag prefix.
    expect(buildProductionOutputCommitIdempotencyKey("op-1", 1)).toBe("pop-op-1");
  });

  it("ignores attemptCount today — same key on every retry is the point", () => {
    // The gateway dedupes by idempotency key, so two replays of the
    // same operation share the same key (replay returns prior result,
    // never a double-write). If we ever wanted a "force fresh retry"
    // path we'd build a different key here, intentionally.
    expect(buildProductionOutputCommitIdempotencyKey("op-1", 1)).toBe(
      buildProductionOutputCommitIdempotencyKey("op-1", 5),
    );
  });

  it("different operations produce different keys", () => {
    expect(buildProductionOutputCommitIdempotencyKey("op-1", 1)).not.toBe(
      buildProductionOutputCommitIdempotencyKey("op-2", 1),
    );
  });
});
