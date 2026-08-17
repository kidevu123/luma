// What must the operator physically supply to complete this operation?
//
// Driven entirely by route_operations columns (requires_counter,
// output_unit, operation code). No station-kind switch — that is the
// pattern this engine exists to delete.

import { stationUsesSealingCounter } from "@/lib/production/sealing-counter";
import type { RouteOperationView } from "@/lib/production/routes";
import type { CompletionInput } from "./types";

/** Operations whose output is a packed case count rather than a single
 *  machine counter reading. Packaging reports three physical numbers. */
const PACKAGING_OPERATIONS: ReadonlySet<string> = new Set(["PACKAGING"]);

/** The one operation whose count is a MACHINE PRESS count rather than a
 *  unit count. Kept as a constant so the pairing with
 *  stationUsesSealingCounter below reads as one rule. */
const SEALING_COUNTER_OPERATION = "HEAT_SEAL";

/** P4b Task 5 — SEALING-COUNTER plumbing.
 *
 *  recordStageEvent REFUSES a sealing segment whose `counterPresses` is
 *  undefined (SEALING_COUNTER_PRESS_ERROR), and it derives the sealed
 *  card count itself by multiplying presses by the machine's
 *  cards-per-press. So at a sealing station the operator's number is
 *  PRESSES, not cards: emitting the generic `counter` field there would
 *  put a card count into countTotal, leave counterPresses absent, and
 *  the engine would refuse every sealing DONE.
 *
 *  Gated on the STATION KIND as well as the operation because
 *  stationUsesSealingCounter is the same predicate page.tsx used to
 *  decide whether to resolve cards-per-press at all — a sealing-shaped
 *  operation at a station that does not carry the machine counter keeps
 *  the plain counter field. */
export function resolveCompletionInputs(
  op: RouteOperationView,
  opts?: { stationKind?: string },
): CompletionInput[] {
  const inputs: CompletionInput[] = [];
  const usesSealingCounter =
    op.operationCode === SEALING_COUNTER_OPERATION &&
    opts?.stationKind != null &&
    stationUsesSealingCounter(opts.stationKind);

  if (PACKAGING_OPERATIONS.has(op.operationCode)) {
    inputs.push(
      { key: "cases", label: "Cases", unit: "cases", required: true },
      { key: "displays", label: "Displays", unit: "displays", required: false },
      { key: "loose", label: "Loose units", unit: "units", required: false },
      // 2026-08-17 user decision: packaging stations get a second compact
      // damage input for packaging-material damage (foil, cases, labels) —
      // distinct from the loose-unit `damaged` field below which counts
      // ripped/cracked cards and bottles. Rendered via the same
      // CompletionInput-driven loop as every other field; no special-casing
      // in the screen. Absent → 0 in buildRecordPackagingCompleteInput,
      // following the counterPresses precedent.
      {
        key: "damagedPackaging",
        label: "Damaged packaging",
        unit: "units",
        required: false,
      },
    );
  } else if (usesSealingCounter) {
    inputs.push({
      key: "counterPresses",
      label: "Counter",
      // "presses", never the operation's outputUnit (cards): the number
      // the operator reads off the machine is presses, and labelling it
      // in cards would invite them to type a card count the engine would
      // then multiply.
      unit: "presses",
      required: true,
    });
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
