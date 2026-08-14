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
    const resolvedIdx = src.indexOf("const resolved = await resolveScannedWorkflowBagId(d.scanToken)");
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

describe("claimScannedBagAction — scanToken is required (P5-SUPERVISOR Task 4 fix round 1)", () => {
  // Physical possession of the QR is the control on this path. Before
  // this round the schema accepted a workflowBagId-only request as a
  // fallback and the new ManualBagPickPanel was the first caller to
  // exercise it — a hand-crafted request could claim a queued bag
  // while the station was locked. The manual override now goes
  // through supervisorClaimBagAction (which requires a live supervisor
  // session); this action's schema refuses a workflowBagId-only
  // request with the standard invalid-input shape.
  function claimSchemaBlock(): string {
    const start = src.indexOf("const claimSchema = z");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("async function resolveScannedWorkflowBagId", start);
    return src.slice(start, end);
  }

  it("the schema declares scanToken as REQUIRED (no .optional())", () => {
    const block = claimSchemaBlock();
    // Match the scanToken field declaration and assert it is not
    // followed by .optional() before the next field.
    const match = block.match(/scanToken:\s*z\.string\(\)\.min\(1\)\.max\(200\)([^,\n]*),/);
    expect(match).not.toBeNull();
    expect(match?.[1] ?? "").not.toContain(".optional()");
  });

  it("no .refine() fallback lets workflowBagId satisfy the schema alone", () => {
    // Pre-P5 the schema carried:
    //   .refine((d) => d.scanToken != null || d.workflowBagId != null, ...)
    // That refine is what made workflowBagId-only requests pass the
    // parse step. It must be gone from the claim schema block.
    const block = claimSchemaBlock();
    expect(block).not.toMatch(/\.refine\(/);
  });

  it("the flow reads d.scanToken unconditionally (no d.workflowBagId ?? null fallback)", () => {
    // Belt-and-braces: even if someone re-added .optional() to the
    // schema, the resolver must not fall back to the workflowBagId
    // hint. The single line "const resolved = await
    // resolveScannedWorkflowBagId(d.scanToken)" is the invariant.
    expect(src).toMatch(
      /const resolved = await resolveScannedWorkflowBagId\(d\.scanToken\);/,
    );
    expect(src).not.toMatch(/d\.workflowBagId \?\? null/);
  });
});

describe("supervisorClaimBagAction — the ONLY unscanned claim entry, server-gated", () => {
  // The manual-bag-pick tool in More is the only floor caller that
  // claims a queued bag without a scan. The gate below is a live
  // supervisor session; without it, "supervisor-only" is cosmetic
  // (view.supervisor only hides the panel — a hand-crafted request
  // would still land on the write path).
  function supervisorClaimBlock(): string {
    const start = src.indexOf(
      "export async function supervisorClaimBagAction",
    );
    expect(start).toBeGreaterThan(-1);
    // Function body ends at the first line-anchored "}" — the closing
    // brace of the top-level function, always at column 0 followed by a
    // blank line. This avoids including the JSDoc for the next helper.
    const end = src.indexOf("\n}\n", start);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end + 2);
  }

  it("gates on requireSupervisorSession inside a db.transaction before delegating", () => {
    const block = supervisorClaimBlock();
    const gateIdx = block.indexOf(
      "requireSupervisorSession(tx, d.stationId)",
    );
    const claimIdx = block.indexOf("await claimQueuedBag({");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(claimIdx).toBeGreaterThan(gateIdx);
    // The gate must sit inside a db.transaction (same pattern as
    // releaseQaHoldAction), and refusal must use the shared refusal
    // sentence + code so the operator sees "Supervisor unlock
    // required for this." exactly once across the surface.
    expect(block).toMatch(/db\.transaction\(\(tx\) =>[\s\S]*?requireSupervisorSession/);
    expect(block).toContain("SUPERVISOR_GATE_REFUSAL_SENTENCE");
    expect(block).toContain("SUPERVISOR_GATE_REFUSAL_CODE");
  });

  it("delegates the write to the sanctioned P4b path (claimQueuedBag)", () => {
    // No bespoke claim logic — the same engine function every scan
    // path already goes through. A second implementation would give
    // the floor two answers to the same question.
    const block = supervisorClaimBlock();
    expect(block).toMatch(/await claimQueuedBag\(\{/);
    // And no fresh-start fork — the manual pick is queue-only.
    expect(block).not.toMatch(/resolveFreshBagStart|scanCardAction/);
  });

  it("writes an audit row with the pinned action name and supervisor session ids", () => {
    // Pinning the action name protects downstream ledger filters —
    // renaming would silently drop the manual-pick rows.
    const block = supervisorClaimBlock();
    expect(block).toContain("floor.supervisor.manual_bag_claim");
    expect(block).toMatch(/targetType: "WorkflowBag"/);
    expect(block).toMatch(/supervisor_session_id: supSession\.id/);
    expect(block).toMatch(/supervisor_employee_id: supSession\.employeeId/);
  });
});
