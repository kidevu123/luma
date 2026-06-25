// RAW-BAG-INTAKE-RECEIVE-DEPRECATED-v1.5.15 — no-importer guards.
//
// Two helpers in lib/zoho/raw-bag-intake-receive.ts have been tagged
// @deprecated for removal in a later release:
//
//   - buildRawBagIntakeReceivePayload (legacy line_items[] shape;
//     superseded by buildBagFinishReceivePayload in
//     lib/zoho/bag-finish-receive.ts which emits the flat
//     BagFinishReceiveRequest shape accepted by the gateway today).
//
//   - upsertRawBagReceiveRow (the local one defined in this file at
//     line ~123; NOT the same-named function in bag-finish-receive.ts).
//     This local one has zero callers and is not exported. Canonical
//     writers to zoho_raw_bag_receives today are
//     seedPendingRawBagReceiveRows, the bag-finish-receive.ts version
//     of upsertRawBagReceiveRow, and setRawBagReconciliationStatus.
//
// These tests pin "no new callers" so a future regression cannot
// re-introduce dependencies on the dead path. Test count grows on
// removal; behavior is unchanged today.

import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "..", "..");

/** Run a `grep -rn` against the repo and return matching lines, with
 *  test/doc/changelog noise stripped per the test's intent. Returns
 *  an empty array on grep's "no matches" exit-code 1 (treated as
 *  success here — that IS the goal). */
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
    // grep exits 1 with no output when there are no matches.
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1 && !e.stdout) return [];
    out = e.stdout ?? "";
  }
  return out
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter((line) => !line.includes("node_modules/"))
    .filter((line) => !line.includes(".next/"))
    // grep emits paths as "./foo/bar.ts:..."; strip the leading "./"
    // so file-path startsWith() filters in the assertions below work.
    .map((line) => (line.startsWith("./") ? line.slice(2) : line));
}

describe("RAW-BAG-INTAKE-RECEIVE-DEPRECATED-v1.5.15 · buildRawBagIntakeReceivePayload", () => {
  const refs = grepCallers("buildRawBagIntakeReceivePayload");

  it("the only callers are the helper itself and its paired test file (no production callers)", () => {
    const offenders = refs.filter((line) => {
      return (
        !line.startsWith("lib/zoho/raw-bag-intake-receive.ts:") &&
        !line.startsWith("lib/zoho/raw-bag-intake-receive.test.ts:") &&
        !line.startsWith("lib/zoho/raw-bag-intake-receive-deprecated.test.ts:") &&
        !line.startsWith("CHANGELOG.md:")
      );
    });
    expect(
      offenders,
      `New caller(s) added for the @deprecated helper. Use buildBagFinishReceivePayload instead.\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the helper itself still carries the @deprecated JSDoc tag", () => {
    const fileRefs = refs.filter((line) =>
      line.startsWith("lib/zoho/raw-bag-intake-receive.ts:"),
    );
    expect(fileRefs.length).toBeGreaterThan(0);
    // The @deprecated comment lives just above the export function line;
    // re-read the file to assert presence rather than rely on grep.
    const file = readSrc("lib/zoho/raw-bag-intake-receive.ts");
    const exportIdx = file.indexOf("export function buildRawBagIntakeReceivePayload");
    expect(exportIdx).toBeGreaterThan(0);
    const above = file.slice(Math.max(0, exportIdx - 1200), exportIdx);
    expect(above).toContain("@deprecated");
    expect(above).toContain("buildBagFinishReceivePayload");
  });
});

describe("RAW-BAG-INTAKE-RECEIVE-DEPRECATED-v1.5.15 · local upsertRawBagReceiveRow", () => {
  it("the helper is not exported and has no callers anywhere in the repo", () => {
    // The same-named function in lib/zoho/bag-finish-receive.ts is a
    // separate, live, production-used writer — we explicitly allow it.
    // The local one in raw-bag-intake-receive.ts must have zero refs
    // OUTSIDE its own declaration line in that file.
    const file = readSrc("lib/zoho/raw-bag-intake-receive.ts");
    // Confirm not exported.
    expect(file).toMatch(/^async function upsertRawBagReceiveRow\(/m);
    expect(file).not.toMatch(/^export\s+async\s+function\s+upsertRawBagReceiveRow/m);

    const refs = grepCallers("upsertRawBagReceiveRow");
    const offenders = refs.filter((line) => {
      // Allowed: the dead declaration itself, the live bag-finish writer +
      // its single caller in the same file, the deprecation-guard file,
      // and CHANGELOG narration.
      return (
        !line.startsWith("lib/zoho/raw-bag-intake-receive.ts:") &&
        !line.startsWith("lib/zoho/bag-finish-receive.ts:") &&
        !line.startsWith("lib/zoho/raw-bag-intake-receive-deprecated.test.ts:") &&
        !line.startsWith("CHANGELOG.md:")
      );
    });
    expect(
      offenders,
      `New caller(s) added for the @deprecated local helper.\n${offenders.join("\n")}`,
    ).toEqual([]);

    // And explicitly: zero call sites inside raw-bag-intake-receive.ts
    // itself other than the declaration line. Lines inside JSDoc
    // comment blocks (starting with `*` after trim) are excluded —
    // those reference the symbol name in prose, not as callers.
    const localCalls = file
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => {
        const trimmed = line.trimStart();
        if (!/\bupsertRawBagReceiveRow\b/.test(line)) return false;
        if (/^async function upsertRawBagReceiveRow\(/.test(trimmed)) return false;
        if (trimmed.startsWith("*") || trimmed.startsWith("//")) return false;
        return true;
      });
    expect(
      localCalls,
      `Local @deprecated upsertRawBagReceiveRow gained an in-file caller.`,
    ).toEqual([]);
  });

  it("the helper carries the @deprecated JSDoc tag pointing at canonical writers", () => {
    const file = readSrc("lib/zoho/raw-bag-intake-receive.ts");
    const declIdx = file.indexOf("async function upsertRawBagReceiveRow");
    expect(declIdx).toBeGreaterThan(0);
    const above = file.slice(Math.max(0, declIdx - 1200), declIdx);
    expect(above).toContain("@deprecated");
    expect(above).toContain("seedPendingRawBagReceiveRows");
  });
});

function readSrc(rel: string): string {
  return execSync(`cat "${resolve(REPO, rel)}"`, { encoding: "utf8" });
}
