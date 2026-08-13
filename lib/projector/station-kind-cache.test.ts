// P4a Task 5 — pure test for the in-process stationId -> kind cache.
// No DB: the loader is injected, so this never touches @/lib/db.

import { describe, expect, it } from "vitest";
import { getStationKind, type StationKindLoader } from "./station-kind-cache";

type Tx = Parameters<typeof getStationKind>[0];

const fakeTx = {} as Tx;

function countingLoader(kinds: Record<string, string>): {
  loader: StationKindLoader;
  fetchCount: () => number;
} {
  let fetches = 0;
  const loader: StationKindLoader = async (_tx, stationId) => {
    fetches += 1;
    return kinds[stationId] ?? null;
  };
  return { loader, fetchCount: () => fetches };
}

describe("getStationKind", () => {
  it("memoizes: a second lookup for the same station fetches zero times", async () => {
    const stationId = "11111111-1111-1111-1111-111111111111";
    const { loader, fetchCount } = countingLoader({ [stationId]: "BLISTER" });

    const first = await getStationKind(fakeTx, stationId, loader);
    expect(first).toBe("BLISTER");
    expect(fetchCount()).toBe(1);

    const second = await getStationKind(fakeTx, stationId, loader);
    expect(second).toBe("BLISTER");
    expect(fetchCount()).toBe(1);
  });

  it("returns null for an unknown station and does not throw", async () => {
    const stationId = "22222222-2222-2222-2222-222222222222";
    const { loader, fetchCount } = countingLoader({});

    const result = await getStationKind(fakeTx, stationId, loader);
    expect(result).toBeNull();
    expect(fetchCount()).toBe(1);

    // Unknown-but-null is also memoized: no second fetch.
    const again = await getStationKind(fakeTx, stationId, loader);
    expect(again).toBeNull();
    expect(fetchCount()).toBe(1);
  });
});
