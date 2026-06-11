// Expected raw-tablet consumption from finished output and product structure.

export type ExpectedTabletConsumptionBlocker =
  | "MISSING_TABLETS_PER_UNIT"
  | "MISSING_OUTPUT_QUANTITY";

export type ExpectedTabletConsumptionResult =
  | {
      ok: true;
      expectedConsumed: number;
      tabletsPerUnit: number;
      unitsProduced: number;
    }
  | {
      ok: false;
      blocker: ExpectedTabletConsumptionBlocker;
      message: string;
    };

/** sellable units produced × tabletsPerUnit for card/bottle products. */
export function computeExpectedTabletConsumptionFromProduct(
  tabletsPerUnit: number | null | undefined,
  unitsProduced: number | null | undefined,
): ExpectedTabletConsumptionResult {
  if (unitsProduced == null || unitsProduced <= 0) {
    return {
      ok: false,
      blocker: "MISSING_OUTPUT_QUANTITY",
      message:
        "Output quantity is missing or zero — cannot derive tablet consumption from production counts.",
    };
  }
  if (tabletsPerUnit == null || tabletsPerUnit <= 0) {
    return {
      ok: false,
      blocker: "MISSING_TABLETS_PER_UNIT",
      message:
        "Product tablets-per-unit is not configured — set it on the product before issuing this lot.",
    };
  }
  return {
    ok: true,
    expectedConsumed: tabletsPerUnit * unitsProduced,
    tabletsPerUnit,
    unitsProduced,
  };
}

export function computeEndingBalanceFromConsumption(
  startingBalanceQty: number | null | undefined,
  consumedQty: number,
): number | null {
  if (startingBalanceQty == null) return null;
  return startingBalanceQty - consumedQty;
}
