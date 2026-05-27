import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const formSrc = readFileSync(join(__dirname, "bag-edit-form.tsx"), "utf8");
const actionsSrc = readFileSync(join(__dirname, "actions.ts"), "utf8");
const querySrc = readFileSync(
  join(process.cwd(), "lib/db/queries/bag-edits.ts"),
  "utf8",
);

describe("RECEIVE-EDIT-2B-2 · bag edit declared pill count", () => {
  it("form shows declared pill count field", () => {
    expect(formSrc).toMatch(/Declared pill count/);
    expect(formSrc).toMatch(/declaredPillCount/);
  });

  it("action parses declaredPillCount only, not live pillCount", () => {
    expect(actionsSrc).toMatch(/declaredPillCount/);
    expect(actionsSrc).not.toMatch(/input\.pillCount/);
  });

  it("query patches declaredPillCount on inventory_bags only", () => {
    expect(querySrc).toMatch(/patch\.declaredPillCount = input\.declaredPillCount/);
    expect(querySrc).not.toMatch(/patch\.pillCount/);
  });
});
