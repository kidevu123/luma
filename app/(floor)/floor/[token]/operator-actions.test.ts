// P4b — the operator screen's write surface, pinned where it makes a
// decision of its own.
//
// operator-actions.ts is deliberately thin (parse -> authenticate ->
// delegate to ONE engine function -> translate the Blocker), so there is
// almost nothing here to test. The exceptions are the two places it does
// NOT delegate: the scan-token -> workflow-bag lookup, and the
// fresh-start fork that lookup falls into. Both are source scans — the
// suite runs no Postgres (vitest.config.ts, by design) and a "use
// server" module cannot export a non-async helper for a unit test to
// call.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const src = readFileSync(join(__dirname, "operator-actions.ts"), "utf8");

function resolverBlock(): string {
  const start = src.indexOf("async function resolveScannedWorkflowBagId");
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("export async function claimScannedBagAction", start);
  return src.slice(start, end);
}

describe("resolveScannedWorkflowBagId — the qr_cards.id fallback is UUID-gated", () => {
  it("checks UUID shape BEFORE querying the uuid column", () => {
    // Labels printed before QR-SCAN-PAYLOAD-1 encode the row id instead
    // of the scan token, so the fallback has to exist. It also has to be
    // gated: Postgres raises 22P02 (invalid input syntax for type uuid)
    // on a non-UUID compared against a uuid column, and that surfaces to
    // the operator as a thrown error instead of the clean
    // "code was not recognized" refusal.
    const block = resolverBlock();
    const guardIdx = block.indexOf("if (!UUID_RE.test(token)) return null;");
    const byIdIdx = block.indexOf("eq(qrCards.id, token)");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(byIdIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(byIdIdx);
  });

  it("tries the scan token first, so a real token never reaches the id path", () => {
    const block = resolverBlock();
    expect(block.indexOf("eq(qrCards.scanToken, token)")).toBeLessThan(
      block.indexOf("eq(qrCards.id, token)"),
    );
  });

  it("returns null rather than guessing when nothing matches", () => {
    // No label-matching fallback: claiming the wrong bag is worse than
    // asking the operator to scan again. The caller turns null into the
    // engine's BAG_UNRECOGNIZED blocker (or the fresh-start fork).
    const block = resolverBlock();
    expect(block).not.toMatch(/like\(|ilike\(|bagLabel/);
    expect(block).toMatch(/return byId\?\.workflowBagId \?\? null;/);
  });

  it("UUID_RE is anchored, so a UUID with trailing junk is not treated as one", () => {
    const literal = src.match(/const UUID_RE =\s*([\s\S]*?);/)?.[1] ?? "";
    expect(literal).toContain("^");
    expect(literal).toContain("$");
  });
});

describe("claimScannedBagAction — one gesture, two meanings (SCAN-FIRST-1)", () => {
  it("only looks for a fresh bag AFTER the claim lookup comes back empty", () => {
    // A card that already carries a workflow bag must be CLAIMED. If the
    // fresh-start fork ran first it would try to start a bag that is
    // already in production.
    const resolvedIdx = src.indexOf("const resolved = d.scanToken");
    const freshIdx = src.indexOf("await resolveFreshBagStart({");
    expect(resolvedIdx).toBeGreaterThan(-1);
    expect(freshIdx).toBeGreaterThan(resolvedIdx);
    expect(src.slice(resolvedIdx, freshIdx)).toMatch(/if \(!resolved\) \{/);
  });

  it("delegates the start to scanCardAction rather than re-implementing it", () => {
    // The readiness gate, the partial-restart rules, the LOW-confidence
    // supervisor rule and the allocation-session open all live in that
    // transaction. A second implementation would give the floor two
    // answers to the same question.
    expect(src).toMatch(/import \{ scanCardAction \} from "\.\/actions";/);
    expect(src).toMatch(/const result = await scanCardAction\(fd\);/);
  });
});
