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

  it("serializes finalizedAt to ISO string for the client form", () => {
    expect(pageSrc).toContain("r.bag.finalizedAt instanceof Date");
    expect(pageSrc).toContain("toISOString()");
  });

  it("passes bag receipt and production output metrics into the form", () => {
    expect(pageSrc).toContain("receiptNumber: r.receiptNumber ?? null");
    expect(pageSrc).toContain("masterCases: r.metrics?.masterCases ?? null");
    expect(pageSrc).toContain("displaysMade: r.metrics?.displaysMade ?? null");
    expect(pageSrc).toContain("looseCards: r.metrics?.looseCards ?? null");
    expect(pageSrc).toContain("unitsYielded: r.metrics?.unitsYielded ?? null");
  });

  it("prefills produced-on from finalizedAt without calling slice directly", () => {
    expect(formSrc).toContain("toDateInputValue");
    expect(formSrc).not.toMatch(/finalizedAt\.slice/);
  });

  it("prefills lot number and counts from the selected bag", () => {
    expect(formSrc).toContain("initialBagId");
    expect(formSrc).toContain("setLotNumber(b.receiptNumber)");
    expect(formSrc).toContain("setUnits(b.unitsYielded ?? 0)");
    expect(formSrc).toContain("setDisplays(b.displaysMade ?? 0)");
    expect(formSrc).toContain("setCases(b.masterCases ?? 0)");
  });

  it("shows coordinated lot + allocation closeout flow", () => {
    expect(formSrc).toContain("issueFinishedLotWithAllocationAndRedirect");
    expect(formSrc).toContain("Issue lot and close allocation");
  });

  it("loads repair starting balance hints for bags without open sessions", () => {
    expect(pageSrc).toContain("loadRepairStartingBalanceHints");
    expect(pageSrc).toContain("repairStartingHints");
  });

  it("does not ask operators to type starting or ending balance on repair path", () => {
    expect(formSrc).toContain("repairStartingHints");
    expect(formSrc).toContain("effectiveStartingBalance");
    expect(formSrc).not.toMatch(/id="repairStartingBalanceQty"/);
    expect(formSrc).not.toMatch(/Starting balance \(tablets\)/);
    expect(formSrc).not.toMatch(/id="endingBalanceQty"/);
    expect(formSrc).toMatch(/Derived from source bag intake minus tablets consumed/);
  });

  it("does not block submit when ending balance is negative (packaging over vendor label)", () => {
    expect(formSrc).not.toMatch(/endingBalanceQty >= 0/);
    expect(formSrc).toMatch(/packaging output as the source of/);
  });
});

describe("coordinated lot action schema", () => {
  const actionsSrc = readFileSync(resolve(dir, "../actions.ts"), "utf8");

  it("allows negative endingBalanceQty for packaging-derived closeout", () => {
    expect(actionsSrc).toMatch(/endingBalanceQty: z\.coerce\.number\(\)\.int\(\)/);
    expect(actionsSrc).not.toMatch(
      /endingBalanceQty: z\.coerce\.number\(\)\.int\(\)\.min\(0\)/,
    );
  });

  it("calls redirect outside try/catch so NEXT_REDIRECT is not swallowed", () => {
    const fnStart = actionsSrc.indexOf(
      "export async function issueFinishedLotWithAllocationAndRedirect",
    );
    const fnEnd = actionsSrc.indexOf(
      "export async function repairAutoIssueFinishedLotAction",
    );
    const fnBody = actionsSrc.slice(fnStart, fnEnd);
    const redirectIdx = fnBody.indexOf("redirect(`/finished-lots/");
    const catchIdx = fnBody.lastIndexOf("} catch (err)");
    expect(redirectIdx).toBeGreaterThan(-1);
    expect(catchIdx).toBeGreaterThan(-1);
    expect(redirectIdx).toBeGreaterThan(catchIdx);
  });
});
