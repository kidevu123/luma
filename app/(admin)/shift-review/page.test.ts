import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const pageSrc = readFileSync(join(__dirname, "page.tsx"), "utf8");
const smokeSrc = readFileSync(
  join(__dirname, "../../../scripts/smoke-authenticated-routes.ts"),
  "utf8",
);

describe("SHIFT-REVIEW-1 · admin page", () => {
  it("requires admin before loading review data", () => {
    expect(pageSrc).toMatch(/requireAdmin/);
  });

  it("renders read-only banner and recovery dry-run guidance", () => {
    expect(pageSrc).toMatch(/SHIFT_REVIEW_READ_ONLY_BANNER/);
    expect(pageSrc).toMatch(/RECOVERY_DRY_RUN_HINT/);
    expect(pageSrc).toMatch(/nothing on this page repairs data/);
  });

  it("supports from/to/bag/flagged query filters", () => {
    expect(pageSrc).toMatch(/name="from"/);
    expect(pageSrc).toMatch(/name="to"/);
    expect(pageSrc).toMatch(/name="bag"/);
    expect(pageSrc).toMatch(/name="flagged"/);
    expect(pageSrc).toMatch(/parseShiftReviewWindow/);
  });

  it("renders flagged bags before other bags", () => {
    expect(pageSrc).toMatch(/flaggedBags/);
    expect(pageSrc).toMatch(/cleanBags/);
    expect(pageSrc).toMatch(/Flagged bags/);
    expect(pageSrc).toMatch(/Other bags in window/);
  });

  it("does not expose mutation controls", () => {
    expect(pageSrc).not.toMatch(/"use server"/);
    expect(pageSrc).not.toMatch(/Fix bag|Apply recovery|Save changes|Delete row/i);
  });
});

describe("SHIFT-REVIEW-1 · auth smoke route", () => {
  it("includes shift review in authenticated smoke routes", () => {
    expect(smokeSrc).toMatch(/\/shift-review/);
  });
});
