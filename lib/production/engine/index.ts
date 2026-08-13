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
} from "./advance";
export { recordStageEvent, projectBagReleasedEvent } from "./record-stage-event";
export type { RecordStageEventInput, StationRow } from "./record-stage-event";
export {
  recordPackagingComplete,
  projectBagFinalizedEvent,
  resolveDeferredQrReleaseAfterPackaging,
} from "./record-packaging-complete";
export type { RecordPackagingCompleteInput } from "./record-packaging-complete";
export { evaluateChecks, blockersFromChecks, blockerFor } from "./resolve-exceptions";
export type { CheckResult, EngineFacts } from "./resolve-exceptions";
export { resolveCompletionInputs } from "./resolve-completion";
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
export { floorEventRelevantToStation, queueKeysForStationKind } from "./floor-event-relevance";
