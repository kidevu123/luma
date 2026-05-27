import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const pageSrc = readFileSync(join(__dirname, "page.tsx"), "utf8");

describe("STATION-MOBILE-UX-1 · floor station page layout", () => {
  it("does not render primary top tool nav row", () => {
    expect(pageSrc).not.toMatch(
      /<nav className="flex flex-wrap gap-2 text-xs">/,
    );
    expect(pageSrc).not.toMatch(/href=\{`\/floor\/\$\{token\}\/rolls`\}.*Rolls/);
  });

  it("gates supervisor tools by station kind", () => {
    expect(pageSrc).toMatch(/floorSupervisorToolsForStation/);
    expect(pageSrc).toMatch(/SupervisorToolsPanel/);
  });

  it("keeps scan card and footer version", () => {
    expect(pageSrc).toMatch(/ScanCardForm/);
    expect(pageSrc).toMatch(/getPackageVersion/);
    expect(pageSrc).toMatch(/Luma · v/);
  });

  it("keeps operator session before current bag section", () => {
    const sessionIdx = pageSrc.indexOf("OperatorSessionPanel");
    const bagIdx = pageSrc.indexOf("Current bag");
    expect(sessionIdx).toBeGreaterThan(-1);
    expect(bagIdx).toBeGreaterThan(sessionIdx);
  });

  it("places supervisor tools after current bag, before footer", () => {
    const toolsIdx = pageSrc.indexOf("SupervisorToolsPanel");
    const bagIdx = pageSrc.indexOf("Current bag");
    const footerIdx = pageSrc.indexOf("Luma · v");
    expect(toolsIdx).toBeGreaterThan(bagIdx);
    expect(footerIdx).toBeGreaterThan(toolsIdx);
  });
});
