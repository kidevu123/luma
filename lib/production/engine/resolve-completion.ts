// What must the operator physically supply to complete this operation?
//
// Driven entirely by route_operations columns (requires_counter,
// output_unit, operation code). No station-kind switch — that is the
// pattern this engine exists to delete.

import type { RouteOperationView } from "@/lib/production/routes";
import type { CompletionInput } from "./types";

/** Operations whose output is a packed case count rather than a single
 *  machine counter reading. Packaging reports three physical numbers. */
const PACKAGING_OPERATIONS: ReadonlySet<string> = new Set(["PACKAGING"]);

export function resolveCompletionInputs(
  op: RouteOperationView,
): CompletionInput[] {
  const inputs: CompletionInput[] = [];

  if (PACKAGING_OPERATIONS.has(op.operationCode)) {
    inputs.push(
      { key: "cases", label: "Cases", unit: "cases", required: true },
      { key: "displays", label: "Displays", unit: "displays", required: false },
      { key: "loose", label: "Loose units", unit: "units", required: false },
    );
  } else if (op.requiresCounter) {
    inputs.push({
      key: "counter",
      label: "Counter",
      unit: op.outputUnit,
      required: true,
    });
  }

  // Physical damage is a human observation at every operation that
  // produces output, and is always optional.
  if (inputs.length > 0) {
    inputs.push({ key: "damaged", label: "Damaged", unit: op.outputUnit, required: false });
  }

  return inputs;
}
