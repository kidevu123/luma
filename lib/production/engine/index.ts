// The only module app/(floor)/ may import from lib/production.
// Enforced by the no-restricted-imports rule in eslint.config.mjs.

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

export {
  advanceBag,
  intentToEventType,
  buildRecordStageEventInput,
  buildRecordPackagingCompleteInput,
  shouldAssignProductFirst,
  isPackagingShapedComplete,
} from "./advance";
export { recordStageEvent, projectBagReleasedEvent } from "./record-stage-event";
export type { RecordStageEventInput, StationRow } from "./record-stage-event";
export {
  recordPackagingComplete,
  projectBagFinalizedEvent,
  resolveDeferredQrReleaseAfterPackaging,
} from "./record-packaging-complete";
export type { RecordPackagingCompleteInput } from "./record-packaging-complete";
export {
  assignBagProduct,
  OpenAllocationBlockError,
  raiseAllocationOpenFailure,
} from "./assign-bag-product";
export type {
  AssignBagProductInput,
  AssignBagProductResult,
} from "./assign-bag-product";
export { evaluateChecks, blockersFromChecks, blockerFor, blockerForWithDetail } from "./resolve-exceptions";
export type { CheckResult, EngineFacts } from "./resolve-exceptions";
export {
  raiseProductionException,
  PRODUCTION_EXCEPTION_CATEGORIES,
} from "./raise-production-exception";
export type {
  ProductionExceptionCategory,
  RaiseProductionExceptionInput,
  RaiseProductionExceptionResult,
} from "./raise-production-exception";
export { raiseDowntimeStarted } from "./raise-downtime";
export type { RaiseDowntimeInput, RaiseDowntimeResult } from "./raise-downtime";
export { raiseDowntimeEnded } from "./raise-downtime-ended";
export type { RaiseDowntimeEndedInput, RaiseDowntimeEndedResult } from "./raise-downtime-ended";
export { raiseQaHoldStarted } from "./raise-qa-hold";
export type { RaiseQaHoldInput, RaiseQaHoldResult } from "./raise-qa-hold";
export { raiseQaHoldRelease } from "./raise-qa-hold-release";
export type {
  RaiseQaHoldReleaseInput,
  RaiseQaHoldReleaseResult,
} from "./raise-qa-hold-release";
export { resolveCompletionInputs } from "./resolve-completion";
export { operationHasBagCloseGesture } from "./intent-events";
export {
  loadPartialAllocationFacts,
  resolvePartialAllocation,
} from "./resolve-partial-allocation";
export type {
  PartialAllocationFacts,
  ResolvePartialAllocationInput,
} from "./resolve-partial-allocation";
export {
  assembleCompletionInputs,
  autoProductSubmission,
  completionFieldLabel,
  helpChecklistForView,
  helpIdleNote,
  helpNotifyDetail,
  helpNotifyDisabled,
  helpNotifyRequiresBagCopy,
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
  reportProblemUsesStationReport,
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
export { resolveProductChoice } from "./resolve-product-choice";
export type { ProductChoice } from "./resolve-product-choice";
export { resolveOperation, pickOperationForStationKind } from "./resolve-operation";
export type { ResolvedOperation } from "./resolve-operation";
export { bagStageToQueueStageKey, queueStageKeyToBagStage } from "./stage-lexicon";
export {
  getStationView,
  assembleStationView,
  buildNextAction,
  loadCompatibleProductsForStation,
  mapQueueRowsToUpNext,
  operationVerb,
} from "./station-view";
export { resolveFreshBagStart } from "./fresh-bag-start";
export type { FreshBagStart } from "./fresh-bag-start";
export type {
  NextActionInput,
  QueueRowForUpNext,
  StationViewRows,
} from "./station-view";
export { claimQueuedBag, checkClaimGuards } from "./claim-queued-bag";
export type { ClaimGuardInput } from "./claim-queued-bag";
export { medianCycleMinutes, etaMinutes } from "./eta";
export { deriveQueueTransition, queueAfterWorkAt, queueRank } from "./queue-transitions";
export type { QueueDestination, QueueTransition } from "./queue-transitions";
export { resolveStationByToken, isStationTokenShape } from "../station-token";
// Floor auth, re-exported for the same reason resolveStationByToken is:
// every engine write documents "the caller MUST have authenticated the
// station" as a precondition, and a floor action cannot satisfy it
// without the active-station check that authStation performs. Without
// this the new operator actions would either reach across the boundary
// or re-implement the refusal with their own message.
export {
  assertStationActiveForFloorActions,
  STATION_INACTIVE_FLOOR_MESSAGE,
} from "../station-management";
export { floorEventRelevantToStation, queueKeysForStationKind } from "./floor-event-relevance";
// P6 Task 3 — floor SSE route needs to load the RouteGraph at connect
// time to thread into floorEventRelevantToStation. Cached loader; one
// DB hit per process; production callers omit the loader arg.
export { loadRouteGraph } from "./route-data";
export type { RouteGraph } from "./route-data";

// P4b Task 6 — floor import boundary at zero. Everything below backs a
// real read or write in a floor "use server" file (actions.ts,
// bag-allocation-actions.ts, operator-session-actions.ts, qc-actions.ts,
// roll-actions.ts, variety-run-actions.ts) that was reaching past the
// barrel into lib/production directly. None of this is new surface —
// it is the same production logic those actions already called; the
// boundary violation was the import path, not the dependency. See
// docs/superpowers/plans/2026-08-13-production-engine-p4b.md Task 6 and
// .superpowers/sdd/2026-08-13-production-engine-p4b/task-6-report.md
// for the per-symbol justification.

export { canResumeFinalizedWorkflowOnInventoryBag } from "../partial-bag-restart";
export {
  loadPartialReuseContext,
  type PartialBagSession,
  type PartialReuseContext,
} from "../partial-bags";
export { classifyFloorScanCard } from "../floor-scan-eligibility";
export { batchProductionBlockReason } from "../batch-production-guard";
export {
  loadRawBagStartClassificationForScan,
  RAW_BAG_START_OPERATOR_MESSAGES,
} from "../floor-partial-bag-start-resolution";
export {
  floorScanInputMatchesCard,
  pickBestFloorScanCard,
  type FloorScanCardCandidate,
} from "../floor-scan-resolve";
export { numericSuffix } from "../qr-sort";
export { floorReadinessOperatorMessage } from "../floor-readiness";
export { evaluateQrCardReadinessById } from "../floor-readiness-loaders";
export {
  STATION_RELEASE_FROM_STAGE,
  STATION_PICKUP_FROM_STAGE,
  STATION_STARTED_RESUME_FROM_STAGE,
  formatFloorStationBagOpenError,
  STATIONS_THAT_FINALIZE,
  bothBottleFinishingDone,
  missingBottleFinishingSteps,
  BOTTLE_FINISHING_EVENTS,
} from "../stage-progression";
export { coercePartialRemainingEstimate } from "../partial-remaining-input";
export {
  computeSystemDerivedResolutionForBag,
  buildFloorOpenAllocationBlock,
  resolveAllocationFromProductionOutput,
  type FloorOpenAllocationBlock,
} from "../system-derived-allocation-resolution";
export {
  resolveStationAccountability,
  withAccountabilityPayload,
  FIRST_OP_COUNT_ACCOUNTABILITY_STATION_KINDS,
  getActiveStationSession,
} from "../station-operator-session";
export { ensureOpenRawBagAllocationSessionForWorkflowBag } from "../raw-bag-allocation-lifecycle";
export { SEALING_SEGMENT_EVENT } from "../sealing-segments";
export {
  SEALING_PARTIAL_CLOSE_REASONS,
  isWorkflowBagResumableAtSealingAfterPartialPackaging,
} from "../sealing-partial-closeout";
export { lookupInventoryBagByQrScanToken } from "../workflow-bag-tablet-context";
export {
  parseNonnegativeIntegerInput,
  pauseCounterSnapshotMissingError,
  stationRequiresBlisterCounterSnapshot,
  isBlisterCounterSnapshotStation,
} from "../blister-counter-snapshot";
export { recordBlisterCounterRollSegment } from "../blister-roll-segments";
export { assertCounterSnapshotAllowed } from "../counter-snapshot-guard-loader";
export { checkFirstOpProductSelection } from "../first-op-product";
export {
  resolveNewSessionStartingBalance,
  checkOverAllocation,
  deriveBagStatusAfterClose,
} from "../bag-allocation";
export {
  AllocationOpenBlockedError,
  openAllocationSessionForBagStart,
} from "../bag-allocation-auto-open";
export { resolveAccountableEmployee } from "../accountability";
export { shouldRenderQcPanel } from "../qc-panel-helpers";
export {
  validateQcPayload,
  type PackagingDamageReturnPayload,
  type ReworkSentPayload,
  type ReworkReceivedPayload,
  type QCReasonCode,
  type QCUnit,
} from "../qc-events";
export { nextLotStatusForUnmount, getActiveRollsForMachine } from "../active-rolls";
export { filterSelectableIdleRollLots } from "../idle-roll-lots";

// P5-SUPERVISOR Task 2 — station supervisor session engine. Server
// barrel exports the whole surface (open/close/require/remaining),
// including the input + result types the floor action layer needs
// to shape its FormData handler. The client barrel below exports
// ONLY the pure ticker + type, because the module transitively
// imports @/lib/db and @/lib/db/audit.
export {
  SUPERVISOR_SESSION_TTL_MS,
  SUPERVISOR_GATE_REFUSAL_CODE,
  SUPERVISOR_GATE_REFUSAL_SENTENCE,
  openSupervisorSession,
  closeSupervisorSession,
  requireSupervisorSession,
  supervisorSessionRemainingSeconds,
} from "./supervisor-session";
export type {
  OpenSupervisorSessionInput,
  OpenSupervisorSessionResult,
  SupervisorSessionSnapshot,
} from "./supervisor-session";

// P5-SUPERVISOR Task 5(b) — bagless station exception reports. Server
// barrel export only (the module reaches @/lib/db + @/lib/db/audit);
// the floor action layer imports raiseStationReport + the category
// constant here. The client bundle never touches this — bagless-report
// UI just chooses a category from the layout constant already in the
// client barrel (STATION_REPORT_CATEGORIES is a strict subset of
// PRODUCTION_EXCEPTION_CATEGORIES).
export {
  raiseStationReport,
  STATION_REPORT_CATEGORIES,
  STATION_REPORT_DETAIL_MAX_LENGTH,
} from "./raise-station-report";
export type {
  RaiseStationReportInput,
  RaiseStationReportResult,
  StationReportCategory,
} from "./raise-station-report";
