import { describe, it, expect } from "vitest";
import {
  FLOOR_ROLL_STATION_KINDS,
  FLOOR_VARIETY_PACK_STATION_KINDS,
  floorSupervisorToolsForStation,
  formatStationPageSubtitle,
  stationShowsLoadedMaterialsPanel,
} from "./floor-station-mobile-nav";

const TOKEN = "station-token-abc";

describe("STATION-MOBILE-UX-1 · floorSupervisorToolsForStation", () => {
  it("BLISTER gets rolls and variety pack only", () => {
    const tools = floorSupervisorToolsForStation(TOKEN, "BLISTER");
    expect(tools.map((t) => t.id)).toEqual(["rolls", "variety-pack"]);
  });

  it("COMBINED gets rolls and variety pack only", () => {
    expect(
      floorSupervisorToolsForStation(TOKEN, "COMBINED").map((t) => t.id),
    ).toEqual(["rolls", "variety-pack"]);
  });

  it("no station exposes bag allocation in supervisor tools", () => {
    for (const kind of [
      "BLISTER",
      "COMBINED",
      "SEALING",
      "HANDPACK_BLISTER",
      "BOTTLE_HANDPACK",
      "PACKAGING",
    ]) {
      const ids = floorSupervisorToolsForStation(TOKEN, kind).map((t) => t.id);
      expect(ids).not.toContain("bag-allocation");
    }
  });

  it("PACKAGING gets no supervisor tool links", () => {
    expect(floorSupervisorToolsForStation(TOKEN, "PACKAGING")).toEqual([]);
  });

  it("SEALING gets rolls only", () => {
    expect(floorSupervisorToolsForStation(TOKEN, "SEALING").map((t) => t.id)).toEqual(
      ["rolls"],
    );
  });

  it("HANDPACK_BLISTER gets variety pack only", () => {
    expect(
      floorSupervisorToolsForStation(TOKEN, "HANDPACK_BLISTER").map((t) => t.id),
    ).toEqual(["variety-pack"]);
  });

  it("BOTTLE_HANDPACK gets variety pack only", () => {
    expect(
      floorSupervisorToolsForStation(TOKEN, "BOTTLE_HANDPACK").map((t) => t.id),
    ).toEqual(["variety-pack"]);
  });

  it("BOTTLE_CAP_SEAL and BOTTLE_STICKER get no supervisor tools", () => {
    expect(floorSupervisorToolsForStation(TOKEN, "BOTTLE_CAP_SEAL")).toEqual([]);
    expect(floorSupervisorToolsForStation(TOKEN, "BOTTLE_STICKER")).toEqual([]);
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

describe("STATION-MOBILE-UX-1 · station kind sets", () => {
  it("roll kinds are blister-path machine stations", () => {
    expect(FLOOR_ROLL_STATION_KINDS.has("BLISTER")).toBe(true);
    expect(FLOOR_ROLL_STATION_KINDS.has("PACKAGING")).toBe(false);
  });

  it("variety pack kinds match first-op variety-capable stations", () => {
    expect(FLOOR_VARIETY_PACK_STATION_KINDS.has("BOTTLE_HANDPACK")).toBe(true);
    expect(FLOOR_VARIETY_PACK_STATION_KINDS.has("BOTTLE_CAP_SEAL")).toBe(false);
  });
});
