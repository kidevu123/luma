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
  // produces output, and is always optional. Gate on outputUnit rather
  // than on inputs.length: "produces output" is the actual rule, and an
  // operation could gain a derived count without requiresCounter.
  if (op.outputUnit != null) {
    inputs.push({
      key: "damaged",
      label: "Damaged",
      // 2026-08-13 decision: packaging damage is counted in loose
      // cards/units regardless of which of the three packaging counts
      // (cases, displays, loose) the operator is otherwise reporting —
      // one field, unit "units". Non-packaging operations keep the
      // operation's own outputUnit.
      unit: PACKAGING_OPERATIONS.has(op.operationCode) ? "units" : op.outputUnit,
      required: false,
    });
  }

  return inputs;
}
