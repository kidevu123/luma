import { describe, it, expect } from "vitest";
import { buildReceiveEditPatch } from "./receive-edits";

describe("RECEIVE-EDIT-2B-1 · buildReceiveEditPatch", () => {
  const open: { notes: string | null; closedAt: Date | null } = {
    notes: "Initial note",
    closedAt: null,
  };

  const closedAt = new Date("2026-05-27T10:00:00.000Z");
  const closed = { notes: "Initial note", closedAt };

  it("returns null when nothing changed", () => {
    expect(buildReceiveEditPatch(open, { isClosed: false, notes: "Initial note" })).toBeNull();
    expect(buildReceiveEditPatch(closed, { isClosed: true, notes: "Initial note" })).toBeNull();
  });

  it("updates notes only", () => {
    const patch = buildReceiveEditPatch(open, {
      isClosed: false,
      notes: "Updated note",
    });
    expect(patch).toEqual({ notes: "Updated note", closedAt: null });
  });

  it("closes an open receive with a timestamp", () => {
    const patch = buildReceiveEditPatch(open, { isClosed: true, notes: "Initial note" });
    expect(patch?.closedAt).toBeInstanceOf(Date);
    expect(patch?.notes).toBe("Initial note");
  });

  it("preserves existing closedAt when already closed", () => {
    const patch = buildReceiveEditPatch(closed, {
      isClosed: true,
      notes: "Still closed",
    });
    expect(patch?.closedAt).toBe(closedAt);
  });

  it("reopens a closed receive", () => {
    const patch = buildReceiveEditPatch(closed, {
      isClosed: false,
      notes: "Initial note",
    });
    expect(patch).toEqual({ notes: "Initial note", closedAt: null });
  });
});
