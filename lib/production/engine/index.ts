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
export { evaluateChecks, blockersFromChecks, blockerFor } from "./resolve-exceptions";
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
export { raiseQaHoldStarted } from "./raise-qa-hold";
export type { RaiseQaHoldInput, RaiseQaHoldResult } from "./raise-qa-hold";
export { resolveCompletionInputs } from "./resolve-completion";
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
export { resolveProductChoice } from "./resolve-product-choice";
export type { ProductChoice } from "./resolve-product-choice";
export { resolveOperation, pickOperationForStationKind } from "./resolve-operation";
export type { ResolvedOperation } from "./resolve-operation";
export { bagStageToQueueStageKey, queueStageKeyToBagStage } from "./stage-lexicon";
export {
  getStationView,
  assembleStationView,
  buildNextAction,
  mapQueueRowsToUpNext,
  operationVerb,
} from "./station-view";
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
