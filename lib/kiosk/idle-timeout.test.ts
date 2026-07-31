import { describe, expect, it } from "vitest";
import { STATION_OPERATOR_SESSION_IDLE_TIMEOUT_MINUTES } from "@/lib/production/station-operator-session";
import {
  STATION_OPERATOR_SESSION_IDLE_TIMEOUT_MS,
  isOperatorSessionIdle,
} from "./idle-timeout";

describe("STATION_OPERATOR_SESSION_IDLE_TIMEOUT", () => {
  it("is 20 minutes by default", () => {
    expect(STATION_OPERATOR_SESSION_IDLE_TIMEOUT_MINUTES).toBe(20);
    expect(STATION_OPERATOR_SESSION_IDLE_TIMEOUT_MS).toBe(20 * 60 * 1000);
  });
});

describe("isOperatorSessionIdle", () => {
  const timeout = 20 * 60 * 1000;
  const base = 1_700_000_000_000;

  it("returns false when activity is recent", () => {
    expect(isOperatorSessionIdle(base, base + timeout - 1, timeout)).toBe(
      false,
    );
  });

  it("returns true exactly at the timeout boundary", () => {
    expect(isOperatorSessionIdle(base, base + timeout, timeout)).toBe(true);
  });

  it("returns true when past the timeout", () => {
    expect(isOperatorSessionIdle(base, base + timeout + 1, timeout)).toBe(
      true,
    );
  });

  it("returns false for non-finite timestamps", () => {
    expect(isOperatorSessionIdle(Number.NaN, base, timeout)).toBe(false);
    expect(isOperatorSessionIdle(base, Number.POSITIVE_INFINITY, timeout)).toBe(
      false,
    );
  });

  it("returns false when timeoutMs is non-positive", () => {
    expect(isOperatorSessionIdle(base, base + 10_000, 0)).toBe(false);
    expect(isOperatorSessionIdle(base, base + 10_000, -1)).toBe(false);
  });

  it("uses the module default timeout when omitted", () => {
    expect(
      isOperatorSessionIdle(base, base + STATION_OPERATOR_SESSION_IDLE_TIMEOUT_MS),
    ).toBe(true);
    expect(
      isOperatorSessionIdle(
        base,
        base + STATION_OPERATOR_SESSION_IDLE_TIMEOUT_MS - 1,
      ),
    ).toBe(false);
  });
});
