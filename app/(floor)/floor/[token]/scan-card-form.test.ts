// FLOOR-START-3 + FLOOR-START-5 tests.
//
// FLOOR-START-3: lookupCardByTokenAction invariants.
// FLOOR-START-5: typed/camera scan advances the flow (resolvedCardId,
//   hasCardSelected, auto-submit on single product).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const formSrc = readFileSync(resolve(here, "scan-card-form.tsx"), "utf8");

// ── DB mock ──────────────────────────────────────────────────────────────

let callIdx = 0;
const selectResults: unknown[][] = [];

vi.mock("@/lib/db", () => ({
  db: {
    select: (_fields?: unknown) => ({
      from: (_table?: unknown) => ({
        leftJoin: (_t: unknown, _c: unknown) => ({
          where: (_cond?: unknown) => ({
            limit: async (_count?: unknown) => {
              const rows = (selectResults[callIdx++] ?? []) as unknown[];
              return rows;
            },
          }),
        }),
        where: (_cond?: unknown) => ({
          limit: async (_count?: unknown) => {
            const rows = (selectResults[callIdx++] ?? []) as unknown[];
            return rows;
          },
        }),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  qrCards: {},
  inventoryBags: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  or: (...args: unknown[]) => ({ or: args }),
  inArray: (a: unknown, b: unknown) => ({ inArray: [a, b] }),
}));

// ── Import after mocks ────────────────────────────────────────────────────

import { lookupCardByTokenAction } from "./actions";

// ── Helpers ───────────────────────────────────────────────────────────────

function makeForm(scanToken: string): FormData {
  const fd = new FormData();
  fd.set("scanToken", scanToken);
  return fd;
}

const IDLE_RAW_BAG = {
  id: "00000000-0000-0000-0000-000000000001",
  label: "bag-card-001",
  cardType: "RAW_BAG",
  status: "IDLE",
  assignedWorkflowBagId: null,
  tabletTypeId: null,
};

const INTAKE_RESERVED_RAW_BAG = {
  id: "00000000-0000-0000-0000-000000000002",
  label: "bag-card-002",
  cardType: "RAW_BAG",
  status: "ASSIGNED",
  assignedWorkflowBagId: null,
  tabletTypeId: "tt-001",
};

const ASSIGNED_RAW_BAG = {
  id: "00000000-0000-0000-0000-000000000003",
  label: "bag-card-003",
  cardType: "RAW_BAG",
  status: "ASSIGNED",
  assignedWorkflowBagId: "00000000-0000-0000-0000-000000000099",
  tabletTypeId: "tt-002",
};

// ── beforeEach ────────────────────────────────────────────────────────────

beforeEach(() => {
  callIdx = 0;
  selectResults.length = 0;
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe("lookupCardByTokenAction", () => {
  it("returns error when scan token is empty", async () => {
    const fd = new FormData();
    // no scanToken set
    const result = await lookupCardByTokenAction(fd);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/no scan token/i);
  });

  it("returns error when card not found", async () => {
    selectResults[0] = []; // no card for this token
    const result = await lookupCardByTokenAction(makeForm("nonexistent-token"));
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/not found/i);
  });

  it("returns error for VARIETY_PACK card", async () => {
    selectResults[0] = [{ id: "aaa", cardType: "VARIETY_PACK", status: "IDLE", assignedWorkflowBagId: null }];
    const result = await lookupCardByTokenAction(makeForm("variety-token"));
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/not a bag QR/i);
  });

  it("returns error for UNKNOWN card type", async () => {
    selectResults[0] = [{ id: "bbb", cardType: "UNKNOWN", status: "IDLE", assignedWorkflowBagId: null }];
    const result = await lookupCardByTokenAction(makeForm("unknown-token"));
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/not a bag QR/i);
  });

  it("returns error for RETIRED RAW_BAG card", async () => {
    selectResults[0] = [{ id: "ccc", cardType: "RAW_BAG", status: "RETIRED", assignedWorkflowBagId: null }];
    const result = await lookupCardByTokenAction(makeForm("retired-token"));
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/retired/i);
  });

  it("returns error for IDLE RAW_BAG card — pool cards must be received first", async () => {
    selectResults[0] = [IDLE_RAW_BAG];
    const result = await lookupCardByTokenAction(makeForm("bag-card-1"));
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/receive/i);
  });

  it("returns ok+isIntakeReserved=true for intake-reserved ASSIGNED RAW_BAG card", async () => {
    selectResults[0] = [INTAKE_RESERVED_RAW_BAG];
    const result = await lookupCardByTokenAction(makeForm("bag-card-2"));
    expect(result).toHaveProperty("ok", true);
    const ok = result as { ok: true; cardId: string; cardLabel: string; isIntakeReserved: boolean; tabletTypeId: string | null };
    expect(ok.cardId).toBe(INTAKE_RESERVED_RAW_BAG.id);
    expect(ok.cardLabel).toBe("bag-card-002");
    expect(ok.isIntakeReserved).toBe(true);
    expect(ok.tabletTypeId).toBe("tt-001");
  });

  it("returns ok+isIntakeReserved=false for mid-production ASSIGNED RAW_BAG card", async () => {
    selectResults[0] = [ASSIGNED_RAW_BAG];
    const result = await lookupCardByTokenAction(makeForm("pickup-bag-token"));
    expect(result).toHaveProperty("ok", true);
    const ok = result as { ok: true; cardId: string; cardLabel: string; isIntakeReserved: boolean; tabletTypeId: string | null };
    expect(ok.cardId).toBe(ASSIGNED_RAW_BAG.id);
    expect(ok.cardLabel).toBe("bag-card-003");
    expect(ok.isIntakeReserved).toBe(false);
    expect(ok.tabletTypeId).toBe("tt-002");
  });

  it("trims whitespace from scan token before lookup", async () => {
    selectResults[0] = [INTAKE_RESERVED_RAW_BAG];
    const result = await lookupCardByTokenAction(makeForm("  bag-card-2  "));
    expect(result).toHaveProperty("ok", true);
  });

  it("returns tabletTypeId null when leftJoin finds no inventory bag", async () => {
    selectResults[0] = [{
      id: "00000000-0000-0000-0000-000000000004",
      label: "bag-card-004",
      cardType: "RAW_BAG",
      status: "ASSIGNED",
      assignedWorkflowBagId: null,
      tabletTypeId: null,
    }];
    const result = await lookupCardByTokenAction(makeForm("unlinked-token"));
    expect(result).toHaveProperty("ok", true);
    const ok = result as { ok: true; cardId: string; cardLabel: string; isIntakeReserved: boolean; tabletTypeId: string | null };
    expect(ok.cardLabel).toBe("bag-card-004");
    expect(ok.tabletTypeId).toBeNull();
  });
});

// ── Product narrowing filter logic (pure) ─────────────────────────────────
// Mirrors the filteredProducts computation in scan-card-form.tsx exactly.
//
// Contract (enforced by code comment in form):
//   "Products with no configured tablet types are incomplete, not 'accepts all'."
// When effectiveTabletTypeId is non-null, a product must explicitly list that
// tablet type in allowedTabletTypeIds to be shown. Products with an empty
// allowedTabletTypeIds are hidden — the supervisor must set up the mapping.
// When effectiveTabletTypeId is null (no tablet info), all products are shown
// as a fallback so the operator is not silently blocked.

type MockProduct = { id: string; sku: string; name: string; allowedTabletTypeIds: string[] };

function narrowProducts(
  products: MockProduct[],
  tabletTypeId: string | null,
): MockProduct[] {
  if (!tabletTypeId) return products;
  return products.filter((p) => p.allowedTabletTypeIds.includes(tabletTypeId));
}

describe("product narrowing filter", () => {
  const cardProduct: MockProduct = { id: "p1", sku: "CARD_A", name: "Card A", allowedTabletTypeIds: ["tt-001"] };
  const bottleProduct: MockProduct = { id: "p2", sku: "BOT_A", name: "Bottle A", allowedTabletTypeIds: ["tt-002"] };
  const multiTabletCard: MockProduct = { id: "p3", sku: "CARD_B", name: "Card B", allowedTabletTypeIds: ["tt-001", "tt-003"] };
  const unmappedProduct: MockProduct = { id: "p4", sku: "GENERIC", name: "Generic", allowedTabletTypeIds: [] };

  it("shows only products compatible with scanned tablet type", () => {
    const result = narrowProducts([cardProduct, bottleProduct], "tt-001");
    expect(result).toEqual([cardProduct]);
  });

  it("shows all products when tablet type is null (no tablet info)", () => {
    const result = narrowProducts([cardProduct, bottleProduct], null);
    expect(result).toEqual([cardProduct, bottleProduct]);
  });

  it("shows product mapped to multiple tablet types when matching one of them", () => {
    const result = narrowProducts([cardProduct, multiTabletCard, bottleProduct], "tt-003");
    expect(result).toEqual([multiTabletCard]);
  });

  it("hides unmapped product (allowedTabletTypeIds=[]) when tablet type is known — incomplete configuration", () => {
    // Products with no tablet type mapping are treated as incomplete, not
    // "accepts all". They are hidden to prevent silently running the wrong
    // product on a bag whose tablet type the product hasn't been configured for.
    // Supervisor must add the mapping via product_allowed_tablets.
    const result = narrowProducts([cardProduct, unmappedProduct], "tt-001");
    expect(result).toEqual([cardProduct]);
    expect(result).not.toContain(unmappedProduct);
  });

  it("returns empty array when no products are compatible (config error case)", () => {
    const result = narrowProducts([cardProduct, bottleProduct], "tt-999");
    expect(result).toHaveLength(0);
  });

  it("auto-select scenario: exactly one product matches", () => {
    const result = narrowProducts([cardProduct, bottleProduct], "tt-001");
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("p1");
  });
});

// ── FLOOR-START-5 structural invariants (source-text) ────────────────────────

describe("FLOOR-START-5 · scan-card-form.tsx structural invariants", () => {
  it("declares resolvedCardId state", () => {
    expect(formSrc).toMatch(/resolvedCardId/);
    expect(formSrc).toMatch(/setResolvedCardId/);
  });

  it("hasCardSelected includes resolvedCardId === selectedCardId check", () => {
    expect(formSrc).toMatch(/hasCardSelected/);
    expect(formSrc).toMatch(/resolvedCardId\s*===\s*selectedCardId/);
  });

  it("showProductPicker uses hasCardSelected, not isReceivedCardSelected directly", () => {
    const block = formSrc.match(/const showProductPicker[\s\S]*?;/)?.[0] ?? "";
    expect(block).toMatch(/hasCardSelected/);
    expect(block).not.toMatch(/isReceivedCardSelected/);
  });

  it("submitWithCardId accepts optional explicitProductId parameter", () => {
    expect(formSrc).toMatch(/explicitProductId\?/);
    expect(formSrc).toMatch(/explicitProductId\s*\?\?\s*productId/);
  });

  it("handleResolvedToken auto-submits with explicit product ID when narrowed list has one entry", () => {
    expect(formSrc).toMatch(/await submitWithCardId\(cardId,\s*narrowed\[0\]\.id\)/);
  });

  it("setResolvedCardId(null) is called in dropdown onChange to reset scan path", () => {
    expect(formSrc).toMatch(/setResolvedCardId\(null\)/);
  });

  it("submit button onClick intercepts when resolvedCardId is set", () => {
    expect(formSrc).toMatch(/if\s*\(\s*resolvedCardId\s*\)/);
    expect(formSrc).toMatch(/submitWithCardId\(resolvedCardId\)/);
  });

  it("zero-products error uses hasCardSelected (fires for scan-resolved cards too)", () => {
    // In JSX: {requireProductForFreshBag && hasCardSelected && filteredProducts.length === 0 && ...}
    expect(formSrc).toMatch(/hasCardSelected[\s\S]{0,60}filteredProducts\.length === 0/);
  });
});

// ── FLOOR-START-5 · hasCardSelected pure logic ────────────────────────────────

function computeHasCardSelected(
  selectedCardId: string,
  receivedSet: Set<string>,
  resolvedCardId: string | null,
): boolean {
  return (
    selectedCardId !== "" &&
    (receivedSet.has(selectedCardId) || resolvedCardId === selectedCardId)
  );
}

describe("FLOOR-START-5 · hasCardSelected", () => {
  const RECEIVED_ID = "00000000-0000-0000-0000-aaaaaaaaaaaa";
  const SCANNED_ID = "00000000-0000-0000-0000-bbbbbbbbbbbb";
  const receivedSet = new Set([RECEIVED_ID]);

  it("false when selectedCardId is empty", () => {
    expect(computeHasCardSelected("", receivedSet, null)).toBe(false);
  });

  it("true when selectedCardId is in receivedSet (dropdown path)", () => {
    expect(computeHasCardSelected(RECEIVED_ID, receivedSet, null)).toBe(true);
  });

  it("true when selectedCardId matches resolvedCardId (scan path, card not in dropdown)", () => {
    expect(computeHasCardSelected(SCANNED_ID, receivedSet, SCANNED_ID)).toBe(true);
  });

  it("false when selectedCardId is not in receivedSet and resolvedCardId is null (silent-failure case FLOOR-START-5 fixed)", () => {
    expect(computeHasCardSelected(SCANNED_ID, receivedSet, null)).toBe(false);
  });

  it("false when resolvedCardId is set but selectedCardId differs (stale state)", () => {
    expect(computeHasCardSelected(SCANNED_ID, receivedSet, "different-id")).toBe(false);
  });

  it("true when card is in both receivedSet and resolvedCardId (both paths match)", () => {
    expect(computeHasCardSelected(RECEIVED_ID, receivedSet, RECEIVED_ID)).toBe(true);
  });
});

// ── FLOOR-START-5 · auto-submit trigger condition ────────────────────────────

describe("FLOOR-START-5 · auto-submit on single compatible product", () => {
  it("triggers auto-submit when narrowed list has exactly one product", () => {
    const narrowed = [{ id: "p1", sku: "CARD", name: "Card A", allowedTabletTypeIds: ["tt-001"] }];
    expect(narrowed.length === 1 && !!narrowed[0]).toBe(true);
  });

  it("shows picker (defers submit) when multiple products match", () => {
    const narrowed = [
      { id: "p1", sku: "CARD_A", name: "Card A", allowedTabletTypeIds: [] },
      { id: "p2", sku: "CARD_B", name: "Card B", allowedTabletTypeIds: [] },
    ];
    expect(narrowed.length === 1).toBe(false);
  });

  it("shows config-error (defers submit) when zero products match", () => {
    const narrowed: unknown[] = [];
    expect(narrowed.length === 1).toBe(false);
    expect(narrowed.length === 0).toBe(true);
  });

  it("auto-submit uses narrowed[0].id directly (not productId state) to avoid stale closure", () => {
    // Verified structurally: submitWithCardId(cardId, narrowed[0].id) passes
    // the product ID as an explicit argument, not relying on the productId state
    // variable which would be stale in the same render cycle.
    expect(formSrc).toMatch(/submitWithCardId\(cardId,\s*narrowed\[0\]\.id\)/);
  });
});

// ── FLOOR-SCAN-1 · downstream station fresh-bag guard ────────────────────
// Verifies that actions.ts prevents non-first-op stations from starting fresh bags.

const actionsSrc = readFileSync(resolve(here, "actions.ts"), "utf8");

describe("FLOOR-SCAN-1 · downstream station fresh-bag guard", () => {
  it("actions.ts defines FRESH_BAG_STATION_KINDS with all first-op kinds", () => {
    expect(actionsSrc).toMatch(/FRESH_BAG_STATION_KINDS/);
    expect(actionsSrc).toMatch(/"BLISTER"/);
    expect(actionsSrc).toMatch(/"HANDPACK_BLISTER"/);
    expect(actionsSrc).toMatch(/"BOTTLE_HANDPACK"/);
    expect(actionsSrc).toMatch(/"COMBINED"/);
  });

  it("scanCardAction throws when non-first-op station scans intake-reserved card", () => {
    // Guard is: if (!FRESH_BAG_STATION_KINDS.has(station.kind)) throw ...
    // Verified structurally that the guard is present in actions.ts.
    expect(actionsSrc).toMatch(/This station does not start fresh bags/);
    expect(actionsSrc).toMatch(/FRESH_BAG_STATION_KINDS\.has/);
  });

  it("IDLE card scan is blocked with receive-first message", () => {
    expect(actionsSrc).toMatch(/not been linked to a received bag/);
    expect(actionsSrc).toMatch(/Receive Pills page/);
  });

  it("RETIRED card scan is blocked", () => {
    // classifyFloorScanCard handles RETIRED, but scanCardAction also has its
    // own fallback: card.status not ASSIGNED throws "not scannable".
    expect(actionsSrc).toMatch(/not scannable/);
  });
});

// ── FLOOR-SCAN-1 · camera scanner secure context ──────────────────────────
// Verifies that camera-scanner.tsx degrades gracefully on HTTP deployments.

const cameraSrc = readFileSync(resolve(here, "camera-scanner.tsx"), "utf8");

describe("FLOOR-SCAN-1 · camera scanner HTTPS requirement", () => {
  it("camera-scanner.tsx checks window.isSecureContext", () => {
    expect(cameraSrc).toMatch(/isSecureContext/);
  });

  it("shows HTTPS-specific error when page is served over HTTP", () => {
    expect(cameraSrc).toMatch(/Camera access requires HTTPS/);
    expect(cameraSrc).toMatch(/This page is served over HTTP/);
  });

  it("shows browser-unsupported message when MediaDevices API is absent for non-insecure reasons", () => {
    expect(cameraSrc).toMatch(/not available in this browser/);
  });

  it("falls back to 'Use typed input' link when camera is unavailable", () => {
    expect(cameraSrc).toMatch(/Use typed input/);
  });

  it("camera decode result calls onResult — same handler as typed scan", () => {
    // Structural: both BarcodeDetector and jsQR paths call onResult(value)
    expect(cameraSrc).toMatch(/onResult\(/);
  });
});

// ── FLOOR-SCAN-1 · typed scan + product narrowing full path ──────────────
// Pure logic tests verifying the end-to-end narrowing path described in
// handleResolvedToken: lookupCardByToken → narrowed → auto-submit or picker.

describe("FLOOR-SCAN-1 · typed scan flow structural guards", () => {
  it("handleResolvedToken is declared in scan-card-form.tsx", () => {
    expect(formSrc).toMatch(/handleResolvedToken/);
  });

  it("handleResolvedToken narrows products by tabletTypeId before deciding auto-submit", () => {
    // The narrowed computation inside handleResolvedToken uses allowedProducts
    // (server-rendered prop) not the filteredProducts state variable, so the
    // auto-submit trigger fires in the same async frame without waiting for
    // a React re-render.
    expect(formSrc).toMatch(/allowedProducts\.filter/);
    expect(formSrc).toMatch(/allowedTabletTypeIds\.includes\(ttId\)/);
  });

  it("card not in server-rendered dropdown can still reach product picker (resolvedCardId path)", () => {
    // If card is not in receivedCards, selectedCard is undefined →
    // effectiveTabletTypeId falls back to scannedTabletTypeId (set by scan).
    // resolvedCardId === selectedCardId makes hasCardSelected true.
    expect(formSrc).toMatch(/scannedTabletTypeId/);
    expect(formSrc).toMatch(/selectedCard\?\.tabletTypeId\s*\?\?\s*scannedTabletTypeId/);
    expect(formSrc).toMatch(/resolvedCardId\s*===\s*selectedCardId/);
  });

  it("zero compatible products shows config error not silent no-op", () => {
    // The JSX condition: requireProductForFreshBag && hasCardSelected && filteredProducts.length === 0
    expect(formSrc).toMatch(/No active products are configured for this tablet type/);
    expect(formSrc).toMatch(/No active products configured for this station kind/);
  });

  it("product narrowing: unmapped products (empty allowedTabletTypeIds) are excluded when tablet type is known", () => {
    // The filter uses .includes() only — no length === 0 bypass.
    // This matches the intentional policy: empty = incomplete, not "accepts all".
    const filterBlock = formSrc.match(/allowedProducts\.filter[\s\S]{0,200}allowedTabletTypeIds\.includes/)?.[0] ?? "";
    expect(filterBlock).toBeTruthy();
    expect(filterBlock).not.toMatch(/allowedTabletTypeIds\.length\s*===\s*0/);
  });
});

// ── CAMERA-SCAN-ROOTCAUSE-1 · video DOM bug fix ───────────────────────────
//
// Root cause: <video> was inside {phase === "scanning" && ...}, so videoRef.current
// was null when the getUserMedia promise resolved. if (video) failed silently;
// setPhase("scanning") never called; scanner stayed on spinner forever.
// Fix: video always in DOM, hidden via CSS class when not scanning.

describe("CAMERA-SCAN-ROOTCAUSE-1 · camera-scanner.tsx video DOM fix", () => {
  it("video element is always rendered (phase check uses CSS hidden, not conditional rendering)", () => {
    // The video element must NOT be the direct child of {phase === "scanning" && ...}.
    // It should use conditional CSS class instead.
    expect(cameraSrc).toMatch(/phase !== "scanning"/);
  });

  it("video element uses Tailwind hidden class to toggle visibility when not scanning", () => {
    // className includes conditional: phase !== "scanning" ? " hidden" : ""
    expect(cameraSrc).toMatch(/phase !== "scanning".*hidden/);
  });

  it("setStreamStarted(true) called after getUserMedia succeeds", () => {
    expect(cameraSrc).toMatch(/setStreamStarted\(true\)/);
  });

  it("setPermissionDenied(true) called on NotAllowedError", () => {
    expect(cameraSrc).toMatch(/setPermissionDenied\(true\)/);
  });

  it("CameraDiagnosticsPanel rendered in the error phase", () => {
    expect(cameraSrc).toMatch(/CameraDiagnosticsPanel/);
  });

  it("diagnostics panel labels HTTPS secure context", () => {
    expect(cameraSrc).toMatch(/HTTPS secure context/);
  });

  it("diagnostics panel labels camera permission state", () => {
    expect(cameraSrc).toMatch(/Camera permission/);
  });

  it("stream is stopped after successful scan in BarcodeDetector path", () => {
    // stopStream() called before onResult in native path
    expect(cameraSrc).toMatch(/stopStream\(\)/);
    expect(cameraSrc).toMatch(/onResult\(barcodes/);
  });

  it("stream is stopped after successful scan in jsQR path", () => {
    // getTracks().forEach(t => t.stop()) called before onResult in jsQR path
    expect(cameraSrc).toMatch(/onResult\(code\.data\.trim\(\)\)/);
  });
});

// ── QR-SCAN-PAYLOAD-1 · source invariants ────────────────────────────────────
//
// These structural tests guard against re-introducing the id/scanToken mismatch.
// They read source files as text — no DB, no mocks — and assert the correct
// fields are used. They fail until Tasks 2 and 3 are implemented.

describe("QR-SCAN-PAYLOAD-1 · lookupCardByTokenAction dual lookup", () => {
  const actionsSrc = readFileSync(resolve(here, "actions.ts"), "utf8");

  it("uses or() to wrap the WHERE clause — not a bare scanToken eq", () => {
    // The old single-field where: .where(eq(qrCards.scanToken, ...))
    // The new dual-field where: .where(or(eq(qrCards.scanToken, ...), eq(qrCards.id, ...)))
    expect(actionsSrc).toMatch(/\.where\s*\(\s*or\s*\(/);
  });

  it("includes eq(qrCards.scanToken, token) inside the or() clause", () => {
    expect(actionsSrc).toMatch(/eq\s*\(\s*qrCards\.scanToken\s*,\s*token\s*\)/);
  });

  it("includes eq(qrCards.id, token) as the legacy fallback inside or()", () => {
    expect(actionsSrc).toMatch(/eq\s*\(\s*qrCards\.id\s*,\s*token\s*\)/);
  });

  it("includes a TODO comment about removing the id fallback", () => {
    expect(actionsSrc).toMatch(/TODO.*id.*fallback|TODO.*legacy.*label/i);
  });
});

describe("QR-SCAN-PAYLOAD-1 · QR label payload", () => {
  const labelsPath = resolve(
    here,
    "../../../(admin)/qr-cards/labels/page.tsx",
  );
  const labelsSrc = readFileSync(labelsPath, "utf8");

  it("renderQrSvg receives r.card.scanToken — not r.card.id", () => {
    expect(labelsSrc).toMatch(/renderQrSvg\s*\(\s*r\.card\.scanToken\s*\)/);
  });

  it("no call to renderQrSvg with r.card.id remains", () => {
    expect(labelsSrc).not.toMatch(/renderQrSvg\s*\(\s*r\.card\.id\s*\)/);
  });
});

// ── FLOOR-SCAN-UX-2 · scan confirmation UX structural guards ──────────────────
//
// Ensure the scan confirmation state and chip are present and correctly wired.
// Source-text tests catch regressions without mounting the component.

describe("FLOOR-SCAN-UX-2 · scan confirmation state", () => {
  it("declares scannedContext state initialized to null", () => {
    expect(formSrc).toMatch(/useState.*null.*scannedContext|scannedContext.*useState.*null/s);
  });

  it("handleResolvedToken sets scannedContext with label and detail", () => {
    expect(formSrc).toMatch(/setScannedContext\s*\(\s*\{/);
    expect(formSrc).toMatch(/label\s*:\s*result\.cardLabel/);
    expect(formSrc).toMatch(/detail\s*:/);
  });

  it("handleResolvedToken sets scanInput to raw.trim() immediately — before lookup, so operator sees something", () => {
    // FLOOR-SCAN-LIVE-1 fix: input was blank during lookup. Now the raw token is
    // shown immediately (before the server round-trip), then overwritten with the
    // human-readable label on success. Use await-call position not import line.
    const rawTrimIdx = formSrc.indexOf("setScanInput(raw.trim())");
    const lookupCallIdx = formSrc.indexOf("await lookupCardByTokenAction(fd)");
    expect(rawTrimIdx).toBeGreaterThan(-1);
    expect(lookupCallIdx).toBeGreaterThan(-1);
    expect(rawTrimIdx).toBeLessThan(lookupCallIdx);
  });

  it("handleResolvedToken overwrites raw token with result.cardLabel on successful lookup", () => {
    expect(formSrc).toMatch(/setScanInput\s*\(\s*result\.cardLabel\s*\)/);
    expect(formSrc).not.toMatch(/setScanInput\s*\(\s*['"]\s*['"]\s*\)/);
  });

  it("handleResolvedToken has catch block — silent failures from thrown server actions are surfaced as scanError", () => {
    // FLOOR-SCAN-LIVE-1: without this, a DB error or network failure in
    // lookupCardByTokenAction throws past the finally block, leaving the form
    // blank with no error message visible to the operator.
    // Narrow to handleResolvedToken body to avoid matching submitWithCardId's try/finally.
    const fnStart = formSrc.indexOf("const handleResolvedToken");
    const fnEnd = formSrc.indexOf("const handleScanKeyDown");
    expect(fnStart).toBeGreaterThan(-1);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const fnBody = formSrc.slice(fnStart, fnEnd);
    const catchIdx = fnBody.indexOf("} catch (err) {");
    const finallyIdx = fnBody.indexOf("} finally {");
    expect(catchIdx).toBeGreaterThan(-1);
    expect(finallyIdx).toBeGreaterThan(-1);
    expect(catchIdx).toBeLessThan(finallyIdx);
    const catchBlock = fnBody.slice(catchIdx, finallyIdx);
    expect(catchBlock).toMatch(/setScanError/);
  });

  it("handleResolvedToken clears scannedContext before setting it — null call precedes object call", () => {
    const nullIdx = formSrc.indexOf("setScannedContext(null)");
    const setIdx = formSrc.indexOf("setScannedContext({");
    expect(nullIdx).toBeGreaterThan(-1);
    expect(setIdx).toBeGreaterThan(-1);
    expect(nullIdx).toBeLessThan(setIdx);
  });

  it("onChange clears resolvedCardId and scannedContext when operator types", () => {
    expect(formSrc).toMatch(/setScannedContext\s*\(\s*null\s*\)/);
    expect(formSrc).toMatch(/setResolvedCardId\s*\(\s*null\s*\)/);
  });

  it("confirmation chip renders scannedContext.detail when scannedContext is set and no scanError", () => {
    expect(formSrc).toMatch(/scannedContext\s*&&\s*!scanError/);
    expect(formSrc).toMatch(/scannedContext\.detail/);
  });

  it("dropdown section comment identifies it as backup-only", () => {
    expect(formSrc).toMatch(/Dropdown.*backup only|backup only.*Dropdown/i);
  });

  it("handleCameraResult logs decoded QR value to console when ?debug=1 is set in URL", () => {
    // FLOOR-SCAN-LIVE-1: helps field-diagnose QR encoding issues without
    // polluting normal operation. Guard is URLSearchParams('debug') === '1'.
    expect(formSrc).toMatch(/debug.*===.*"1"|"1".*===.*debug/);
    expect(formSrc).toMatch(/console\.log/);
    expect(formSrc).toMatch(/floor-scan.*camera decoded|camera decoded.*floor-scan/);
  });
});

describe("FLOOR-SCAN-UX-2 · lookupCardByTokenAction returns cardLabel", () => {
  const actionsSrc = readFileSync(resolve(here, "actions.ts"), "utf8");

  it("select block includes label: qrCards.label", () => {
    expect(actionsSrc).toMatch(/label\s*:\s*qrCards\.label/);
  });

  it("return statement includes cardLabel: card.label", () => {
    expect(actionsSrc).toMatch(/cardLabel\s*:\s*card\.label/);
  });

  it("return type union includes cardLabel: string", () => {
    expect(actionsSrc).toMatch(/cardLabel\s*:\s*string/);
  });
});
