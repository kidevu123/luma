import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const src = readFileSync(join(__dirname, "page.tsx"), "utf8");

describe("RECEIVE-EDIT-AUDIT-1 · receive detail bag edit discoverability", () => {
  it("links each bag row to the bag edit route", () => {
    expect(src).toMatch(/\/inbound\/\$\{r\.receive\.id\}\/bag\/\$\{bag\.id\}\/edit/);
  });

  it("uses Edit bag action label", () => {
    expect(src).toMatch(/Edit bag/);
  });

  it("explains post-save edit capabilities in the bags section", () => {
    expect(src).toMatch(/audit log/i);
    expect(src).toMatch(/edit reason/i);
    expect(src).toMatch(/can only have notes updated/i);
  });

  it("displays weight in kg on the detail table", () => {
    expect(src).toMatch(/Weight \(kg\)/);
    expect(src).toMatch(/weightGrams \/ 1000/);
  });
});
