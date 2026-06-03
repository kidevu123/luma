import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const pageSrc = readFileSync(join(__dirname, "page.tsx"), "utf8");
const sidebarSrc = readFileSync(
  join(process.cwd(), "components/admin/sidebar.tsx"),
  "utf8",
);

describe("PARTIAL-BAG-RESTART · /production/start", () => {
  it("redirects to floor-board when inventoryBagId is absent", () => {
    expect(pageSrc).toMatch(/redirect\("\/floor-board"\)/);
  });

  it("renders StartProductionForm when inventoryBagId is present", () => {
    expect(pageSrc).toMatch(/StartProductionForm/);
    expect(pageSrc).toMatch(/initialInventoryBagId/);
    expect(pageSrc).toMatch(/requireLead/);
  });
});

describe("STATION-NAV-CLEANUP-1 · admin sidebar", () => {
  it("does not promote Start production in Operations", () => {
    expect(sidebarSrc).not.toMatch(/href:\s*"\/production\/start"/);
  });

  it("still links Production output", () => {
    expect(sidebarSrc).toMatch(/href:\s*"\/packaging-output"/);
    expect(sidebarSrc).toMatch(/Production output/);
  });
});
