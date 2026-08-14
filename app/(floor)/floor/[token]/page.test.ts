// P4b Task 5 — THE CUTOVER. What this file scans changed completely.
//
// It used to be a ~510-line structural scanner over page.tsx's fifteen
// inline resolutions and their panels: the pickup list, the resume list,
// the fresh-card list, the product picker, the elapsed timer and its
// station-scoped pause math, the sealing product options, the hand-pack
// tablet context, the roll panel, the two "waiting for X" banners, the
// supervisor-tools disclosure. Every one of those concepts is gone from
// this page — that is the point of the cutover — so every assertion
// about them is gone too.
//
// WHERE THE DELETED COVERAGE WENT (one line per retired describe block;
// the task report carries the full justification):
//
//   STATION-MOBILE-UX-1/2 (layout, subtitle, bag label lines)
//     -> the bag label is built by the ENGINE now
//        (buildCurrentBagDisplayLabel inside getStationView), and
//        lib/production/engine/station-view.test.ts pins BOTH lines
//        ("carries both label lines so the rewire cannot drop the
//        subline"). Layout ordering is no longer a page concern.
//   PRODUCTION-OVERLAP-3 (idle copy, pickup/resume lists)
//     -> behaviour RETIRED by spec §"Removed from operator mode": the
//        bag dropdown, eligible-pickup list and resume list are gone
//        from operator mode entirely. What replaces them is
//        SCAN_TO_CLAIM + view.upNext, covered by
//        station-view.test.ts's up-next and expected-scan cases.
//   STATION-ACTIVE-UX-1 (Eastern time, ElapsedTimer, Op label)
//     -> behaviour RETIRED: the spec's screen carries no timer and no
//        picked-up timestamp. elapsed-timer.tsx survives for P5's
//        supervisor view; the Op-label assertions scanned
//        stage-action-buttons.tsx, which is DELETED.
//   PRODUCTION-OVERLAP-1/2 (SEALING + PACKAGING waiting banners)
//     -> replaced by NextAction.START, which says the same thing once
//        for every station kind instead of twice by hand. Covered by
//        station-view.test.ts "announces START when the bag was claimed
//        before the previous step finished".
//   STATION-TIMER-2 / STATION-SEALING-TIMER-ROLLS-CLEANUP-1
//     -> the station-scoped timer queries are deleted with the timer.
//        The projector half of that work is a separate concern and is
//        KEPT below.
//   PRODUCT-SELECTION-AT-SEALING-1 (page wiring)
//     -> replaced by the engine's product resolution:
//        resolve-product-choice.test.ts (AUTO vs PICK vs none) and
//        station-view.test.ts's product-picking block.
//   HANDPACK-TABLET-CONTEXT-1 (page wiring)
//     -> the context was a prop of the deleted StageActionButtons.
//        lib/production/workflow-bag-tablet-context.test.ts still covers
//        the resolver itself.
//   MATERIAL-ROLL-CHANGE-1 · station roll panel ON MAIN PAGE
//     -> behaviour MOVED: rolls reach the operator through More's
//        "Change material" link (operatorMaterialLinks), asserted in
//        lib/production/floor-station-mobile-nav.test.ts. The panel
//        COMPONENT block is KEPT below — the component still exists for
//        the rolls page and P5's supervisor view.
//   MULTI-SEALING-FINAL-CLOSE-UNSTICK-1 (idle lane-close banner)
//     -> replaced by NextAction.CONFIRM_BAG_EMPTY, which asks the
//        question on the bag itself instead of listing stranded bags on
//        an idle screen. Covered by station-view.test.ts's lane-close
//        cases (including the partial-closeout exemption).

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const pageSrc = readFileSync(join(__dirname, "page.tsx"), "utf8");

describe("P4b-CUTOVER-1 · the station page is one read and one component", () => {
  it("renders the operator screen from a single getStationView call", () => {
    expect(pageSrc).toMatch(/getStationView\(station\.id\)/);
    expect(pageSrc).toMatch(/<OperatorScreen/);
  });

  it("passes Report problem as a required prop, not an optional slot", () => {
    expect(pageSrc).toMatch(/reportProblem=\{/);
    expect(pageSrc).toMatch(/<ReportProblem/);
  });

  it("no longer renders any of the legacy panels or lists", () => {
    for (const gone of [
      "ScanCardForm",
      "StageActionButtons",
      "BagAdvancedBanner",
      "SupervisorToolsPanel",
      "AutoLoadedLotsPanel",
      "StationRollPanel",
      "RawBagAllocationPanel",
      "ElapsedTimer",
      "OperatorSessionPanel",
    ]) {
      expect(pageSrc).not.toMatch(new RegExp(gone));
    }
  });

  it("no longer resolves stages, pickups or product pickers itself", () => {
    // The engine owns every one of these. A reappearance here is the
    // leak the cutover exists to close.
    for (const gone of [
      "STATION_PICKUP_FROM_STAGE",
      "STATION_STARTED_RESUME_FROM_STAGE",
      "STATION_PREREQ_STAGE",
      "FIRST_OP_STATION_KINDS",
      "resolveSealingProductSelection",
      "needsSealingLaneClose",
      "productAllowedTablets",
      "loadAutoLots",
    ]) {
      expect(pageSrc).not.toMatch(new RegExp(gone));
    }
  });

  it("stays well under the 200-line exit criterion for the render path", () => {
    // The whole file is allowed to be longer than the render path
    // (loadPendingRework and the cutover note live here too), but the
    // component itself must stay small enough to read in one screen.
    const start = pageSrc.indexOf("export default async function FloorStationPage");
    const end = pageSrc.indexOf("/** QC-3 — pending REWORK_SENT");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(pageSrc.slice(start, end).split("\n").length).toBeLessThan(200);
  });
});

describe("P4b-CUTOVER-1 · the inactive-station branch can recover itself", () => {
  it("mounts FloorLiveRefresh on BOTH branches", () => {
    // A station re-activated from /machines must not need someone to
    // walk over and reload the tablet. The stream 404s while inactive,
    // which the component treats as any other failure: 60s polling plus
    // a 60s SSE retry, so the screen recovers on its own.
    const matches = pageSrc.match(/<FloorLiveRefresh token=\{token\} \/>/g) ?? [];
    expect(matches.length).toBe(2);
    const inactiveIdx = pageSrc.indexOf("if (!station.isActive)");
    const returnIdx = pageSrc.indexOf("<FloorLiveRefresh", inactiveIdx);
    const branchEnd = pageSrc.indexOf("</main>", inactiveIdx);
    expect(returnIdx).toBeGreaterThan(inactiveIdx);
    expect(returnIdx).toBeLessThan(branchEnd);
  });

  it("still shows the inactive message from the shared constant", () => {
    expect(pageSrc).toMatch(/STATION_INACTIVE_FLOOR_MESSAGE/);
  });
});

describe("P4b-CUTOVER-1 · what the cutover deliberately keeps", () => {
  it("keeps the QC panel (P5 gates it; it hosts Release hold)", () => {
    expect(pageSrc).toMatch(/shouldRenderQcPanel\(station\.kind\)/);
    expect(pageSrc).toMatch(/<QcPanel/);
    expect(pageSrc).toMatch(/isOnHold=\{isOnHold\}/);
  });

  it("derives isOnHold from the view's own blocker, not a second query", () => {
    // Two reads of read_bag_state could disagree with each other, and
    // the operator would be looking at the one that lost.
    expect(pageSrc).toMatch(/b\.code === "BAG_ON_HOLD"/);
    expect(pageSrc).not.toMatch(/readBagState/);
  });

  it("keeps the idle-operator guard", () => {
    expect(pageSrc).toMatch(/<IdleOperatorGuard/);
  });
});

// KEPT from the pre-cutover file — neither depends on page.tsx.

describe("STATION-TIMER-2 · projector HANDPACK_BLISTER_COMPLETE boundary", () => {
  it("includes HANDPACK_BLISTER_COMPLETE in stageBoundaries", () => {
    const projSrc = readFileSync(
      join(__dirname, "../../../../lib/projector/index.ts"),
      "utf8",
    );
    expect(projSrc).toMatch(/HANDPACK_BLISTER_COMPLETE/);
    const boundaryIdx = projSrc.indexOf("stageBoundaries");
    const chunk = projSrc.slice(boundaryIdx, boundaryIdx + 600);
    expect(chunk).toMatch(/HANDPACK_BLISTER_COMPLETE/);
  });
});

describe("MATERIAL-ROLL-CHANGE-1 · station roll panel component", () => {
  // The component is no longer mounted on the station page (rolls reach
  // the operator through More -> Change material). It is kept, with its
  // coverage, for the rolls route and P5's supervisor view.
  const panelSrc = readFileSync(join(__dirname, "station-roll-panel.tsx"), "utf8");

  it("is a client component with Change PVC roll and Change Foil roll buttons", () => {
    expect(panelSrc).toMatch(/^"use client"/);
    expect(panelSrc).toMatch(/Change PVC roll/);
    expect(panelSrc).toMatch(/Change Foil roll/);
  });

  it("shows mounted vs not mounted for PVC and FOIL", () => {
    expect(panelSrc).toMatch(/Not mounted/);
    expect(panelSrc).toMatch(/\["PVC", "FOIL"\]/);
  });

  it("reuses ChangeRollForm with fixedRole from rolls-forms", () => {
    expect(panelSrc).toMatch(/ChangeRollForm/);
    expect(panelSrc).toMatch(/fixedRole=\{openRole\}/);
    expect(panelSrc).toMatch(/from "\.\/rolls-forms"/);
  });

  it("shows PVC and Foil roll-change required cards only when requested", () => {
    expect(panelSrc).toMatch(/requiredChangeRole/);
    expect(panelSrc).toMatch(/role === "PVC" \? "PVC" : "Foil"/);
    expect(panelSrc).toMatch(/\{label\} roll change required/);
  });

  it("handles a missing active roll without blocking resume", () => {
    expect(panelSrc).toMatch(/Supervisor check required/);
    expect(panelSrc).toMatch(/No active \{label\} roll is mounted/);
    expect(panelSrc).not.toMatch(/Resume bag/);
  });

  it("pause-triggered form uses roll token input and existing changeRollAction path", () => {
    const formSrc = readFileSync(join(__dirname, "rolls-forms.tsx"), "utf8");
    expect(panelSrc).toMatch(
      /replacementInputMode=\{requiredChangeRole \? "text" : "select"\}/,
    );
    expect(panelSrc).toMatch(/showEndingWeight=\{requiredChangeRole != null\}/);
    expect(formSrc).toMatch(/name="newRollToken"/);
    expect(formSrc).toMatch(/fd\.set\("newPackagingLotId", newRollToken\)/);
    expect(formSrc).toMatch(/fd\.set\("newRollNumber", newRollToken\)/);
    expect(formSrc).toMatch(/name="counterSegmentCount"/);
    expect(formSrc).toMatch(/name="oldRollEndState"/);
    expect(formSrc).toMatch(/value="removed_partial"/);
    expect(formSrc).toMatch(/name="endingWeightKg"/);
    expect(formSrc).toMatch(/changeRollAction/);
  });
});
