import { describe, it, expect } from "vitest";

describe("receive detail bag ordinal", () => {
  it("bag ordinal ordering: lower bagNumber comes first", () => {
    const bags = [
      { id: "a", bagNumber: 3 },
      { id: "b", bagNumber: 1 },
      { id: "c", bagNumber: 2 },
    ];
    const sorted = [...bags].sort((a, b) => a.bagNumber - b.bagNumber);
    expect(sorted.map((b) => b.bagNumber)).toEqual([1, 2, 3]);
  });

  it("bag ordinal label is 'Bag N' using bagNumber", () => {
    const bag = { bagNumber: 4 };
    const label = `Bag ${bag.bagNumber}`;
    expect(label).toBe("Bag 4");
  });
});
