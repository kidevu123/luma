import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  FLOOR_ROLL_STATION_KINDS,
  FLOOR_VARIETY_PACK_STATION_KINDS,
  floorSupervisorToolsForStation,
  formatStationPageSubtitle,
  stationShowsLoadedMaterialsPanel,
} from "./floor-station-mobile-nav";

const TOKEN = "station-token-abc";
const pageSrc = readFileSync(
  join(__dirname, "../../app/(floor)/floor/[token]/page.tsx"),
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

describe("STATION-TOOLS-CLEANUP-2 · floorSupervisorToolsForStation", () => {
  it("HANDPACK_BLISTER has no supervisor tools", () => {
    expect(floorSupervisorToolsForStation(TOKEN, "HANDPACK_BLISTER")).toEqual([]);
  });

  it("BLISTER gets rolls only (no variety pack)", () => {
    expect(floorSupervisorToolsForStation(TOKEN, "BLISTER").map((t) => t.id)).toEqual(
      ["rolls"],
    );
  });

  it("COMBINED gets rolls only (no variety pack)", () => {
    expect(floorSupervisorToolsForStation(TOKEN, "COMBINED").map((t) => t.id)).toEqual(
      ["rolls"],
    );
  });

  it("BOTTLE_HANDPACK gets variety pack only (no rolls)", () => {
    expect(
      floorSupervisorToolsForStation(TOKEN, "BOTTLE_HANDPACK").map((t) => t.id),
    ).toEqual(["variety-pack"]);
  });

  it("PACKAGING, BOTTLE_CAP_SEAL, and BOTTLE_STICKER get no tools", () => {
    expect(floorSupervisorToolsForStation(TOKEN, "PACKAGING")).toEqual([]);
    expect(floorSupervisorToolsForStation(TOKEN, "BOTTLE_CAP_SEAL")).toEqual([]);
    expect(floorSupervisorToolsForStation(TOKEN, "BOTTLE_STICKER")).toEqual([]);
  });

  it("SEALING keeps rolls for machine roll management", () => {
    expect(floorSupervisorToolsForStation(TOKEN, "SEALING").map((t) => t.id)).toEqual(
      ["rolls"],
    );
  });

  it("no station exposes bag allocation in supervisor tools", () => {
    for (const kind of ALL_STATION_KINDS) {
      const ids = floorSupervisorToolsForStation(TOKEN, kind).map((t) => t.id);
      expect(ids).not.toContain("bag-allocation");
    }
  });

  it("card/blister kinds never expose variety pack", () => {
    for (const kind of ["BLISTER", "HANDPACK_BLISTER", "COMBINED", "SEALING"] as const) {
      const ids = floorSupervisorToolsForStation(TOKEN, kind).map((t) => t.id);
      expect(ids).not.toContain("variety-pack");
    }
  });

  it("non-roll stations never expose rolls", () => {
    for (const kind of [
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

describe("STATION-TOOLS-CLEANUP-2 · station page hides empty supervisor tools", () => {
  it("SupervisorToolsPanel returns null when tools array is empty", () => {
    expect(pageSrc).toMatch(/function SupervisorToolsPanel/);
    expect(pageSrc).toMatch(/if \(tools\.length === 0\) return null/);
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

describe("STATION-TOOLS-CLEANUP-2 · station kind sets", () => {
  it("roll kinds are PVC/foil machine stations only", () => {
    expect(FLOOR_ROLL_STATION_KINDS.has("BLISTER")).toBe(true);
    expect(FLOOR_ROLL_STATION_KINDS.has("HANDPACK_BLISTER")).toBe(false);
    expect(FLOOR_ROLL_STATION_KINDS.has("PACKAGING")).toBe(false);
  });

  it("variety pack tool is bottle handpack only", () => {
    expect(FLOOR_VARIETY_PACK_STATION_KINDS.has("BOTTLE_HANDPACK")).toBe(true);
    expect(FLOOR_VARIETY_PACK_STATION_KINDS.has("BLISTER")).toBe(false);
    expect(FLOOR_VARIETY_PACK_STATION_KINDS.has("BOTTLE_CAP_SEAL")).toBe(false);
  });
});
