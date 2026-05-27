import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const pageSrc = readFileSync(join(__dirname, "page.tsx"), "utf8");
const sidebarSrc = readFileSync(
  join(process.cwd(), "components/admin/sidebar.tsx"),
  "utf8",
);

describe("STATION-NAV-CLEANUP-1 · /production/start", () => {
  it("redirects to Live floor instead of rendering a start form", () => {
    expect(pageSrc).toMatch(/redirect\("\/floor-board"\)/);
    expect(pageSrc).not.toMatch(/StartProductionForm/);
    expect(pageSrc).not.toMatch(/requireLead/);
  });
});

describe("STATION-NAV-CLEANUP-1 · admin sidebar", () => {
  it("does not promote Start production in Operations", () => {
    expect(sidebarSrc).not.toMatch(
      /href:\s*"\/production\/start"/,
    );
  });

  it("still links Production output", () => {
    expect(sidebarSrc).toMatch(/href:\s*"\/packaging-output"/);
    expect(sidebarSrc).toMatch(/Production output/);
  });
});
