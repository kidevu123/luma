import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const pageSrc = readFileSync(resolve(dir, "page.tsx"), "utf8");
const formSrc = readFileSync(resolve(dir, "issue-form.tsx"), "utf8");

describe("finished lot issue prefill", () => {
  it("accepts a selected bag from the review link query string", () => {
    expect(pageSrc).toContain("searchParams");
    expect(pageSrc).toContain("requestedBagId");
    expect(pageSrc).toContain("initialBagId={requestedBagId ?? null}");
  });

  it("passes bag receipt and production output metrics into the form", () => {
    expect(pageSrc).toContain("receiptNumber: r.receiptNumber ?? null");
    expect(pageSrc).toContain("masterCases: r.metrics?.masterCases ?? null");
    expect(pageSrc).toContain("displaysMade: r.metrics?.displaysMade ?? null");
    expect(pageSrc).toContain("looseCards: r.metrics?.looseCards ?? null");
    expect(pageSrc).toContain("unitsYielded: r.metrics?.unitsYielded ?? null");
  });

  it("prefills lot number and counts from the selected bag", () => {
    expect(formSrc).toContain("initialBagId");
    expect(formSrc).toContain("setLotNumber(b.receiptNumber)");
    expect(formSrc).toContain("setUnits(b.unitsYielded ?? 0)");
    expect(formSrc).toContain("setDisplays(b.displaysMade ?? 0)");
    expect(formSrc).toContain("setCases(b.masterCases ?? 0)");
  });

  it("shows the bag-derived source context instead of a blank manual form", () => {
    expect(formSrc).toContain("Prefilled from selected bag");
    expect(formSrc).toContain("The bag from the review link is no longer awaiting lot issue.");
  });
});
