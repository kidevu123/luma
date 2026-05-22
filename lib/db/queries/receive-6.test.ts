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

describe("formatFlavorSummary", () => {
  function formatFlavorSummary(tabletTypes: string | null): string {
    if (!tabletTypes) return "—";
    const parts = tabletTypes.split(", ");
    if (parts.length === 1) return parts[0]!;
    return `${parts[0]!} + ${parts.length - 1} more`;
  }

  it("shows — for null", () => {
    expect(formatFlavorSummary(null)).toBe("—");
  });

  it("shows the name directly for a single tablet type", () => {
    expect(formatFlavorSummary("MIT B Green Apple")).toBe("MIT B Green Apple");
  });

  it("shows first + N more for two tablet types", () => {
    expect(formatFlavorSummary("MIT B Blue Raspberry, MIT B Green Apple"))
      .toBe("MIT B Blue Raspberry + 1 more");
  });

  it("shows first + N more for three tablet types", () => {
    expect(
      formatFlavorSummary("MIT B Grape, MIT B Green Apple, MIT B Strawberry"),
    ).toBe("MIT B Grape + 2 more");
  });
});
