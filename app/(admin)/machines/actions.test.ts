import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const actionsSrc = readFileSync(join(__dirname, "actions.ts"), "utf8");
const formsSrc = readFileSync(join(__dirname, "forms.tsx"), "utf8");

describe("SEALING-COUNTER-1 · admin machine cards per press", () => {
  it("updateMachineCardsPerTurnAction validates positive integer", () => {
    expect(actionsSrc).toMatch(/updateMachineCardsPerTurnAction/);
    expect(actionsSrc).toMatch(/cardsPerTurn: z\.coerce\.number\(\)\.int\(\)\.min\(1\)/);
  });

  it("create machine form labels cards per press for sealing config", () => {
    expect(formsSrc).toMatch(/Cards per press/);
    expect(formsSrc).toMatch(/sealing machine can seal per press/i);
  });

  it("EditCardsPerPressForm allows inline update", () => {
    expect(formsSrc).toMatch(/EditCardsPerPressForm/);
    expect(formsSrc).toMatch(/updateMachineCardsPerTurnAction/);
  });
});
