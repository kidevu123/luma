// RAW-BAG-INTAKE-RECEIVE-FORBIDDEN-v1.5.16 — reintroduction guards.
//
// v1.5.15 tagged two dead helpers; v1.5.16 removed them. These tests
// forbid bringing them back and pin the canonical live paths.

import { describe, expect, it } from "vitest";
import { grepRepoSymbol, readRepoSource } from "@/lib/test/source-scan";

describe("RAW-BAG-INTAKE-RECEIVE-FORBIDDEN-v1.5.16 · buildRawBagIntakeReceivePayload", () => {
  it("must not be reintroduced — only CHANGELOG history may mention it", () => {
    const refs = grepRepoSymbol("buildRawBagIntakeReceivePayload");
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
    const file = readRepoSource("lib/zoho/raw-bag-intake-receive.ts");
    expect(file).not.toMatch(/\bupsertRawBagReceiveRow\b/);
  });

  it("live upsertRawBagReceiveRow remains in bag-finish-receive.ts", () => {
    const file = readRepoSource("lib/zoho/bag-finish-receive.ts");
    expect(file).toMatch(/^async function upsertRawBagReceiveRow\(/m);
    expect(file).not.toMatch(/^export\s+async\s+function\s+upsertRawBagReceiveRow/m);
  });
});

describe("RAW-BAG-INTAKE-RECEIVE-FORBIDDEN-v1.5.16 · canonical live paths", () => {
  it("buildBagFinishReceivePayload is exported from bag-finish-receive.ts", () => {
    const file = readRepoSource("lib/zoho/bag-finish-receive.ts");
    expect(file).toMatch(/export function buildBagFinishReceivePayload\(/);
  });

  it("seedPendingRawBagReceiveRows is exported from raw-bag-intake-receive.ts", () => {
    const file = readRepoSource("lib/zoho/raw-bag-intake-receive.ts");
    expect(file).toMatch(/export async function seedPendingRawBagReceiveRows\(/);
  });
});
