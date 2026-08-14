// The engine's CLIENT-SAFE surface.
//
// Identical intent to index.ts — floor code talks to the engine and to
// nothing else in lib/production — but this entry point re-exports ONLY
// modules that touch no database. index.ts pulls in getStationView,
// advanceBag, station-token and friends, every one of which imports
// `@/lib/db`; a `"use client"` file importing that barrel drags the
// Postgres driver into the browser bundle and the Next build fails
// outright on `Can't resolve 'perf_hooks'`.
//
// So: server components and server actions import "@/lib/production/
// engine"; `"use client"` components import "@/lib/production/engine/
// client". Both are permitted by the no-restricted-imports group in
// eslint.config.mjs, and nothing else under lib/production is.
//
// RULE FOR ADDING TO THIS FILE: the module you re-export, and its whole
// transitive import graph, must be free of `@/lib/db`. Everything here
// today is pure logic plus types.

export type {
  AdvanceInput,
  AdvanceIntent,
  AdvanceResult,
  Blocker,
  CompletionInput,
  CurrentWork,
  NextAction,
  ProductOption,
  StationView,
  UpNextBag,
} from "./types";

export { evaluateChecks, blockersFromChecks, blockerFor } from "./resolve-exceptions";
export type { CheckResult, EngineFacts } from "./resolve-exceptions";

export { resolveCompletionInputs } from "./resolve-completion";

// SEALING-PARTIAL-CLOSEOUT-1's reason vocabulary. Pure constants (the
// module imports only sealing-segments.ts), and the ONLY list the
// "Close sealing early" flow may draw its buttons from —
// validateSealingPartialCloseInput refuses any reason outside it, so a
// UI-local copy would be a screen that offers refusals.
export {
  SEALING_PARTIAL_CLOSE_REASONS,
  SEALING_PARTIAL_CLOSE_REASON_LABELS,
} from "@/lib/production/sealing-partial-closeout";
export type { SealingPartialCloseReason } from "@/lib/production/sealing-partial-closeout";
export { resolveProductChoice } from "./resolve-product-choice";
export type { ProductChoice } from "./resolve-product-choice";
export { operationHasBagCloseGesture, intentToEventType } from "./intent-events";

// TYPE ONLY. raise-production-exception.ts is a server module (it
// reaches the database through emit-stationed-event.ts), but a type
// re-export is erased at compile time and pulls nothing into the bundle.
// The runtime category list stays on the server barrel; the screen never
// needs it — REPORT_PROBLEM_CATEGORY_LAYOUT below is the client's
// ordered copy, and it is typed against this union so the two cannot
// drift.
export type { ProductionExceptionCategory } from "./raise-production-exception";

// P4b Task 6 — floor import boundary at zero. Each of these backs a
// mounted "use client" floor component (operator-session-form.tsx,
// qc-panel.tsx, rolls-forms.tsx, open-allocation-calc-panel.tsx) that
// was reaching past the barrel. All are pure logic — no module in
// their import graph touches @/lib/db — per client.test.ts's walk.

// TYPE ONLY: system-derived-allocation-resolution.ts reaches the
// database (computeSystemDerivedResolutionForBag etc., server barrel
// only), but FloorOpenAllocationBlock is a plain data shape and the
// type import is erased at compile time.
export type { FloorOpenAllocationBlock } from "@/lib/production/system-derived-allocation-resolution";

export {
  isBlisterCounterSnapshotStation,
  parseNonnegativeIntegerInput,
  shiftEndCounterSnapshotHelperText,
  shiftEndCounterSnapshotMissingError,
} from "@/lib/production/blister-counter-snapshot";

export {
  QUICK_DAMAGE_ENTRIES,
  damageHasReworkShortcut,
  type QuickDamageType,
} from "@/lib/production/qc-panel-helpers";

export {
  filterIdleRollLotsForRole,
  idleRollLotMatchesRole,
} from "@/lib/production/idle-roll-lots";
export { sortRollLotsForPicker } from "@/lib/production/roll-lot-sort";

export {
  assembleCompletionInputs,
  autoProductSubmission,
  completionFieldLabel,
  helpChecklistForView,
  helpIdleNote,
  helpNotifyDetail,
  EXCEPTION_DETAIL_MAX_LENGTH,
  operatorMaterialLinks,
  operatorPauseModel,
  partialScreenFor,
  pauseCounterSnapshotCopy,
  pauseNeedsCounterSnapshot,
  primaryBlockerSentence,
  progressPercent,
  REPORT_PROBLEM_CATEGORY_LAYOUT,
  reportProblemCategoryDisabled,
  reportProblemRouteFor,
  shouldSubmitAutoProduct,
  upNextSummary,
} from "./operator-screen-model";
export type {
  AutoProductSubmission,
  CompletionAssembly,
  FloorSupervisorToolLink,
  OperatorPauseModel,
  PartialScreen,
  PauseReason,
  ReportProblemRoute,
} from "./operator-screen-model";
