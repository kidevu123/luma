import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

function read(rel: string): string {
  return readFileSync(resolve(repoRoot, rel), "utf8");
}

const RAW_SQL = read(
  "drizzle/0068_rba_sessions_allow_negative_ending_balance.sql",
);
const SQL = RAW_SQL.split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");
const JOURNAL = JSON.parse(read("drizzle/meta/_journal.json")) as {
  entries: Array<{ idx: number; tag: string }>;
};

describe("migration 0068 — allow negative ending_balance_qty", () => {
  it("drops and recreates rba_sessions_qty_signs without ending >= 0", () => {
    expect(SQL).toMatch(
      /DROP CONSTRAINT IF EXISTS\s+"rba_sessions_qty_signs"/,
    );
    expect(SQL).toMatch(/ADD CONSTRAINT\s+"rba_sessions_qty_signs"/);
    expect(SQL).toMatch(/starting_balance_qty.*>= 0/s);
    expect(SQL).toMatch(/consumed_qty.*>= 0/s);
    expect(SQL).not.toMatch(/ending_balance_qty.*>= 0/s);
  });

  it("is registered in drizzle journal", () => {
    expect(
      JOURNAL.entries.some(
        (e) => e.tag === "0068_rba_sessions_allow_negative_ending_balance",
      ),
    ).toBe(true);
  });
});
