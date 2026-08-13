# Production Engine — Phase 4a Implementation Plan (engine full-fidelity)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `advanceBag` becomes a complete substitute for every normal-flow floor action — packaging's three counts and damage flow through it, ambiguous products resolve to a filtered operator pick, partial-close fields pass through, and the P3 notify gap closes — so P4b's screen rewrite has a finished engine to sit on.

**Architecture:** Repeat Phase 1's proven extraction pattern (see `lib/production/engine/record-stage-event.ts`) on `packagingCompleteAction`: move its body verbatim into a shared `record-packaging-complete.ts` that the action and `advanceBag` both call. Product ambiguity becomes a `PICK_PRODUCT` `NextAction` variant fed by the engine (filtered list; unambiguous auto-resolves). The projector gains an in-process stationId→kind cache so EVERY notify carries `stationKind`. Zero visible UI change — P4b owns the screens.

**Tech Stack:** unchanged. No new dependencies.

**Decisions (from the user, 2026-08-13):** packaging damage is counted in LOOSE CARDS/UNITS — one field, mapped to the packaging payload's ripped/damaged-units count, unit label "units"; ambiguous tablet→product resolution is an OPERATOR pick from a filtered list (2-3 compatible products), auto-resolved when unambiguous.

## Global Constraints

- No emoji. TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- No DB in tests; pure functions carry coverage; extractions are verified by the full suite + staging smoke. Do not mock `@/lib/db`.
- Extractions are PURE RELOCATIONS — no behaviour change, no reordering, no error-string edits; the P1 Task 7 discipline (report the verbatim-diff line count).
- ~36 source-text scanners; splice pattern per `actions.test.ts` precedent; source-loading fixes only unless behaviour legitimately changed, all listed.
- Full suite 0 failures after every task (currently 5429/0); typecheck/lint clean; ratchet ≤ 80; build green.
- Version `1.32.0` → `1.33.0` in the final task; CHANGELOG bracketed header.
- Do NOT push.

---

### Task 1: Extract `packagingCompleteAction`'s body

**Files:** Create `lib/production/engine/record-packaging-complete.ts`; modify `app/(floor)/floor/[token]/actions.ts` (`packagingCompleteAction`, ~line 2361, ~500 lines: consumption, closeout, auto-finalize); barrel export.

The P1 Task 7 playbook, exactly: read the whole action; move the post-zod, post-`authStation` body verbatim into `recordPackagingComplete(input: RecordPackagingCompleteInput)`; the action keeps parse + auth + `revalidatePath` and delegates. `RecordPackagingCompleteInput` mirrors what the body reads from parsed data (`station`, `workflowBagId`, `masterCases`, `displaysMade`, `looseCards`, `damagedPackaging`, `rippedCards`, `keepBagPartial?`, `clientEventId?`, `overrideEmployeeCode?`, plus whatever else the body actually reads — enumerate in the report). Run the FULL suite mid-task after the move, before any other edit. Scanner splice: mirror how `actions.test.ts` splices `record-stage-event.ts`; add the new file to the OP-1 scanner's `LIVE_EMISSION_FILES` if it emits events (it does). Doc comment: station auth is caller-held. Commit `feat(engine): extract packaging-complete recording (verbatim relocation)`.

### Task 2: Packaging through `advanceBag` + damage decision

**Files:** `lib/production/engine/types.ts` (AdvanceInput.inputs gains `damaged?: number` semantics doc: loose units), `advance.ts`, `resolve-completion.ts` + tests, `record-packaging-complete.ts` (no behaviour change).

- `resolveCompletionInputs`: packaging's `damaged` input gets `unit: "units"` and a comment citing the 2026-08-13 decision (replaces the deliberate `null` from P1; update the P1-era test "leaves the damaged count unitless at packaging" to pin `"units"` — legitimate behaviour change, note it).
- `advanceBagInner`: `COMPLETE` intent at operation `PACKAGING` routes to `recordPackagingComplete` (not `recordStageEvent`) mapping `{cases→masterCases, displays→displaysMade, loose→looseCards, damaged→rippedCards, damagedPackaging: 0}` — comment: operator-counted damage is loose units (ripped cards); packaging-material damage stays an exception-flow concern. Same total-function wrapper; returns refreshed view.
- Pure `buildRecordPackagingCompleteInput` mapper + tests (counts routing, damaged→rippedCards, zero-defaults, clientEventId passthrough).
- Shrink `advanceBag`'s remaining-limitations comment to: partial-close fields (Task 3 closes), sealing product (Task 4 closes).
Commit `feat(engine): packaging counts and damage flow through advanceBag`.

### Task 3: Partial-close and override passthrough

**Files:** `types.ts`, `advance.ts` + tests.

`AdvanceInput` gains optional `sealingCloseMode`, `partialCloseReason`, `partialCloseReasonNote`, `overrideEmployeeCode` — passed through `buildRecordStageEventInput` to the already-existing `RecordStageEventInput` fields (presence-preserving: absent stays absent, per the `counterPresses` precedent — `exactOptionalPropertyTypes` discipline). Tests: each field passes through; absent fields do not materialize keys. Delete the limitations comment entirely and replace with: "Full fidelity as of P4a; the legacy actions remain only for the old UI (P4b retires them)." Commit `feat(engine): partial-close and override fields through advanceBag`.

### Task 4: `PICK_PRODUCT` NextAction + product resolution

**Files:** `types.ts`, `station-view.ts` + tests, `advance.ts` + tests, barrel.

- `NextAction` gains `{ kind: "PICK_PRODUCT"; options: Array<{ productId: string; name: string; sku: string }> }` — doc: shown only when the bag's tablet type maps to 2+ active compatible products; 1 auto-resolves; 0 stays BLOCKED (`PRODUCT_UNRESOLVED`).
- Pure `resolveProductChoice(compatible: Array<{...}>): { kind: "AUTO"; productId: string } | { kind: "PICK"; options: [...] } | { kind: "NONE" }` + tests (0/1/many).
- `getStationView`: when `current` has no `productId`, load compatible products for the bag's tablet type (the `product_allowed_tablets` join used at `page.tsx:179-196` — move the query shape, filtered to the station's allowed kinds via `STATION_KIND_TO_PRODUCT_KINDS`); thread through `StationViewRows` as data; `assembleStationView` (pure) applies `resolveProductChoice` BEFORE the blocker checks — `PICK_PRODUCT` outranks `BLOCKED(PRODUCT_UNRESOLVED)` when options exist.
- `AdvanceInput` gains `productId?: string`; COMPLETE/CLAIM pass it to the existing product-selection field (`pickedSealingProductId` for sealing ops; first-op product goes through the existing `PRODUCT_MAPPED` path — read `saveSealingProductAction` and the first-op flow before wiring; if first-op mapping cannot ride `recordStageEvent`, expose engine `assignBagProduct(...)` wrapping the existing helper and document it for P4b).
Commit `feat(engine): PICK_PRODUCT resolution with filtered options`.

### Task 5: stationKind on every notify (P3 gap A)

**Files:** `lib/projector/station-kind-cache.ts` (new, ~30 lines) + pure test, `lib/projector/index.ts`, `lib/projector/bag-queue.ts`.

In-process `Map<stationId, kind>` with a `getStationKind(tx, stationId)` that queries once per process per station (stations change kind ~never; rotation invalidation unnecessary — comment why). `projectEvent`'s notify block: `stationKind: queueInfo.stationKind ?? (ev.stationId ? await getStationKind(tx, ev.stationId) : null)`. Now BAG_PAUSED/RESUMED reach same-kind tablets (closes the pause/resume blindspot in `p1-outcomes.md` "Known Phase 3 gaps" — update that doc: gap (a) closed, cite commit). `bag-queue.ts` may also use the cache for its own stationKind fetch (optional; only if it simplifies — no behaviour change). Pure test: cache returns memoized value without a second fetch (inject a counting fake loader — the module accepts a loader param for testability, defaulting to the DB query). Commit `feat(sse): every stationed notify carries stationKind via process cache`.

### Task 6: v1.33.0 + docs

Version bump; CHANGELOG `## [1.33.0] — <date>` ("Phase 4a: advanceBag reaches full fidelity — packaging counts and loose-unit damage, partial-close and override passthrough, filtered product picking, stationKind on every notify. No visible change; the new operator screen lands in 4b."); smoke additions (packaging complete via engine parity: same payload as the action for identical inputs — assert against `zoho`-side expectations unchanged; pause at blister now refreshes sealing tablets); outcomes doc: P4a section, gap (a) closed, damage + product decisions recorded. Commit `chore(release): v1.33.0 production engine phase 4a`.

---

## Exit criteria

Full suite 0 failures; typecheck/lint/build clean; ratchet ≤ 80; extractions verbatim-verified; `advanceBag` has NO remaining fidelity gaps (the limitations comment is gone); zero visible UI change.

## Deferred to P4b

The operator screen (seven render cases incl. PICK_PRODUCT), scan-first UX, More menu, Help diagnosis, single exception workflow + `PRODUCTION_EXCEPTION_RAISED` migration, retiring legacy actions and their scanners, boundary ratchet 80 → 0 → `"error"`, inactive-station self-recovery mount, subscribers gauge.
