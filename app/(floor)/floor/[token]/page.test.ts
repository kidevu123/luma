import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const pageSrc = readFileSync(join(__dirname, "page.tsx"), "utf8");

describe("STATION-MOBILE-UX-1 · floor station page layout", () => {
  it("does not render primary top tool nav row", () => {
    expect(pageSrc).not.toMatch(
      /<nav className="flex flex-wrap gap-2 text-xs">/,
    );
    expect(pageSrc).not.toMatch(/href=\{`\/floor\/\$\{token\}\/rolls`\}.*Rolls/);
  });

  it("gates supervisor tools by station kind", () => {
    expect(pageSrc).toMatch(/floorSupervisorToolsForStation/);
    expect(pageSrc).toMatch(/SupervisorToolsPanel/);
  });

  it("keeps scan card and footer version", () => {
    expect(pageSrc).toMatch(/ScanCardForm/);
    expect(pageSrc).toMatch(/getPackageVersion/);
    expect(pageSrc).toMatch(/Luma · v/);
  });

  it("keeps operator session before current bag section", () => {
    const sessionIdx = pageSrc.indexOf("OperatorSessionPanel");
    const bagIdx = pageSrc.indexOf("Current bag");
    expect(sessionIdx).toBeGreaterThan(-1);
    expect(bagIdx).toBeGreaterThan(sessionIdx);
  });

  it("places supervisor tools after current bag, before footer", () => {
    const toolsIdx = pageSrc.indexOf("SupervisorToolsPanel");
    const bagIdx = pageSrc.indexOf("Current bag");
    const footerIdx = pageSrc.indexOf("Luma · v");
    expect(toolsIdx).toBeGreaterThan(bagIdx);
    expect(footerIdx).toBeGreaterThan(toolsIdx);
  });
});

describe("STATION-MOBILE-UX-2 · mobile-first station page", () => {
  it("does not show Online badge or Station label clutter", () => {
    expect(pageSrc).not.toMatch(/>\s*Online\s*</);
    expect(pageSrc).not.toMatch(/>\s*Station\s*</);
  });

  it("uses collapsed details for supervisor tools, not top nav", () => {
    expect(pageSrc).toMatch(/<details className=.*Supervisor tools/s);
    expect(pageSrc).not.toMatch(/<nav className="flex flex-wrap/);
  });

  it("uses compact station subtitle helper", () => {
    expect(pageSrc).toMatch(/formatStationPageSubtitle/);
  });

  it("does not show internal bag id chip on active bag", () => {
    expect(pageSrc).not.toMatch(/bag\.id\.slice\(0, 8\)/);
  });

  it("keeps ScanCardForm for backup dropdown path", () => {
    expect(pageSrc).toMatch(/ScanCardForm/);
  });
});

describe("PRODUCTION-OVERLAP-3 · idle-state copy and pickup labels", () => {
  it("idle copy for pickup-only stations does not say 'released from the prior stage'", () => {
    expect(pageSrc).not.toMatch(/Scan a bag QR released from the prior stage/);
  });

  it("idle copy for pickup-only stations says 'Scan a QR card or pick from the list below'", () => {
    expect(pageSrc).toMatch(/Scan a QR card or pick from the list below/);
  });

  it("pickup dropdown label does not say 'released bag' (overlap pickup ≠ released bag)", () => {
    const formSrc = require('fs').readFileSync(
      require('path').join(__dirname, 'scan-card-form.tsx'),
      'utf8'
    );
    expect(formSrc).not.toMatch(/Pick up released bag/);
    expect(formSrc).toMatch(/Pick up bag \(same QR continues\)/);
  });
});

describe('STATION-ACTIVE-UX-1 · active bag Eastern time', () => {
  it('imports formatFloorTimeEastern from floor-time helper', () => {
    expect(pageSrc).toMatch(/formatFloorTimeEastern/);
    expect(pageSrc).toMatch(/from.*floor-time/);
  });

  it('does not call bare toLocaleTimeString on startedAt', () => {
    // Eastern formatting is done via formatFloorTimeEastern, never bare
    const startedIdx = pageSrc.indexOf('startedAt');
    const chunk = pageSrc.slice(startedIdx, startedIdx + 300);
    expect(chunk).not.toMatch(/\.toLocaleTimeString\(\)/);
  });

  it('wraps startedAt in formatFloorTimeEastern call', () => {
    expect(pageSrc).toMatch(/formatFloorTimeEastern\s*\(\s*new Date/);
  });
});

describe('STATION-ACTIVE-UX-1 · elapsed timer component', () => {
  it('imports ElapsedTimer from elapsed-timer module', () => {
    expect(pageSrc).toMatch(/ElapsedTimer/);
    expect(pageSrc).toMatch(/from.*elapsed-timer/);
  });

  it('places ElapsedTimer after Current bag label', () => {
    const bagIdx = pageSrc.indexOf('Current bag');
    // Use the JSX usage (<ElapsedTimer), not the import line
    const timerIdx = pageSrc.indexOf('<ElapsedTimer');
    expect(timerIdx).toBeGreaterThan(bagIdx);
  });

  it('passes startedAtMs prop as number via getTime()', () => {
    // JSX spans multiple lines — use s flag
    expect(pageSrc).toMatch(/startedAtMs=\{[\s\S]*?\.getTime\(\)/);
  });

  it('passes pausedSecondsAccum from state', () => {
    expect(pageSrc).toMatch(/pausedSecondsAccum=\{/);
    expect(pageSrc).toMatch(/pausedSecondsAccum/);
  });

  it('passes isPaused from state', () => {
    expect(pageSrc).toMatch(/isPaused=\{.*state\?.*isPaused/);
  });

  it('passes pausedAtMs as null when state.pausedAt is absent', () => {
    expect(pageSrc).toMatch(/pausedAtMs=\{/);
    // null fallback for pausedAt — multiline JSX, use s flag
    expect(pageSrc).toMatch(/pausedAtMs=\{[\s\S]*?null[\s\S]*?\}/);
  });

  it('elapsed-timer is a use-client component', () => {
    const timerSrc = require('fs').readFileSync(
      require('path').join(__dirname, 'elapsed-timer.tsx'),
      'utf8'
    );
    expect(timerSrc).toMatch(/^"use client"/);
    expect(timerSrc).toMatch(/setInterval/);
    expect(timerSrc).toMatch(/clearInterval/);
    expect(timerSrc).toMatch(/Paused at/);
  });
});

describe("PRODUCTION-OVERLAP-1 · SEALING waiting banner", () => {
  it("BagAdvancedBanner guards on SEALING + STARTED before the generic prereq check", () => {
    const guardIdx = pageSrc.indexOf(
      'stationKind === "SEALING" && currentStage === "STARTED"',
    );
    const prereqIdx = pageSrc.indexOf("STATION_PREREQ_STAGE[stationKind]");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(prereqIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(prereqIdx);
  });

  it("waiting banner says Waiting for blister to complete", () => {
    expect(pageSrc).toMatch(/Waiting for blister to complete/);
  });

  it("waiting banner uses amber border/background (not red or blue)", () => {
    const waitIdx = pageSrc.indexOf("Waiting for blister to complete");
    const chunk = pageSrc.slice(waitIdx - 200, waitIdx + 50);
    expect(chunk).toMatch(/amber/);
    expect(chunk).not.toMatch(/red/);
    expect(chunk).not.toMatch(/sky/);
  });

  it("BagAdvancedBanner is rendered with stationKind from station data", () => {
    expect(pageSrc).toMatch(/stationKind=\{station\.station\.kind\}/);
  });

  it("waiting banner text mentions blister and hand-pack", () => {
    expect(pageSrc).toMatch(/blistered or hand-packed/);
  });

  it("STATION_PREREQ_STAGE still maps SEALING to BLISTERED (completion gate unchanged)", () => {
    expect(pageSrc).toMatch(/SEALING:\s*"BLISTERED"/);
  });
});

describe("PRODUCTION-OVERLAP-2 · PACKAGING waiting banner", () => {
  it("BagAdvancedBanner guards on PACKAGING + BLISTERED before the generic prereq check", () => {
    const guardIdx = pageSrc.indexOf(
      'stationKind === "PACKAGING" && currentStage === "BLISTERED"',
    );
    const prereqIdx = pageSrc.indexOf("STATION_PREREQ_STAGE[stationKind]");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(prereqIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(prereqIdx);
  });

  it("waiting banner says Waiting for sealing to complete", () => {
    expect(pageSrc).toMatch(/Waiting for sealing to complete/);
  });

  it("waiting banner uses amber border/background (not red or blue)", () => {
    const waitIdx = pageSrc.indexOf("Waiting for sealing to complete");
    const chunk = pageSrc.slice(waitIdx - 200, waitIdx + 50);
    expect(chunk).toMatch(/amber/);
    expect(chunk).not.toMatch(/red/);
    expect(chunk).not.toMatch(/sky/);
  });

  it("waiting banner text mentions sealing station", () => {
    expect(pageSrc).toMatch(/sealing station completes/);
  });

  it("STATION_PREREQ_STAGE still maps PACKAGING to SEALED (completion gate unchanged)", () => {
    expect(pageSrc).toMatch(/PACKAGING:\s*"SEALED"/);
  });
});

describe('STATION-TIMER-2 · station-scoped elapsed timer', () => {
  it('queries BAG_PICKED_UP event for downstream stations', () => {
    expect(pageSrc).toMatch(/BAG_PICKED_UP/);
    expect(pageSrc).toMatch(/stationTimerStartMs/);
  });

  it('gates pickup query on FIRST_OP_STATION_KINDS check', () => {
    expect(pageSrc).toMatch(/FIRST_OP_STATION_KINDS\.has/);
  });

  it('declares stationPausedSecondsAccum for station-scoped pause math', () => {
    expect(pageSrc).toMatch(/stationPausedSecondsAccum/);
  });

  it('queries BAG_PAUSED and BAG_RESUMED events after pickup timestamp', () => {
    expect(pageSrc).toMatch(/BAG_PAUSED.*BAG_RESUMED|BAG_RESUMED.*BAG_PAUSED/s);
  });

  it('shows Picked up label for downstream stations instead of Started', () => {
    expect(pageSrc).toMatch(/stationTimerPickedUpAt/);
    expect(pageSrc).toMatch(/Picked up/);
  });

  it('passes stationPausedSecondsAccum to ElapsedTimer', () => {
    const timerIdx = pageSrc.indexOf('<ElapsedTimer');
    const timerChunk = pageSrc.slice(timerIdx, timerIdx + 500);
    expect(timerChunk).toMatch(/stationPausedSecondsAccum/);
  });

  it('falls back to bag startedAt when no pickup event found (first-op stations)', () => {
    expect(pageSrc).toMatch(/stationTimerStartMs\s*\?\?/);
    expect(pageSrc).toMatch(/stationTimerStartMs !== null/);
  });
});

describe('STATION-TIMER-2 · projector HANDPACK_BLISTER_COMPLETE boundary', () => {
  it('includes HANDPACK_BLISTER_COMPLETE in stageBoundaries', () => {
    const projSrc = require('fs').readFileSync(
      require('path').join(__dirname, '../../../../lib/projector/index.ts'),
      'utf8'
    );
    expect(projSrc).toMatch(/HANDPACK_BLISTER_COMPLETE/);
    const boundaryIdx = projSrc.indexOf('stageBoundaries');
    const chunk = projSrc.slice(boundaryIdx, boundaryIdx + 600);
    expect(chunk).toMatch(/HANDPACK_BLISTER_COMPLETE/);
  });
});

describe('STATION-ACTIVE-UX-1 · Op label clarity', () => {
  const sab = require('fs').readFileSync(
    require('path').join(__dirname, 'stage-action-buttons.tsx'),
    'utf8'
  );

  it('does not use the old Op # (4 digits) placeholder text', () => {
    expect(sab).not.toMatch(/Op # \(4 digits\)/);
  });

  it('uses Operator code as placeholder', () => {
    expect(sab).toMatch(/placeholder="Operator code"/);
  });

  it('keeps aria-label describing the operator badge field', () => {
    expect(sab).toMatch(/aria-label="Operator code"/);
  });
});

describe("PRODUCT-SELECTION-AT-SEALING-1 · page wiring", () => {
  it("uses PRODUCT_AT_START for requireProductForFreshBag, not canStartFreshBag", () => {
    expect(pageSrc).toMatch(/PRODUCT_AT_START_STATION_KINDS/);
    expect(pageSrc).toMatch(/requireProductAtStart/);
    expect(pageSrc).toMatch(/requireProductForFreshBag=\{requireProductAtStart\}/);
    expect(pageSrc).not.toMatch(/requireProductForFreshBag=\{canStartFreshBag\}/);
  });

  it("loads sealing product options when bag has no product at sealing station", () => {
    expect(pageSrc).toMatch(/sealingProductOptionsForForm/);
    expect(pageSrc).toMatch(/filterSealingProductsByTabletType/);
    expect(pageSrc).toMatch(/hasProductMapped/);
    expect(pageSrc).toMatch(/sealingProductOptions=\{sealingProductOptionsForForm\}/);
  });

  it("does not import scan-card-form changes", () => {
    const scanSrc = readFileSync(join(__dirname, "scan-card-form.tsx"), "utf8");
    expect(scanSrc).toMatch(/requireProductForFreshBag/);
    expect(scanSrc).not.toMatch(/PRODUCT_AT_START/);
  });
});
