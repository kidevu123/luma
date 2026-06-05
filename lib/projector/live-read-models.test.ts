import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("live read-model coverage repair", () => {
  const src = readFileSync(join(__dirname, "live-read-models.ts"), "utf8");

  it("seeds empty station-live rows for active stations without overwriting live pins", () => {
    expect(src).toMatch(/FROM stations s/);
    expect(src).toMatch(/WHERE s\.is_active = true/);
    expect(src).toMatch(/ON CONFLICT \(station_id\) DO NOTHING/);
  });

  it("repairs only missing bag-state rows from source workflow tables", () => {
    expect(src).toMatch(/LEFT JOIN read_bag_state rbs/);
    expect(src).toMatch(/WHERE rbs\.workflow_bag_id IS NULL/);
    expect(src).toMatch(/FROM workflow_bags wb/);
    expect(src).toMatch(/FROM workflow_events we/);
    expect(src).toMatch(/'STARTED'\) AS stage/);
    expect(src).toMatch(/ON CONFLICT \(workflow_bag_id\) DO NOTHING/);
  });
});
