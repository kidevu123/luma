// RAW-BAG-INTAKE-RECEIVE-FORBIDDEN-v1.5.16 — reintroduction guards.
//
// v1.5.15 tagged two dead helpers; v1.5.16 removed them. These tests
// forbid bringing them back and pin the canonical live paths.

import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "..", "..");

function grepCallers(symbol: string): string[] {
  let out = "";
  try {
    out = execSync(
      `grep -rEn "\\b${symbol}\\b" --include="*.ts" --include="*.tsx" --include="*.mjs" .`,
      {
        cwd: REPO,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1 && !e.stdout) return [];
    out = e.stdout ?? "";
  }
  return out
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter((line) => !line.includes("node_modules/"))
    .filter((line) => !line.includes(".next/"))
    .map((line) => (line.startsWith("./") ? line.slice(2) : line));
}

function readSrc(rel: string): string {
  return execSync(`cat "${resolve(REPO, rel)}"`, { encoding: "utf8" });
}

describe("RAW-BAG-INTAKE-RECEIVE-FORBIDDEN-v1.5.16 · buildRawBagIntakeReceivePayload", () => {
  it("must not be reintroduced — only CHANGELOG history may mention it", () => {
    const refs = grepCallers("buildRawBagIntakeReceivePayload");
    const offenders = refs.filter(
      (line) =>
        !line.startsWith("CHANGELOG.md:") &&
        !line.startsWith("lib/zoho/raw-bag-intake-receive-deprecated.test.ts:"),
    );
    expect(
      offenders,
      `Dead helper reintroduced. Use buildBagFinishReceivePayload instead.\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

describe("RAW-BAG-INTAKE-RECEIVE-FORBIDDEN-v1.5.16 · local upsertRawBagReceiveRow", () => {
  it("must not exist in raw-bag-intake-receive.ts — live writer is in bag-finish-receive.ts", () => {
    const file = readSrc("lib/zoho/raw-bag-intake-receive.ts");
    expect(file).not.toMatch(/\bupsertRawBagReceiveRow\b/);
  });

  it("live upsertRawBagReceiveRow remains in bag-finish-receive.ts", () => {
    const file = readSrc("lib/zoho/bag-finish-receive.ts");
    expect(file).toMatch(/^async function upsertRawBagReceiveRow\(/m);
    expect(file).not.toMatch(/^export\s+async\s+function\s+upsertRawBagReceiveRow/m);
  });
});

describe("RAW-BAG-INTAKE-RECEIVE-FORBIDDEN-v1.5.16 · canonical live paths", () => {
  it("buildBagFinishReceivePayload is exported from bag-finish-receive.ts", () => {
    const file = readSrc("lib/zoho/bag-finish-receive.ts");
    expect(file).toMatch(/export function buildBagFinishReceivePayload\(/);
  });

  it("seedPendingRawBagReceiveRows is exported from raw-bag-intake-receive.ts", () => {
    const file = readSrc("lib/zoho/raw-bag-intake-receive.ts");
    expect(file).toMatch(/export async function seedPendingRawBagReceiveRows\(/);
  });
});
