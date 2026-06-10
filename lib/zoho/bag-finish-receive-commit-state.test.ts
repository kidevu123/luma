import { describe, expect, it } from "vitest";
import {
  bagFinishCommitBlockedReason,
  shouldPersistBagFinishCommitFailure,
} from "./bag-finish-receive-commit-state";

describe("shouldPersistBagFinishCommitFailure", () => {
  it("does not persist when Luma commit gate blocks before Zoho", () => {
    expect(
      shouldPersistBagFinishCommitFailure({
        ok: false,
        httpStatus: null,
        body: null,
        message:
          "Bag-finish receive commit is not authorized. Live Zoho receive commit requires PM approval.",
        guardBlocked: true,
      }),
    ).toBe(false);
  });

  it("does not persist when Zoho live-write gate returns 403", () => {
    expect(
      shouldPersistBagFinishCommitFailure({
        ok: false,
        httpStatus: 403,
        body: { error: "live_write_disabled" },
        message: "Zoho Integration Service returned HTTP 403",
        guardBlocked: false,
      }),
    ).toBe(false);
  });

  it("does not persist on network errors before reaching Zoho", () => {
    expect(
      shouldPersistBagFinishCommitFailure({
        ok: false,
        httpStatus: null,
        body: null,
        message: "Network error: timeout",
        guardBlocked: false,
      }),
    ).toBe(false);
  });

  it("persists when an authorized commit reaches Zoho and fails", () => {
    expect(
      shouldPersistBagFinishCommitFailure({
        ok: false,
        httpStatus: 422,
        body: { code: "INSUFFICIENT_PO_REMAINING" },
        message: "Zoho Integration Service returned HTTP 422",
        guardBlocked: false,
      }),
    ).toBe(true);
  });
});

describe("bagFinishCommitBlockedReason", () => {
  it("returns Luma guard message for guardBlocked", () => {
    expect(
      bagFinishCommitBlockedReason({
        ok: false,
        httpStatus: null,
        body: null,
        message: "Bag-finish receive commit is not authorized.",
        guardBlocked: true,
      }),
    ).toBe("Bag-finish receive commit is not authorized.");
  });

  it("returns live-write disabled message for 403", () => {
    expect(
      bagFinishCommitBlockedReason({
        ok: false,
        httpStatus: 403,
        body: null,
        message: "Zoho Integration Service returned HTTP 403",
        guardBlocked: false,
      }),
    ).toBe(
      "Bag-finish receive commit is not authorized. Zoho live inventory writes are disabled.",
    );
  });
});
