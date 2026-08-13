import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  FLOOR_ROLL_STATION_KINDS,
  floorSupervisorToolsForStation,
  formatStationPageSubtitle,
  stationShowsLoadedMaterialsPanel,
} from "./floor-station-mobile-nav";

const TOKEN = "station-token-abc";
const pageSrc = readFileSync(
  join(__dirname, "../../app/(floor)/floor/[token]/page.tsx"),
  "utf8",
);
const varietyPackPageSrc = readFileSync(
  join(__dirname, "../../app/(floor)/floor/[token]/variety-pack/page.tsx"),
  "utf8",
);
const bagAllocationPageSrc = readFileSync(
  join(__dirname, "../../app/(floor)/floor/[token]/bag-allocation/page.tsx"),
  "utf8",
);

const ALL_STATION_KINDS = [
  "BLISTER",
  "HANDPACK_BLISTER",
  "SEALING",
  "PACKAGING",
  "BOTTLE_HANDPACK",
  "BOTTLE_CAP_SEAL",
  "BOTTLE_STICKER",
  "COMBINED",
] as const;

describe("STATION-NAV-CLEANUP-2 · floorSupervisorToolsForStation", () => {
  it("no station kind exposes variety pack", () => {
    for (const kind of ALL_STATION_KINDS) {
      const ids = floorSupervisorToolsForStation(TOKEN, kind).map((t) => t.id);
      expect(ids, kind).not.toContain("variety-pack");
    }
  });

  it("HANDPACK_BLISTER has no supervisor tools", () => {
    expect(floorSupervisorToolsForStation(TOKEN, "HANDPACK_BLISTER")).toEqual([]);
  });

  it("BOTTLE_HANDPACK has no supervisor tools", () => {
    expect(floorSupervisorToolsForStation(TOKEN, "BOTTLE_HANDPACK")).toEqual([]);
  });

  it("BLISTER gets rolls only", () => {
    expect(floorSupervisorToolsForStation(TOKEN, "BLISTER").map((t) => t.id)).toEqual(
      ["rolls"],
    );
  });

  it("SEALING has no supervisor tools", () => {
    expect(floorSupervisorToolsForStation(TOKEN, "SEALING")).toEqual([]);
  });

  it("COMBINED gets rolls only", () => {
    expect(floorSupervisorToolsForStation(TOKEN, "COMBINED").map((t) => t.id)).toEqual(
      ["rolls"],
    );
  });

  it("PACKAGING, BOTTLE_CAP_SEAL, and BOTTLE_STICKER get no tools", () => {
    expect(floorSupervisorToolsForStation(TOKEN, "PACKAGING")).toEqual([]);
    expect(floorSupervisorToolsForStation(TOKEN, "BOTTLE_CAP_SEAL")).toEqual([]);
    expect(floorSupervisorToolsForStation(TOKEN, "BOTTLE_STICKER")).toEqual([]);
  });

  it("no station exposes bag allocation in supervisor tools", () => {
    for (const kind of ALL_STATION_KINDS) {
      const ids = floorSupervisorToolsForStation(TOKEN, kind).map((t) => t.id);
      expect(ids).not.toContain("bag-allocation");
    }
  });

  it("non-roll stations never expose rolls", () => {
    for (const kind of [
      "SEALING",
      "HANDPACK_BLISTER",
      "PACKAGING",
      "BOTTLE_HANDPACK",
      "BOTTLE_CAP_SEAL",
      "BOTTLE_STICKER",
    ] as const) {
      const ids = floorSupervisorToolsForStation(TOKEN, kind).map((t) => t.id);
      expect(ids).not.toContain("rolls");
    }
  });
});

describe("STATION-NAV-CLEANUP-2 · station page hides empty supervisor tools", () => {
  // P4b Task 5 (THE CUTOVER) — page.tsx no longer renders a
  // SupervisorToolsPanel; the same links live in the operator screen's
  // More sheet, sourced from the SAME floorSupervisorToolsForStation
  // helper via operatorMaterialLinks. The behaviour this pinned — an
  // empty tool list renders nothing rather than an empty disclosure —
  // is now a property of mapping over the list, so it is asserted where
  // the mapping happens.
  it("an empty tool list renders no material links in the More sheet", () => {
    const screenSrc = readFileSync(
      join(__dirname, "../../app/(floor)/floor/[token]/operator-screen.tsx"),
      "utf8",
    );
    expect(screenSrc).toMatch(/operatorMaterialLinks/);
    expect(screenSrc).toMatch(/materialLinks\.map/);
    // The helper is still the single source of which tools exist.
    expect(floorSupervisorToolsForStation(TOKEN, "PACKAGING")).toEqual([]);
  });
});

describe("STATION-NAV-CLEANUP-2 · variety-pack route", () => {
  it("redirects to station page instead of rendering allocation workflow", () => {
    expect(varietyPackPageSrc).toMatch(/redirect\(`\/floor\/\$\{token\}`\)/);
    expect(varietyPackPageSrc).not.toMatch(/Variety pack allocation/);
    expect(varietyPackPageSrc).not.toMatch(/startOrResumeVarietyRunAction/);
  });
});

describe("STATION-NAV-CLEANUP-3 · bag-allocation route", () => {
  it("redirects to station page instead of rendering allocation workflow", () => {
    expect(bagAllocationPageSrc).toMatch(/redirect\(`\/floor\/\$\{token\}`\)/);
    expect(bagAllocationPageSrc).not.toMatch(/openAllocationSessionAction/);
    expect(bagAllocationPageSrc).not.toMatch(/Bag allocation/);
  });
});

describe("STATION-NAV-CLEANUP-3 · station page nav scope", () => {
  it("main station page does not link to bag-allocation", () => {
    expect(pageSrc).not.toMatch(/\/bag-allocation/);
  });

  // P4b Task 5 (THE CUTOVER) — scan-card-form.tsx is DELETED. The scan
  // path it fronted is not: scanCardAction still owns the fresh-bag
  // start transaction, and operator-actions.ts's claim now routes an
  // unassigned RAW_BAG card into it (SCAN-FIRST-1). The "unchanged in
  // this task" scope note becomes an assertion that the start path is
  // still reachable, which is what the original was really protecting.
  it("the fresh-bag start path is still reachable from the floor scan", () => {
    const operatorActionsSrc = readFileSync(
      join(__dirname, "../../app/(floor)/floor/[token]/operator-actions.ts"),
      "utf8",
    );
    const actionsSrc = readFileSync(
      join(__dirname, "../../app/(floor)/floor/[token]/actions.ts"),
      "utf8",
    );
    expect(operatorActionsSrc).toMatch(/scanCardAction/);
    expect(actionsSrc).toMatch(/export async function scanCardAction/);
    expect(actionsSrc).not.toMatch(/bag-allocation\/page/);
  });
});

describe("STATION-MOBILE-UX-2 · loaded materials panel visibility", () => {
  it("HANDPACK_BLISTER shows loaded materials", () => {
    expect(stationShowsLoadedMaterialsPanel("HANDPACK_BLISTER")).toBe(true);
  });

  it("PACKAGING does not show loaded materials", () => {
    expect(stationShowsLoadedMaterialsPanel("PACKAGING")).toBe(false);
  });

  it("BLISTER does not show unit loaded-material panel", () => {
    expect(stationShowsLoadedMaterialsPanel("BLISTER")).toBe(false);
  });
});

describe("STATION-MOBILE-UX-2 · formatStationPageSubtitle", () => {
  it("formats kind and machine", () => {
    expect(formatStationPageSubtitle("BLISTER", "Blister Machine")).toBe(
      "blister · Blister Machine",
    );
  });
});

describe("STATION-SEALING-TOOLS-1 · roll station kinds", () => {
  it("roll kinds are blister press stations only — not sealing", () => {
    expect(FLOOR_ROLL_STATION_KINDS.has("BLISTER")).toBe(true);
    expect(FLOOR_ROLL_STATION_KINDS.has("COMBINED")).toBe(true);
    expect(FLOOR_ROLL_STATION_KINDS.has("SEALING")).toBe(false);
    expect(FLOOR_ROLL_STATION_KINDS.has("HANDPACK_BLISTER")).toBe(false);
    expect(FLOOR_ROLL_STATION_KINDS.has("PACKAGING")).toBe(false);
    expect(FLOOR_ROLL_STATION_KINDS.has("BOTTLE_HANDPACK")).toBe(false);
  });
});

describe("STATION-NAV-CLEANUP-2 · station kind sets", () => {
  it("roll kinds exclude hand-pack and packaging", () => {
    expect(FLOOR_ROLL_STATION_KINDS.has("BLISTER")).toBe(true);
    expect(FLOOR_ROLL_STATION_KINDS.has("HANDPACK_BLISTER")).toBe(false);
    expect(FLOOR_ROLL_STATION_KINDS.has("PACKAGING")).toBe(false);
    expect(FLOOR_ROLL_STATION_KINDS.has("BOTTLE_HANDPACK")).toBe(false);
  });
});
