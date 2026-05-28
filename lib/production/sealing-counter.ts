/** SEALING-COUNTER-1 — machine counter presses × cards per press. */

export const SEALING_COUNTER_CONFIG_ERROR =
  "Sealing machine is missing cards per press configuration.";

export const SEALING_COUNTER_PRESS_ERROR =
  "Enter a valid machine counter presses value.";

/** Station kinds whose SEALING_COMPLETE path uses the machine counter. */
export function stationUsesSealingCounter(stationKind: string): boolean {
  return stationKind === "SEALING" || stationKind === "COMBINED";
}

/** Resolve cards-per-press from the station's bound machine row. */
export function resolveSealingCardsPerPress(
  machine: { cardsPerTurn: number } | null | undefined,
  stationMachineId: string | null | undefined,
): number | null {
  if (!stationMachineId || !machine) return null;
  if (!Number.isInteger(machine.cardsPerTurn) || machine.cardsPerTurn < 1) {
    return null;
  }
  return machine.cardsPerTurn;
}

export function computeSealedCountFromCounter(
  counterPresses: number,
  cardsPerPress: number,
): number {
  return counterPresses * cardsPerPress;
}
