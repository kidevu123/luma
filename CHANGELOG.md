# Changelog

## [1.19.2] — 2026-07-03

### Fixed — QR-RESERVE-REPAIR-1: misleading "Not ready for floor" + lost-reservation repair
- **Root cause (data + copy, not a floor-ready logic bug):** floor readiness joins `qr_cards.scan_token = inventory_bags.bag_qr_code` and requires the card `status = ASSIGNED` (reserved) — the same source of truth the floor scan uses. For the reported bag (PO-00238-R2 Bag 5, receipt 352188, `bag-card-199`), the bag correctly points at `bag-card-199`, but that card is **IDLE** (its intake reservation was lost/desynced), so floor-ready *correctly* reports "not ready". The problem was the **message**: `BLOCKED_QR_NOT_ASSIGNED_OR_RESERVED` → "Receive and reserve this QR on the Receive Pills page", which wrongly implies the bag wasn't received/assigned when in fact its QR token is set but the card is idle.
- **Precise reason:** new `BLOCKED_QR_RESERVATION_LOST` code — when a bag's `bag_qr_code` points at a RAW_BAG card that is **IDLE** (bag claims it, but the card is unreserved), the receive page now says *"This QR is on the bag but its card is idle (reservation lost) — re-reserve it here."* instead of the generic receive-pills copy. The floor-scan path (evaluating a bare idle card) keeps the original `BLOCKED_QR_NOT_ASSIGNED_OR_RESERVED` message. `lib/production/floor-readiness.ts`.
- **Guarded admin repair:** new lead-gated **"Re-reserve QR"** button on the receive detail page (shown only for `RESERVATION_LOST` rows) → `repairQrReservationAction` → `repairQrReservation`, which flips the bag's own IDLE card back to ASSIGNED via a **conditional update** (`WHERE status='IDLE' AND assigned_workflow_bag_id IS NULL` — idempotent + race-safe) and writes a `qr_card.reservation_repaired` audit. It **fails closed** (`canRepairQrReservation`): never touches a card that is active in a production run, retired, the wrong type, claimed by another bag, or on a voided/held bag; it does not touch workflow allocations. `lib/db/queries/bag-edits.ts`, `app/(admin)/inbound/[id]/*`.

### Notes
- Floor-ready source of truth is unchanged and consistent with the floor scan (`bag_qr_code` → card `status ASSIGNED`). No QR data model change; no schema change; no silent QR reassignment on deploy. The IDLE-QR invariant is preserved (repair sets ASSIGNED with `assignedWorkflowBagId` still null; IDLE cards still never retain an assignment). Bag 5 needs the one-click repair (reported; **not** executed — no production data mutated). Existing receiving / grouped-receives / QR / partial-bag / allocation / auto-issue / auto-release behavior unaffected.

## [1.19.1] — 2026-07-03

### Fixed — RETURNED_TO_STOCK consistency for manual finished-lot issue prefill (v1.19.0 follow-up)
- **The last remaining CLOSED-only terminal lookup** — `loadRepairStartingBalanceHints` in `issue-lot-with-allocation-closeout.ts` (the manual `finished-lots/new` repair-path starting-balance prefill) — now uses the shared `TERMINAL_ALLOCATION_STATUSES` (`CLOSED / RETURNED_TO_STOCK / DEPLETED`) instead of `CLOSED` only. It was previously the only balance/consumed inference not fixed in v1.16.0/v1.19.0.
- **Why it's safe:** this hint infers the NEXT session's *starting* balance from the latest terminal session's `endingBalanceQty` (the remaining/returned amount) via `resolveReopenStartingBalance` — it reads **remaining, never `consumedQty`**. So a `RETURNED_TO_STOCK` session correctly contributes its **returned remainder** as the starting balance, not consumed input. A `DEPLETED` terminal (ending 0) prefills 0 (empty — not over-issuable). Fails closed unchanged (no terminal session → declared / pill count). Read-only prefill only — no mutation, no Zoho, no lot creation.
- **Left intentionally CLOSED/DEPLETED:** the two `OPEN`-session detection queries in the same file (existing-session checks) and the Zoho consumed-session **link** in `finished-lots.ts` (a returned remainder is not a consumed input to the lot) — unchanged.

### Notes
- Read-only production impact: exactly **0** current manual-issue repair-path bags have a `RETURNED_TO_STOCK` latest terminal session, so no current prefill value changes; the fix corrects the semantics for when the case arises (1 bag total has a returned-to-stock latest terminal, but it has an open session so it is not on the repair path). No schema change. v1.18.0 auto-issue and v1.19.0 auto-release unchanged; no duplicate lots/events; no Zoho commit. All partial-bag / allocation / open-session-rebase / QR / IDLE invariants preserved. No lots issued/released by this deploy.

## [1.19.0] — 2026-07-03

### Added — AUTO-QC-RELEASE-1: one-click auto-release of clean Pending QC lots
- **Problem:** v1.18.0 auto-issues finished lots but leaves them `PENDING_QC`; releasing every clean lot still meant clicking green "Approve & release" one at a time. If every lot is expected to release, Pending QC was just another click.
- **New release eligibility** (`lib/production/finished-lot-release-eligibility.ts`, fails closed): a lot is `AUTO_RELEASE_READY` only when it is `PENDING_QC`, from a finalized workflow bag with a mapped product + complete setup + positive output + receipt, with **no** QC signal — not on hold, no pending rework, no post-finalization correction, no recovery flag (e.g. wrong-route), no QC events, no open allocation on the source bag, no lot-number conflict, not excluded from output. Otherwise `NEEDS_QC_REVIEW` / `BLOCKED` / `ALREADY_RELEASED`.
- **New batch action** `autoReleaseAllSafeLotsAction` (lead/admin-gated): scans `PENDING_QC` lots, **re-checks eligibility per lot immediately before releasing** (idempotent + race-safe — a lot that changed since the scan is skipped with its reason), bounded to 100/click, and **reuses the exact `setFinishedLotStatus` release path** as manual "Approve & release" (identical audit `finished_lot.status` + `FINISHED_GOODS_RELEASED` event + side effects). It writes a batch audit (`finished_lot.auto_release_batch`, source `AUTO_QC_RELEASE`, `zoho_output_committed: false`) and **does not commit to Zoho** — release only flips the internal Luma QC status; the Zoho output cron picks up RELEASED lots separately, exactly as for manual releases. `app/(admin)/finished-lots/actions.ts`.
- **Trigger design:** admin-controlled **batch button** on the Finished Lots page (no always-on automation, no release-on-issue hook). Kept as a **separate** button from v1.18.0's "Auto-issue all safe lots" (not a combined action) so each phase's outcome is clear.
- **UI:** Finished Lots page gains a QC-release panel — summary cards (**Auto-release ready / Needs QC review / Blocked**), an **"Auto-release all safe lots (N)"** button, per-row status ("Ready to auto-release" / "Needs QC review: reason" / "Blocked"), and copy: *"Pending QC means the lot exists but has not been approved for released inventory. Clean lots can be auto-released; lots with missing or risky data stay pending for review. Zoho output is a separate later step — auto-release does not send anything to Zoho."* Manual "Approve & release" on the lot detail page is unchanged.

### Fixed — v1.18.1: RETURNED_TO_STOCK terminal-session accuracy (v1.18.0 follow-up)
- The Production Output backlog eligibility loader and the auto-issue eligibility (`evaluateRepairAutoIssueEligibility`) inferred the last terminal allocation session from `CLOSED`/`DEPLETED` only, ignoring `RETURNED_TO_STOCK`. A returned partial bag's ending balance was therefore missed (fell back to declared/pill count). Now all "latest terminal session by closedAt" **balance/consumed inferences** use the shared `TERMINAL_ALLOCATION_STATUSES` = `[CLOSED, RETURNED_TO_STOCK, DEPLETED]` (same set introduced in v1.16.0). This only improves eligibility accuracy — it still fails closed and never makes an unsafe row look safe. The Zoho consumed-session **link** stays `CLOSED`/`DEPLETED` only (a returned-to-stock remainder is not a consumed input to the lot). `lib/production/bag-allocation.ts`, `lib/db/queries/production-output-backlog.ts`, `lib/db/queries/finished-lots.ts`.

### Notes
- Auto-released lots are identical to manually-released lots downstream (Finished Lots, Production Output, PO reconciliation, Zoho output cron, traceability/recall, genealogy) — only the audit source differs. No schema change. No duplicate lots, no duplicate release events (transition-guarded + per-lot re-check). No Zoho commit. v1.18.0 auto-issue unchanged. All v1.7–v1.18 partial-bag / allocation / system-derived / open-session-rebase / QR / IDLE invariants preserved. No lots were released by this deploy — release requires an explicit admin click.

## [1.18.0] — 2026-07-03

### Added — AUTO-ISSUE-BATCH-1: one-click auto-issue of safe finished lots
- **Problem:** a finalized workflow bag shows "finalized" on the floor but "Awaiting lot" on Production Output until an admin manually reviews and issues a finished lot one-by-one. For clean rows this is busywork.
- **What already existed (reused, not rebuilt):** the pure eligibility engine `evaluateAutoLotBacklogRow` (fails closed — `READY_TO_AUTO_ISSUE` only when finalized + product known + counts valid + source bag/receipt present + no existing lot + no lot-number conflict + product setup complete + non-negative ending balance + not excluded + Zoho not committed), the per-row `repairAutoIssueFinishedLotForWorkflowBag` service (re-checks eligibility inside its own transaction, idempotent, writes audit), and the per-row "Auto-issue now" button.
- **New batch action** `autoIssueAllSafeLotsAction` (lead/admin-gated): scans the backlog, issues finished lots for **only** the `AUTO_ISSUE_READY` rows via the existing per-row service (so each is re-checked in-transaction → idempotent + race-safe; a row that changed since the scan is **skipped** with its reason, never force-created), bounded to 100 per click, and reports issued / skipped / per-row reasons. It writes a batch audit (`finished_lot.auto_issue_batch`, source `AUTO_FINISHED_LOT_ISSUE`, `zoho_output_committed: false`) and **does not** commit to Zoho — that stays a separate admin-controlled step (the existing cron). `app/(admin)/finished-lots/actions.ts`.
- **Trigger design:** the safe, admin-controlled **batch button** (not always-on background automation, and no finalization hook) — the user stays in control while the one-by-one clicking is removed.
- **Production Output UI:** summary cards (**Auto-issue ready / Needs review / Blocked**), an **"Auto-issue all safe lots (N)"** button, top-blocker reasons, and clarifying copy: *"Finalized means floor work is complete. Finished-lot issuance turns that finalized output into an official inventory lot. Clean rows can be auto-issued; rows with missing or risky data stay here for review. Zoho output is a separate, later admin step — auto-issue never commits to Zoho."* The section is retitled **"Finalized — needs finished lot"**. The per-row **Review manually** / **Auto-issue now** actions remain. `app/(admin)/packaging-output/*`.
- **Dry-run:** `summarizeProductionOutputBacklog(cap)` categorizes the whole backlog (read-only) for the summary cards; the rendered counts are the live dry-run.

### Notes
- Auto-issued lots are identical to manually-issued lots downstream (Finished Lots, Production Output, PO reconciliation, Zoho output, traceability/recall, genealogy) — only the audit source differs. No schema change. No duplicate finished lots (idempotent, `FINISHED_LOT_EXISTS` blocks re-issue). No Zoho commit. All v1.7–v1.17 partial-bag / allocation / system-derived / QR / IDLE invariants preserved (this only reads the backlog and creates finished lots for clean rows). No production lots were auto-issued by this deploy — issuance requires an explicit admin click.

## [1.17.1] — 2026-07-03

### Fixed — REBASE-OPEN-SESSION: rebase panel never appeared (sealed-output=0 false positive)
- **Root cause:** `computeOpenSessionRebaseEligibility`'s "no production output" guard checked `output.sealedOutput != null`. But `deriveStageOutputForBag` computes the sealed column as `COALESCE(SEALING…,0) + COALESCE(BOTTLE_CAP_SEAL…,0)`, so it returns **0 (not null)** for a run with **no** sealing events. `0 != null` is `true`, so a fresh, un-consumed run (e.g. bag-card-104's run `4cb0ed2f` — only fill/handpack/release) was wrongly classified `HAS_PRODUCTION_OUTPUT` and the **"Correct open session starting balance"** panel was hidden. Confirmed against production: `deriveStageOutputForBag(4cb0ed2f)` → `{grossBlisters: null, sealed: 0, packaged: null, finished: null}`.
- **Fix:** a shared `hasRealProductionOutput(output)` helper treats only **positive** stage output as real consumption (`(x ?? 0) > 0`), matching `pickDeepestOutput`. Handpack/release/pickup are not output; prior-run sealing evidence lives on a different workflow bag. bag-card-104's OPEN session is now **eligible** and the rebase panel shows **Current start: 7,197 → Corrected start: 3,598**. `lib/production/open-session-rebase.ts`.
- **No more vague dead-end copy.** The Resolve page now shows **either** the rebase action **or** an explicit "Starting-balance correction unavailable: <exact reason>" — the "(above, if offered)" wording that offered nothing is gone. The rebase panel copy follows the spec (explains it opened from the declared count, shows the `Current start → Corrected start` formula, states the session stays OPEN + QR stays assigned + no output/finished lot created). `app/(admin)/partial-bags/[inventoryBagId]/resolve/page.tsx`.
- **Manual closeout clarified.** Added a warning above the correction menu: **"Correct remaining" CLOSES this open session** — don't use it if you need to keep the run open for later production (use the starting-balance correction above); "Mark depleted" releases the QR (empty bags only); "Void record" discards the bag; each opens an inline form when clicked.

### Notes
- No schema change; admin-gated; no silent auto-resolution. bag-card-104 was **not** modified — remediation remains the admin's audited 2-click action (now correctly offered). All v1.7–v1.17 bottle partial-bag / system-derived / floor blocker / workbench / reuse-starting-balance / QR / IDLE invariants preserved.

## [1.17.0] — 2026-07-02

### Added — REBASE-OPEN-SESSION-1: correct an open session's wrong starting balance without closing it
- **Problem:** for a reused partial bag whose OPEN session opened from the wrong count (pre-v1.16.0 bug — e.g. bag-card-104's second run opened at declared 7,197 instead of the prior returned 3,598), the Resolve page's only manual option — "Correct remaining" — **closes** the session. That ends the run, but the second run has no production numbers yet and must stay open. So there was no usable way to fix the balance while keeping the run open.
- **Fix:** a new admin-gated, audited action **"Correct open session starting balance"** rebases the OPEN session's `starting_balance_qty` to the latest prior TERMINAL session's ending balance (source `PRIOR_RETURNED_BALANCE`) **in place** — the session stays OPEN, the QR stays ASSIGNED, no production counts change, and the run can still receive production output later. It only appears when: exactly one OPEN session, a prior terminal session with ending balance > 0, the current starting balance differs from it, and **no production output has been recorded on the run** (guarded via `deriveStageOutputForBag`). `lib/production/open-session-rebase.ts`, action in `app/(admin)/partial-bags/actions.ts`, UI on the Resolve page + `rebase-open-session-button.tsx`.
- **Model decision:** rebase-in-place (not close-and-reopen). An OPEN session is the bag actively allocated to a run; correcting its starting balance before any consumption is equivalent to it having opened correctly, and it preserves the ability to add production numbers to the existing run. Closing would have ended the run and required a re-scan/restart.
- **Copy fix:** the Resolve page's "Calculated remaining unavailable" message no longer shows the misleading generic "no production output counts recorded" alongside another run's sealing evidence — it now says the open session has no output yet and that any sealed-card evidence shown belongs to an earlier run (traceability only), and points to the rebase / manual options.

### Audit/event
- Rebase writes a `RAW_BAG_ADJUSTED` allocation event (`admin_correction: "rebase_open_session_starting_balance"`, `old_starting_balance`, `new_starting_balance`, `prior_session_id`, `prior_ending_balance`, `prior_ending_balance_source`, `prior_status`, `session_left_open: true`, note) and a `raw_bag_allocation.starting_balance_rebased` audit with before/after. It re-checks the session is still OPEN inside the transaction. No QR release, no deplete/close/finalize, no production counts.

### Notes
- No schema change. Admin-gated (`requireAdmin`); no silent auto-resolution — every rebase is an explicit action. All v1.7–v1.16 bottle partial-bag / system-derived / floor blocker / workbench closeout / reuse-starting-balance / QR / IDLE invariants preserved. bag-card-104 remediation is performed post-deploy via this audited action (reported separately), not raw SQL.

## [1.16.0] — 2026-07-02

### Fixed — REUSE-STARTING-BALANCE-1: reused partial bag opened at full declared count
- **Root cause:** when a partial raw bag is reused for another run, the new allocation session's starting balance was derived by looking up the bag's latest **CLOSED** session only. A bag whose remainder was put back via **`RETURNED_TO_STOCK`** (or a **`DEPLETED`** close) had no CLOSED session, so the lookup found nothing and the new session restarted from the original **declared count** instead of the prior returned balance. For bag-card-104 (declared 7,197; first run returned 3,598 via a RETURNED_TO_STOCK session) the second run's OPEN session opened at **7,197** instead of **3,598**.
- **Fix:** a shared **terminal-session lookup** (`loadLatestTerminalAllocationSession`) + pure resolver (`resolveNewSessionStartingBalance`) now drive every path that opens a new raw-bag allocation session. Priority: explicit manual override → **latest prior TERMINAL session** (CLOSED / RETURNED_TO_STOCK / DEPLETED, newest by `closedAt`) ending balance → declared/on-hand count for a brand-new bag. A DEPLETED prior yields a 0 starting balance (fails closed on any consumption via the over-allocation guard rather than silently reopening at full). Wired into `openAllocationSessionInTx` (`raw-bag-allocation-lifecycle.ts`, the scan/start + repair path — the source of the bag-card-104 bug), the floor manual `openAllocationAction` (`bag-allocation-actions.ts`), and the auto-open path (`bag-allocation-auto-open.ts`, which already handled RETURNED_TO_STOCK — now also DEPLETED + provenance). **Brand-new full bags are unchanged** (declared/on-hand count, `VENDOR_DECLARED`).
- **Provenance/audit:** the `RAW_BAG_OPENED` event payload now records `starting_balance_source` (`PRIOR_RETURNED_BALANCE` / `PRIOR_DEPLETED_BALANCE` / `LEDGER_DERIVED` / `VENDOR_DECLARED` / `MANUAL_ENTRY`), `original_declared_count`, and — when reused — `prior_session_id`, `prior_ending_balance`, `prior_ending_balance_source`, `prior_status`. The session's `startingBalanceSource` reflects the same. No schema change.
- **Read-only detector:** `npm run detect:reused-session-balance` (`scripts/detect-reused-session-starting-balance.ts`) lists sessions whose starting balance differs from the latest prior terminal ending balance (OPEN flagged HIGH), with a **DO-NOT-run-without-approval** remediation note. It excludes self-matches (a session's `closed_at` can slightly precede its `created_at`).

### Notes
- No existing production data was remediated. Production read-only scan found exactly **1** genuinely suspicious session — `64eedae5` (bag-card-104's OPEN second-run session, opened at 7,197 vs prior returned 3,598) — left untouched pending explicit approval (recommended remediation in the report / detector output). No silent auto-resolution; every ledger change still requires an explicit, authorized action. All v1.7–v1.15 bottle partial-bag / system-derived / floor blocker / workbench closeout / QR / IDLE invariants preserved (this changes only the starting-balance derivation for *new* sessions; close/QR-release logic is untouched).

## [1.15.1] — 2026-07-02

### Fixed — RESOLVE-CLOSEOUT-ACTIONS-1: "Record closeout" detail page dead-end
- **Root cause:** the Resolve partial bag inventory page (`/partial-bags/[id]/resolve`, opened by the workbench "Record closeout" button) gated its only form behind `canAdminResolvePartialBagInventory`, which returns `ok:false` when an OPEN allocation session exists (correctly — that form creates a *new* session and must not run against an open one). The `ok:false` branch rendered only reason text + "Back to partial bags" — no actions. So a bag with an open session (the common split-bag case) was a dead-end even though the workbench row said "close it here".
- **Fix:** for the open-session case the detail page now exposes the **same** closeout actions as the workbench row, reusing the exact components/actions (no duplicate ledger logic): the v1.12 **Use calculated remaining** button (shown only when system-derived resolution is eligible, with the `start − consumed = remaining` formula) and the v1.13.1 **correction menu** (Correct remaining — manual physical count / weigh-back / supervisor estimate — Mark depleted, Put on hold, Void). When calculated remaining is unavailable, the precise reason is shown and the manual controls remain. The missing-linkage new-session form is unchanged for the no-open-session path. Computation is defensive (a failure degrades to "unavailable", never crashes the page — cf. v1.14.1). `app/(admin)/partial-bags/[inventoryBagId]/resolve/page.tsx`.
- **Copy fixed for consistency:** the shared eligibility notes no longer say "close it at the floor" / "close it from the workbench" (stale since v1.13.1) — they now say the open session can be closed via calculated remaining / manual count / weigh-back / supervisor estimate / mark depleted. `lib/production/partial-bags.ts`. The detail page's "Blocked reason" is relabelled "Next step", and the sealing-evidence note clarifies the sealed-card count may belong to an earlier run and is not the open session's tablet consumption.

### Investigation note (bag-card-104 / receipt 352171)
- The physical bag was split across two runs: run `3d026c01` (Hyroxi MIT B - Sun Drip, CARD) sealed 1,656 cards and its session (`721cfe58`) is **already closed** (RETURNED_TO_STOCK, ending 3,598, supervisor estimate); the **OPEN** session (`64eedae5`) belongs to a **second run (`4cb0ed2f`) that has no product mapped and no output events**. So the "1,656 cards sealed" evidence belongs to the *other, closed* run — the system-derived calculator is **correct** to report no usable output for the open session (`MISSING_OUTPUT_COUNTS`); the sealed cards are not this session's consumption, and forcing a card→tablet conversion would contradict the supervisor estimate. No calculator change was made; the misleading juxtaposition is addressed by the clarified evidence copy, and the user can now close the open session manually (the supervisor estimate is already known) from the detail page.

### Notes
- Reuses existing authorization: calculated closeout is lead-gated (`useCalculatedRemainingAction`), manual corrections/mark-depleted are admin-gated (`correctPartialBagRemainingAction` / `markPartialBagDepletedAction`) — actions self-guard, so a user lacking permission gets the role error rather than hidden actions. No silent auto-resolution. No schema changes, no production data modified (bag-card-104 not touched). All v1.7–v1.15 bottle partial-bag / system-derived / floor blocker / QR / IDLE invariants preserved.

## [1.15.0] — 2026-07-02

### Changed — RECEIVES-BY-PO-1: group the Receives list by PO number
- **The Receives page (`/inbound`) now groups receives by PO** instead of one flat, noisy table. Because Luma creates a receive per tablet/flavor, a single PO (e.g. PO-00206 with 5 flavor receives) previously scattered across many rows. Now each PO is one card with a header — **PO number · vendor · count badge · "N receives · M bags · Status" · latest received** — and the individual receives listed underneath (receive name, tablet/flavor, received, bags, status), each still linking to `/inbound/{id}` exactly as before.
- **Sorting preserved:** PO groups are ordered by their latest received timestamp (desc) and receives within a group are newest-first — matching the page's prior `receivedAt DESC` feel.
- **Status summary:** a PO group shows `Open` / `Closed` when all its receives agree, or `Mixed` (with an open/closed count tooltip) when they differ. No receive statuses are changed.
- **Null-safe:** missing PO → "Unknown PO" (PO-less receives collapse into one group), missing vendor → "Unknown vendor", missing tablet/flavor → "Unknown tablet / flavor", null received → "—", null/zero bags → 0, unparseable timestamps sort last — one bad row can't crash the page.

### Notes
- UI/readability only. **No change to the receive data model, receive creation, or receiving logic**; no DB migration; no production data touched. The grouping is a pure, unit-tested helper (`lib/production/receives-grouping.ts`) over the existing `listReceives()` rows — the loader/query is unchanged. All QR / partial-bag / allocation invariants are unaffected (this page does not touch them).

## [1.14.1] — 2026-07-02

### Fixed — Partial Bag Workbench server-render crash (digest 3975426362)
- **Root cause:** `deriveStageOutputForBag` (`lib/production/output-reconciliation.ts`) — reached from the workbench's system-derived resolution (`computeSystemDerivedResolutionForBag`) for every needs-closeout / missing-linkage row with an OPEN session — ran a "finished units" subselect against **two columns that do not exist**: `finished_lots.units_finished` (real column is `units_produced`) and a JOIN on `finished_lot_inputs.workflow_bag_id` (that table is batch-scoped and has no such column; the link is `finished_lots.workflow_bag_id`). Postgres rejected the query at parse time (`42703 column … does not exist`), so the whole Server-Components render crashed. Verified read-only against production: the old columns error; the corrected query runs cleanly.
- **Fix:** the finished-units subselect now sums `finished_lots.units_produced` linked directly by `finished_lots.workflow_bag_id` (no `finished_lot_inputs` join). This restores the Partial Bag Workbench **and** the floor calculated-remaining panel / recovery (which share the same loader). `lib/production/output-reconciliation.ts`.
- **Defense in depth:** the workbench now wraps each row's system-derived resolution in try/catch — a single bag's failure (legacy/malformed data, or any future query issue) degrades to "Calculation unavailable for this bag." for that row instead of crashing the whole page; every other row still renders with its calculated-remaining / manual-closeout / mark-depleted options intact. `app/(admin)/partial-bags/page.tsx`.

### Notes
- Pre-existing bug in `output-reconciliation.ts` (the buggy subselect predates v1.12); it surfaced on the workbench because v1.12.0 wired the workbench to call this loader and production now has needs-closeout rows with OPEN sessions. Not caused by the v1.13.1 open-allocation changes or the unrelated v1.14.0 bottle recovery. No schema changes; no production data modified. All v1.7–v1.14 bottle partial-bag / system-derived / QR / IDLE invariants preserved.

## [1.14.0] — 2026-07-02

### Added — BOTTLE-SEALING-RECOVERY-1: clear a stale bottle sealing hold from the packaging station
- **Root cause:** a bottle bag can reach the Packaging station still at stage `BLISTERED` when its cap-seal / sticker completion events were never recorded (the bag physically moved on without a scan). Packaging then blocks — it needs stage `SEALED` **and** both bottle finishing steps — but the floor showed the **card-line** message *"Waiting for sealing to complete… still being sealed"*, with no recovery path. Confirmed in production for Card #34 / PO-00206 Bag 5 (bottle, `BLISTERED`, `BOTTLE_HANDPACK_COMPLETE` present, **no** `BOTTLE_CAP_SEAL_COMPLETE` / `BOTTLE_STICKER_COMPLETE`). Both product-kind confusion (card language on a bottle) **and** stale/incomplete station state.
- **Product-kind-aware gating/messaging.** `BagAdvancedBanner` now takes `productKind`; the card-line "Waiting for sealing" banner is suppressed for `BOTTLE` products (card/blister language never shown for bottles). Card and variety flows are unchanged. `app/(floor)/floor/[token]/page.tsx`.
- **Lead-gated packaging-screen recovery.** A new `BottleSealingRecoveryPanel` renders only for a bottle bag stuck at `BLISTERED` at the packaging (or combined) station. It explains the accurate bottle state (cap-seal / sticker not marked complete) and offers **"Clear stale sealing hold & unlock packaging"** — gated by a supervisor badge (`resolveStationAccountability` `SUPERVISOR_OVERRIDE`, same pattern as the other floor recoveries; a normal operator cannot clear it) and a required note. `bottle-sealing-recovery-panel.tsx` + `recoverBottleSealingHoldAction` in `actions.ts`.
- **What the recovery does (minimal + safe):** records only the *missing* bottle finishing completion event(s) via the normal `projectEvent` path, advancing the bag to `SEALED` so packaging unlocks. It writes a `packaging.recover_bottle_sealing_hold` audit (recovery source, reason, workflow bag id, card QR, previous stage/status, cleared events, lead employee id + name, note). It does **not** release/unassign the QR card, **not** touch the raw-bag allocation balance, **not** close/deplete/finalize the bag, and **not** mutate partial-bag inventory. Guards: bottle-only, not-finalized, stage `BLISTERED`/`SEALED`, and a no-op guard when both finishing steps are already recorded.

### Notes
- No schema changes; no production data modified by this deploy (the code makes the UI/action available — Card #34 was **not** manually cleared during investigation). All v1.7–v1.13 bottle partial-bag / system-derived / QR / IDLE invariants preserved. Tests: pure stage-progression gate + structural coverage of the action (lead gate, product-kind gate, records only missing events, audit, and explicit non-mutation of QR/allocation/finalize) and the banner/panel; DB-backed E2E of the recovery remains a documented gap (no Postgres harness in the default test run).

## [1.13.2] — 2026-07-02

### Fixed — Traceability lookup (/recall) server-render crash (digest 3511293824)
- **Root cause:** on the Traceability lookup page, the export/print bar rendered `firstLotId={passport.finishedLots[0]!.id}` whenever `hasResults` was true — but `hasResults` is true when **either** raw bags **or** finished lots matched. A search that resolved raw bags with **no finished lot** (a supplier-lot / internal-receipt / raw-bag-QR search for an in-progress or partial bag not yet finalised) hit `finishedLots[0]` = `undefined` → `.id` threw → the whole Server Components render crashed. Confirmed against production: **56 raw bags** are matchable by supplier lot with no finished-lot linkage (e.g. lot `173-26-2308`), any of which triggered the crash. Pre-existing bug in the original recall page — not introduced by the recent partial-bag / system-derived work.
- **Fix (narrow + defensive):** new pure `firstFinishedLotId(passport)` helper returns the first finished-lot id or **null** when none matched. The page passes that nullable id to `ExportBar`, which now renders the "Print labels (first matched lot)" link **only when a finished lot exists**. The customer-safe and internal CSV exports (which key off the search params, not a lot id) still render for raw-bag-only matches, so a raw-bag search shows its full passport instead of a blank error page. `lib/production/recall-passport.ts`, `app/(admin)/recall/page.tsx`.

### Notes
- No schema changes; no production data touched. No partial-bag / QR / system-derived behaviour changed. Regression coverage: `firstFinishedLotId` unit tests (raw-bags-only → null; lots present → first id) reproducing the exact crash condition, plus a structural guard asserting the page never dereferences `finishedLots[0]!.id` again.

## [1.13.1] — 2026-07-02

### Fixed — SPLIT-BAG-2: Partial Bag Workbench dead-end on an open allocation session
- **The workbench no longer traps admins with "open allocation exists — close it at the floor" when no clear floor action exists.** Root cause: `correctPartialBagRemaining` refused any manual closeout while an OPEN allocation session existed (and the resolve-page gate said the same), even though the floor had no obvious close path for that bag — a genuine dead-end.
- **Manual "Correct remaining" now closes the OPEN session in place** with the entered remaining + method (PHYSICAL_COUNT / WEIGH_BACK / SUPERVISOR_ESTIMATE), mirroring the in-place close pattern the sibling **Mark depleted** / **Void** corrections already use — instead of dead-ending. CLOSED when remaining > 0 (bag AVAILABLE, reusable), DEPLETED when 0 (QR returned to IDLE with `assignedWorkflowBagId` cleared via `releaseQrIfEmptied` — IDLE invariant preserved). The open session is closed, never a disconnected new session left dangling. `lib/production/partial-bag-admin-corrections.ts`.
- **All three closeout options are now available from the workbench for an open-allocation bag**, with a clear "Open allocation session — close it here to reuse this bag" panel: **A. Use calculated remaining** (v1.12.0 system-derived, `SYSTEM_DERIVED_FROM_PRODUCTION_OUTPUT`, shared service — unchanged), **B. Correct remaining** (manual physical count / weigh-back / supervisor estimate — now closes the open session), **C. Mark depleted** (existing). `app/(admin)/partial-bags/page.tsx`.
- **Actionable messaging:** the resolve-page gate reason now points to the workbench closeout options instead of "close it at the floor before admin resolution". The v1.12.0 workbench already surfaces the precise *why-unavailable* reason for calculated resolution (missing output, unknown starting, no tablets-per-unit, ambiguous, negative, multiple open sessions). `lib/production/partial-bag-review-closeout.ts`.

### Notes
- Ledger-append preserved: the original opening event is never edited; the manual closeout appends the ending balance + a `manual_closeout_open_session` event and a `partial_bag.correct_remaining` audit carrying `closed_open_session` + `open_session_id` + starting/prior/new remaining + method + reason. Actions stay admin/lead-gated (`requireAdmin` for manual corrections, `requireLead` for calculated). No system-derived label on manual closeouts. No schema changes; no production data mutated by this deploy (25 of 31 OPEN sessions look eligible for calculated resolution; none resolved). All v1.7–v1.13 bottle-partial / QR / IDLE invariants preserved.

## [1.13.0] — 2026-07-02

### Added — SPLIT-BAG-1 fast-follow: actionable floor blocker
- **A lead can now use the system-derived calculated remaining directly from the station flow** instead of leaving to Admin → Partial Bag Workbench. When a start/scan (fresh start, partial restart, resume, or sealing product save) is blocked because the same physical raw bag still has an OPEN allocation from a prior product, and Luma can derive the remainder from production output, the station shows a **"Use calculated remaining"** panel right there.
  - **Structured blocker (no string parsing).** The open-session guard (`openAllocationSessionInTx`) now carries a `code: "OPEN_SESSION_ON_BAG"`. The floor start actions detect it, roll back the start (no writes), and return a typed `openAllocationBlock` payload (`OPEN_ALLOCATION_CAN_USE_CALCULATED_REMAINING` with starting/consumed/remaining/output-stage/units/tablets-per-unit/previous-product, or `OPEN_ALLOCATION_NEEDS_MANUAL` with the precise reason). `app/(floor)/floor/[token]/actions.ts`, `lib/production/system-derived-allocation-resolution.ts`.
  - **Floor panel** shows the formula (`start − consumed = remaining`), labels it **"System-derived from production output — not a physical count. Using it writes a ledger closeout"**, shows the previous product + output stage, and offers a **lead-badge-gated** "Use calculated remaining" button plus a **"Use manual count / weigh-back"** escape hatch to the workbench. On success: *"Calculated remaining saved. Re-scan this bag or continue starting the next product."* — it never auto-continues or auto-retries the start. `app/(floor)/floor/[token]/open-allocation-calc-panel.tsx`, wired into `scan-card-form.tsx` + `stage-action-buttons.tsx`.
  - **Lead-gated floor action** (`resolveScannedBagAllocationAction`) reuses the **same shared `resolveAllocationFromProductionOutput` service** as the v1.12.0 workbench button (no duplicated logic, same `SYSTEM_DERIVED_FROM_PRODUCTION_OUTPUT` audit). Floor auth is a station scan-token, so the lead gate is a supervisor badge resolved via `resolveStationAccountability` (`SUPERVISOR_OVERRIDE`) — a normal operator without a lead badge cannot close the ledger.

### Notes
- No silent auto-resolution: the block is only converted to a panel in the catch after the start transaction rolled back; closing the prior session is an explicit lead action. The v1.12.0 workbench "Use calculated remaining" flow is unchanged and still works. No schema changes, no production data mutated by this deploy (25 of 31 OPEN sessions look eligible; none resolved). All v1.7–v1.12 bottle-partial / QR / IDLE invariants preserved (the resolution runs through `closeAllocationSessionInTx`: QR held when remaining > 0, released + `assignedWorkflowBagId` cleared when depleted).

## [1.12.0] — 2026-07-02

### Added — SPLIT-BAG-1: system-derived closeout from production output
- **A split raw bag (Product 1 → Product 2 on the same physical bag) can now be made ready for reuse without a manual count/weigh-back**, when Luma already has enough production output to derive the remainder. Root cause: Product 1's OPEN allocation session blocks a second start on the same bag; previously the only fix was a manual closeout in the admin workbench.
- **Honest, conservative calculator** (`lib/production/system-derived-allocation.ts`): `system_consumed = deepest-recorded output units × tablets_per_unit`; `system_remaining = starting − consumed`. It fails **closed** with an explicit reason and only resolves when the session is OPEN, exactly one open session exists on the bag, the starting count is known, output counts exist, tablets-per-unit is configured (so variety packs are excluded), and remaining ≥ 0. Derived value is labelled `SYSTEM_DERIVED_FROM_PRODUCTION_OUTPUT` — **never** presented as a physical count.
- **Partial Bag Workbench**: needs-closeout / missing-linkage rows now show a **"Calculated remaining available"** state with the formula (`start − consumed = remaining`) and a one-click **"Use calculated remaining"** button; when unavailable, the precise reason is shown (missing output, starting unknown, ambiguous conversion, negative remaining, multiple open sessions). Manual **Record closeout / Resolve inventory / correction menu (physical count, weigh-back, supervisor estimate, notes)** paths are all preserved. `app/(admin)/partial-bags/*`.
- **Floor blocker is now actionable** — the open-session start error names the "Use calculated remaining" resolution instead of a dead-end "close it first". `lib/production/raw-bag-allocation-lifecycle.ts`.
- **Reuse & audit**: the closeout runs through the proven `closeAllocationSessionInTx` (same QR handling — bag CLOSED/AVAILABLE with the QR held when remaining > 0; DEPLETED with the QR returned to IDLE and `assignedWorkflowBagId` cleared when 0), so a resolved bag becomes reusable for a **different** product and all v1.7–v1.11.2 QR-retention + IDLE invariants are preserved. A `raw_bag_allocation.system_derived_resolution` audit records the full provenance (starting, derived consumed/remaining, output stage/units, tablets-per-unit, source workflow bag, any operator estimate / weigh-back grams supplied, and a note that it was calculated — not counted). `closeAllocationSessionInTx.finishedLotId` is now optional (a mid-run resolution has no finished lot).

### Notes
- No schema changes (reuses existing session/event/audit structures + the `OUTPUT_DERIVED` source, now labelled "system-derived from production" everywhere). No production data mutated by this deploy. Weigh-back grams remain optional supporting evidence only (no reliable grams→tablets conversion exists, so it never drives the balance). Follow-up: an in-place floor one-click button (this pass ships the workbench one-click + an actionable floor message; auto-resolving inside the critical scan/start transaction was intentionally avoided so it cannot silently close a run another operator is actively using).

## [1.11.2] — 2026-07-02

### Fixed
- **Supervisor held-partial warning now matches the actual held population.** The wrong-route recovery form only showed the "QR held for a partial bottle bag" warning when the `BAG_FINALIZED` payload carried the explicit `bag_remains_partial` flag (operator picked "partial"). But a bottle QR is also *held* by the safe deferred-release path when the computed remaining is > 0 / unknown — those had no flag, so a supervisor could recover the bag with no on-screen warning even though the server still logged a `held_partial_bottle_override` audit. The warning now keys off whether a QR is still `ASSIGNED` to the finalized BOTTLE bag (`heldQrAssigned`, a correlated `EXISTS` subselect added to the workflow-submissions loader — no fan-out, GROUP-BY safe), matching the server's override predicate. Warning and audit can no longer disagree. `app/(admin)/workflow-submissions/{page.tsx,workflow-table.tsx}`.
- **Removed an emoji from the supervisor warning** (`⚠`) — replaced with a Lucide `AlertTriangle` icon, per the repo's "no emoji in UI" guardrail. `app/(admin)/workflow-submissions/_workflow-recovery-form.tsx`.

### Notes
- Final production-readiness QA pass over the whole bottle partial-bag workflow (close-out → scan/resume → admin visibility → empty release → supervisor override). Flows 1 (close-out) and 4 (empty/release) verified correct with no changes needed; separation of system vs operator estimate, the needs-review thresholds, held-partial visibility, and the "no product_id inherited" resume all confirmed. Only the two supervisor-flow items above were fixed. No schema changes, no production data mutation. Remaining low-severity cosmetic nits (bottle-specific resume header falls back to generic copy when the last session product is null; "unknown" vs "Unknown — closeout required" phrasing differs across surfaces) documented as non-blocking follow-ups.

## [1.11.1] — 2026-06-30

### Fixed
- **VARIETY_PACK QR release now clears `assignedWorkflowBagId`.** On variety-run close (`closeVarietyRunAction`), the VARIETY_PACK card was set to `IDLE` but kept its `assignedWorkflowBagId` — violating the "IDLE ⇒ no assignment" invariant (the last same-class case after the v1.11.0 RAW_BAG fixes). Now cleared with the status, gated on the card still being `ASSIGNED` so in-progress cards are untouched. `app/(floor)/floor/[token]/variety-run-actions.ts`.
- **Bag-edit intake-reserved release** now also clears `assignedWorkflowBagId` explicitly. The `shouldReleaseQrAtBagEdit` guard already only releases intake-reserved cards (assignment already null), so this is a defensive no-op that makes the invariant uniform across every release path. `lib/db/queries/bag-edits.ts`.

### Added
- **Global IDLE-invariant regression test** (`lib/production/qr-idle-invariant.test.ts`) — scans the entire `app/` + `lib/` tree and fails if any `.set({ … status: "IDLE" … })` on a qr card omits `assignedWorkflowBagId: null`. Backstops every future release path. Plus VARIETY_PACK + bag-edit assertions in `qr-release-consistency.test.ts`, and a Scenario C (variety release) added to the staging-only `scripts/verify-bottle-partial-qr-release-e2e.ts`.

### Data
- **One-time production cleanup** of the single pre-existing stale row (`Bag Card 115`: status `IDLE` with a leftover `assignedWorkflowBagId`). Ran the exact scoped statement `UPDATE qr_cards SET assigned_workflow_bag_id = NULL WHERE status = 'IDLE' AND assigned_workflow_bag_id IS NOT NULL` after confirming exactly one matching row, not in use (no live station pin). Before: 1 → after: 0. No other rows affected.

### Notes
- Audited every `qr_cards.status = "IDLE"` write site: all automatic release paths now clear the assignment; card creation (default IDLE on insert) and retire (`RETIRED`, guarded against mid-production) are out of scope by design. No change to the bottle partial-bag contract; no schema changes.

## [1.11.0] — 2026-06-30

### Fixed
- **Manual depletion/closeout now clears `assignedWorkflowBagId` when releasing a RAW_BAG QR.** The manual close/deplete/admin-correction paths set a RAW_BAG card to `IDLE` on confirmed-empty but left `assignedWorkflowBagId` pointing at the old bag — inconsistent with the projector / packaging / supervisor release paths. All four confirmed-empty release sites (`closeAllocationSessionAction`, `markBagDepletedAction`, `releaseQrIfEmptied`, `closeAllocationSessionInTx`) now clear the assignment too. This only affects confirmed-empty/depleted releases; held-partial paths still never touch the card, so a partial QR stays `ASSIGNED` with its assignment intact. `app/(floor)/floor/[token]/bag-allocation-actions.ts`, `lib/production/partial-bag-admin-corrections.ts`, `lib/production/raw-bag-allocation-lifecycle.ts`.

### Added
- **"Held finalized partial bottle bags" section on the Partial Bag Workbench.** A finalized bottle bag whose QR is kept for reuse could be invisible to the allocation-session-keyed sections (no OPEN session / not AVAILABLE). A new section keys off the QR card itself — any `ASSIGNED` card on a finalized `BOTTLE` workflow bag — showing the QR, last-run product, system remaining, operator estimate, and a "Needs review" vs "Held · reusable" status (via `derivePartialBagAttention`, so healthy held partials are not alarmed). System remaining + operator estimate use scalar subselects (no row fan-out). `lib/production/partial-bags.ts` (`loadHeldFinalizedPartialBottleBags`), `app/(admin)/partial-bags/page.tsx`.
- **Staging-only lifecycle verification script** `scripts/verify-bottle-partial-qr-release-e2e.ts` — exercises the real close/deplete floor actions against a Postgres DB to prove kept-partial holds the QR (ASSIGNED, assignment kept) and confirmed-empty releases it (IDLE, assignment cleared). Guarded by `ALLOW_STAGING_QA_DATA=true` + `LUMA_STAGING_ONLY=true`, refuses under `NODE_ENV=production`, and deletes every QA-marked row in a `finally`. Never runs against production.

### Notes
- No change to the QR-retention contract: held partial QRs stay ASSIGNED, packaging/manual finalize still hold partial/unknown QRs, the QR only returns to IDLE when confirmed empty, operator estimate stays separate from system remaining, and supervisor override stays warned + audited. No schema changes, no production data mutation.

## [1.10.0] — 2026-06-30

### Added — bottle partial-bag workflow completion
- **Floor close-out now forces an explicit empty-vs-partial decision.** The bottle packaging close-out replaces the single "keep partial" checkbox with a required two-choice control — **"Bag is empty — release QR"** vs **"Bag still has product — keep QR with this bag"** — each with helper text on exactly what happens to the QR. Save is disabled until the operator chooses, so closing the run no longer implies the bag is empty. The Save button label reflects the choice ("Save & release QR" / "Save & keep bag"). The optional remaining estimate is tied to the partial choice and stays safe-when-blank (the QR is still held). `app/(floor)/floor/[token]/stage-action-buttons.tsx`.
- **Scan/resume of a held partial bottle bag is now obvious.** The partial-reuse confirmation panel is bottle-aware ("Partial bottle bag held for reuse"), states that the QR is still attached to the same physical bag and that a different bottle product can be run, shows **system remaining and operator estimate as separate labelled rows**, and the confirm button reads "Continue with this partial bag". `PartialReuseContext` / `loadPartialReuseContext` now carry `operatorRemainingEstimate` (from the latest `BAG_FINALIZED`) and `previousProductKind`. `app/(floor)/floor/[token]/scan-card-form.tsx`, `lib/production/partial-bags.ts`.
- **Admin "Needs review" signal.** The QR-cards list shows a red "Needs review" chip on a held partial bottle bag only when it is genuinely ambiguous — unknown system remaining, or an operator estimate that differs materially from the system figure (≥100 tablets and ≥25%). Healthy held partials are never flagged. Pure helper `derivePartialBagAttention` (`lib/production/partial-bag-attention.ts`). `app/(admin)/qr-cards/qr-cards-list.tsx`.
- **Clear empty-release audit.** When a bottle bag is confirmed empty at packaging close-out and its QR returns to IDLE, a `floor.bag_qr_released_empty` audit entry (`reason: bag_confirmed_empty`) is now written — previously this release was silent. The held path keeps its `floor.bag_kept_partial` audit, so the trail distinguishes "released because empty" from "kept partial". `app/(floor)/floor/[token]/actions.ts`.

### Notes
- No change to the QR-retention contract: partial bottle QRs stay ASSIGNED; packaging completion and manual finalize still hold partial/unknown QRs; the QR only returns to IDLE when confirmed empty; the operator estimate remains separate from system-calculated remaining; supervisor override stays warned + audited. No schema changes, no data mutation. Known follow-ups: finalized held partials with no allocation session are surfaced on the QR-cards list (the partial-bags workbench still filters `isFinalized = false`); manual close/deplete actions leave `assignedWorkflowBagId` set when releasing a RAW_BAG card.

## [1.9.1] — 2026-06-30

### Fixed
- **Optional "tablets remaining" estimate could block the whole packaging close-out.** The bottle keep-partial estimate field (`partialRemainingEstimate`, v1.8.0) used a strict `z.coerce.number().int().min(0)` schema, so a non-integer value a `type="number"` input still permits (`1.5`, `1e3`, `-2`) failed validation and rejected the **entire** packaging close-out — losing the real packaging counts — even though the estimate is optional and informational. The value is now coerced through a shared helper (`lib/production/partial-remaining-input.ts`): a malformed / out-of-range estimate is silently **dropped** (server `z.preprocess`) and the floor sends only a clean in-range integer (client guard + `step={1}`). The packaging close-out can no longer be blocked by this optional field. `app/(floor)/floor/[token]/{actions.ts,stage-action-buttons.tsx}`.

### Hardened
- **Admin QR-cards list query made crash-proof against malformed payloads.** The `operator_remaining_estimate` scalar subselect (v1.9.0) now regex-guards the `::int` cast (`~ '^[0-9]+$'` → cast, else NULL) so a non-numeric payload value can never error the entire QR-cards list query. `lib/db/queries/qr-cards.ts`.

### Notes
- Small, targeted hardening pass. No schema changes, no data mutation, no behavior change to QR retention / manual-finalize / packaging-finalize / supervisor-override / operator-estimate-separation introduced in v1.7–v1.9.

## [1.9.0] — 2026-06-30

### Added
- **Operator remaining estimate is now surfaced in admin (was write-only).** The optional `operator_remaining_estimate` recorded on `BAG_FINALIZED` (v1.8.0) was previously only visible as raw JSON in the genealogy timeline. It is now read and shown as a clearly-labelled, non-authoritative value:
  - **Partial-bags workbench** — a new "Operator est. ~N" line under the Remaining cell, derived from the bag's `BAG_FINALIZED` payload with zero new joins. When it differs from the system-calculated remaining, both are shown and the operator line is flagged "differs from system" (never silently overwritten). `app/(admin)/partial-bags/page.tsx`, `lib/production/partial-bags.ts`.
  - **QR-cards list** — for a held partial bottle card, the "Partial bottle · QR held for reuse" badge now shows **System remaining** and **Operator est.** as two distinct labelled values. Added via scalar correlated subselects on the loader (latest closed allocation session balance + latest `BAG_FINALIZED` operator estimate) — no row fan-out. `lib/db/queries/qr-cards.ts`, `app/(admin)/qr-cards/qr-cards-list.tsx`.
- **New pure helpers** `bottleFinalizePayloadRemainingEstimate` (reads the estimate only when tagged `OPERATOR_ESTIMATE`) and `formatOperatorRemainingEstimate`; `formatRemainingEstimate` now labels the `OPERATOR_ESTIMATE` source. `lib/production/bag-allocation.ts`, `lib/production/partial-bag-resolution-constants.ts`.

### Changed
- **Partial-aware supervisor override.** The wrong-route / `CARD_FORCE_RELEASED` recovery flow now detects when the bag is a held partial bottle (BOTTLE + finalized + QR still assigned + `bag_remains_partial`). The recovery form shows a strong warning — "This QR is currently kept with a partial bottle bag … recovering will remove the QR from that physical bag; only continue if the bag is being abandoned, relabeled, or corrected." The override remains possible (the confirm checkbox still gates submit) and is **audited**: a `workflow_recovery.held_partial_bottle_override` audit entry is written and the `CARD_FORCE_RELEASED` event payload carries `held_partial_bottle: true` when a release occurs. `app/(admin)/workflow-submissions/{actions.ts,_workflow-recovery-form.tsx,workflow-table.tsx}`.

### Data honesty
- System-calculated remaining (OUTPUT_DERIVED allocation balance) and operator-estimated remaining are always shown as **separate, distinctly-labelled** values across all admin surfaces. The operator estimate never overwrites the system balance that PO reconciliation reads (estimate ≠ confirmed).

### Tests
- `lib/production/partial-bag-resolution-constants.test.ts` (formatter labels), new operator-estimate reader cases in `lib/production/bag-allocation.test.ts`, and `app/(admin)/held-partial-admin-visibility.test.ts` (structural coverage of the QR-cards loader/list, partial-bags surfacing, and the supervisor warning + audit). Existing v1.7/v1.8 bottle-partial coverage unchanged.

### Notes
- Optional staging E2E script not added (kept change focused); suggested shape documented in the deploy report. No Postgres integration harness exists in the default vitest run.

## [1.8.0] — 2026-06-30

### Fixed
- **Closed the last bottle-partial QR-drop path: manual finalize.** The v1.7.0 fix only protected the packaging *auto*-finalize path. The manual `finalizeBagAction` (the legacy "Finalize" button, used when a bag is PACKAGED but auto-finalize didn't fire) emitted a bare `BAG_FINALIZED` with no defer/keep intent, so a bottle bag with a still-OPEN allocation session (the common case) had its QR released to the unused pool even when physically partial. Manual finalize now, for BOTTLE bags only, defers the QR-release decision and re-resolves it from the current allocation session — holding the QR whenever the remaining is unknown or > 0 (or the operator kept it partial), releasing only when the bag is confirmed empty. Card/variety finalize is unchanged. `app/(floor)/floor/[token]/actions.ts`.

### Added
- **Operator clarity at packaging close-out (floor).** The bottle keep-partial control now leads with "Is this bag empty or does it still have product?", uses the explicit copy "This bag still has product — keep QR with this bag", and warns "Only leave this unchecked if the bag is empty — that returns the QR to the unused pool." The manual Finalize confirm dialog is now bottle-aware (no longer claims the card always returns to the IDLE pool). `app/(floor)/floor/[token]/stage-action-buttons.tsx`.
- **Optional remaining-count estimate.** When keeping a bottle bag partial, the operator may enter an estimated tablets-remaining. It is stored as a clearly-labelled estimate on the `BAG_FINALIZED` event payload (`operator_remaining_estimate` / `_source: OPERATOR_ESTIMATE`) and **never** overwrites the `OUTPUT_DERIVED` allocation-session balance that PO reconciliation reads (luma-data-honesty: estimate ≠ confirmed).
- **Admin visibility.** The admin QR-cards list now shows a "Partial · QR held for reuse" badge with the last run's product whenever a card is still `ASSIGNED` while its workflow bag is finalized (the held-partial signal). The partial-bags workbench already surfaces remaining estimate, last product, and resumability.

### Tests
- `lib/production/bottle-partial-lifecycle.test.ts` — new decision-level end-to-end of the full lifecycle (keep partial → QR held → resumable → different bottle product → released only when empty) through the real helpers.
- `app/(floor)/floor/[token]/actions.test.ts`, `stage-action-buttons.test.ts` — regression guards for the manual-finalize defer, bottle-scoping, the labelled estimate (never wired into `endingBalanceQty`), and the floor copy.

### Notes
- **Audit result:** the remaining `qr_cards → IDLE` paths are intentional explicit overrides — supervisor wrong-route reset (`CARD_FORCE_RELEASED`, auditable) and legacy-import orphan release (ops migration only); both are out of the partial-keep scope and were left as-is. No DB-integration (Postgres) test harness exists in the default vitest run; a true DB-backed bottle-partial E2E is a documented follow-up via the `scripts/verify-*.ts` staging pattern. A held partial bottle bag with no allocation session is held (safe) but needs an admin closeout before floor reuse.

## [1.7.0] — 2026-06-30

### Added
- **P2-PARTIAL-KEEP — keep a bottle bag partial at the end of a run.** Bottle runs routinely end on a partial bag. The Packaging close-out now shows a clear "Bag still has product — keep as partial" control for BOTTLE products; when checked, the QR traveler card stays assigned to that physical bag (it is **not** returned to the unused QR pool), and the same bag can be scanned into a later run — even for a different bottle product (Variety vs Single Flavor 12ct), via the existing finalized-bag resume path (new run = new workflow bag, fresh product choice). `app/(floor)/floor/[token]/stage-action-buttons.tsx`.

### Fixed
- **Partial bottle bags were dropped to the unused QR pool on run completion.** Root cause: at `BAG_FINALIZED` the QR was released based on the allocation session, but the production-output allocation close (which computes the true remaining tablet balance) runs *after* finalize — so a partial bag's QR was returned to the pool before the system knew it was partial. The packaging finalize path for BOTTLE products now **defers** the QR-release decision until after the output close, then releases the QR only when the bag is confirmed empty (`ending ≤ 0`); a partial bag (`ending > 0`), an unknown remaining, or an explicit keep-partial **holds** the QR on the bag. Card/variety packaging behavior is unchanged.
  - `lib/production/bag-allocation.ts`: new pure helpers `bagFinalizePayloadKeepsPartial`, `bagFinalizeDefersQrRelease`, `shouldReleaseQrAtFinalizationWithIntent`, `shouldReleaseQrAfterPackagingClose` (28 new unit tests).
  - `lib/projector/index.ts`: `BAG_FINALIZED` QR release now honors explicit keep-partial / packaging defer-release intent on the event payload before the session rule (defensive guard — an explicitly-kept-partial bag is never dropped).
  - `app/(floor)/floor/[token]/actions.ts`: `packagingCompleteAction` accepts `keepBagPartial`; the bottle finalize defers and then re-resolves the QR release after the output close, with a `floor.bag_kept_partial` audit entry. Product switching remains safe (each reuse creates a new workflow bag and never inherits the prior product).

### Notes
- Scoped to the bottle production line; the card line's immediate QR-release-at-packaging behavior is untouched. Follow-up (documented): extend the explicit keep-partial control and an operator-entered remaining count to the card line, and surface a "partial — still active" chip in the admin QR-cards list.

## [1.6.0] — 2026-06-29

### Changed
- **BOTTLE-ORDER-FLEX-1 — flexible bottle finishing order.** The bottle route is now `fill → (cap-seal | sticker, either order) → packaging`. Fill is always first and the Packaging station is always the terminal finalize step; cap-seal and sticker run in whichever order production demands. Operators were blocked at Bottle Stickering with *"This bag is not ready for this station yet (currently BLISTERED)"* because the old route hard-required cap-seal (SEALED) before stickering. Now either finishing station accepts a just-filled bag (BLISTERED) or one the other finishing station already handled (SEALED); both land the bag at SEALED.
  - `lib/production/stage-progression.ts`: `BOTTLE_CAP_SEAL_COMPLETE` / `BOTTLE_STICKER_COMPLETE` stage prereqs and station pickups now accept `BLISTERED` **or** `SEALED`; `BOTTLE_STICKER` releases forward at `SEALED` (no longer finalizes); `STATIONS_THAT_FINALIZE` no longer includes `BOTTLE_STICKER`. New helpers `isBottleFinishingEvent` / `bottleFinishingAlreadyFired` (each finishing step runs exactly once) / `bothBottleFinishingDone` / `missingBottleFinishingSteps`.
  - `lib/projector/index.ts`, `lib/projector/live-read-models.ts`, `lib/legacy/read-model-synthesizer.ts`: `BOTTLE_STICKER_COMPLETE` now folds to stage `SEALED` (was `PACKAGED`); `PACKAGED` comes only from the Packaging station. `BOTTLE_STICKER_COMPLETE` no longer increments a throughput counter (avoids double-counting packaged bags).
  - `app/(floor)/floor/[token]/actions.ts`: a duplicate cap-seal / sticker on the same bag is rejected; the Packaging station refuses to finalize a `kind=BOTTLE` bag until **both** finishing steps have run, with a clear operator message naming what's left. Bottle products already carry packaging structure (`units_per_display`/`displays_per_case`), so units-yielded, tablet consumption, and finished-lot/PO reconciliation compute correctly through the existing Packaging finalize.
  - `app/(floor)/floor/[token]/page.tsx`, `stage-action-buttons.tsx`, `lib/floor-command/production-lines.ts`: the floor UI no longer shows an out-of-sequence warning at a finishing station for a BLISTERED/SEALED bottle; release labels and the line-layout doc reflect the flexible middle.

## [1.5.27] — 2026-06-25

### Tests
- **Z-5 Zoho boundary:** dual-run re-run after service S-2 (`4b5615cb`). Luma's isolated build client now supplies `preview_idempotency_key: luma-bag-finish-receive:<inventory_bag_id>`; the service echoes it verbatim, so **M1 (preview key mismatch) is RESOLVED**. `lib/zoho/bag-receive-build-dual-run.contract.test.ts` updated to assert the match, with a regression guard for the no-key fallback. M2 (commit key), M3 (receive key), and M4 (notes format) remain documented as Luma-owned / approval-gated — not changed.

### Added
- `buildBagReceiveBuildRequestBody` in `lib/zoho/bag-receive-build-service-client.ts` — attaches Luma's per-bag preview key to the build request without collapsing namespaces. Still isolated from runtime preview/commit/freeze.

### Docs
- `docs/ZOHO_BAG_RECEIVE_CONTRACT_PREP_2026-06-25.md` §11 — S-2 echo behavior, M1 resolution, remaining mismatch table, recommended next phase (hold runtime; optional contract-only notes alignment).

### Notes
- Contract/tests/docs only. No runtime migration, no live Zoho writes, no commit/receive idempotency changes, no notes-format change, no schema/env changes.

## [1.5.26] — 2026-06-25

### Tests
- **Z-4 Zoho boundary:** `lib/zoho/bag-receive-build-dual-run.contract.test.ts` dual-runs Luma's local bag-receive builder against the service `POST /zoho/luma/bag-receive/build` read-only endpoint. Deterministic comparison vs the documented S-1 contract (core domain/Zoho values MATCH; preview/commit/receive idempotency keys + notes MISMATCH and are recorded, not changed). Includes an env-gated live dual-run that is skipped without `ZOHO_SERVICE_BEARER_SECRET`.

### Added
- `lib/zoho/bag-receive-build-service-client.ts` — isolated, read-only build client + `bagFinishReceiveBuildInputToDomainRequest` mapper + `diffBagReceiveBuild`. Not wired into preview/commit/freeze runtime paths.

### Docs
- `docs/ZOHO_BAG_RECEIVE_CONTRACT_PREP_2026-06-25.md` §10 — service availability, dual-run results, mismatch table, idempotency/notes comparison, recommended Z-5 (align preview-key contract only).

### Notes
- Equivalence proof only. No runtime preview/commit/freeze migration, no live Zoho writes, no schema/env changes, no idempotency-namespace collapse, no notes-format change. Service confirmed deployed (v1.28.0); live capture not possible from the dev workstation (no bearer secret) — proven via documented contract + env-gated live test.

## [1.5.25] — 2026-06-25

### Tests
- **Z-3 Zoho boundary:** `lib/zoho/bag-receive-service-boundary.contract.test.ts` pins bag receive payload paths, mapping blockers, frozen replay contract, dual idempotency namespaces, and preparatory `ProposedBagReceiveDomainRequest` derivation.

### Docs
- `docs/ZOHO_BAG_RECEIVE_CONTRACT_PREP_2026-06-25.md` — bag receive ownership table, field classification, migration blockers, recommended Z-4 scope.
- `docs/ZOHO_BOUNDARY_AUDIT_2026-06-25.md` — Z-3 closeout cross-link.

### Notes
- Contract/tests/docs only. No runtime, payload shape, commit, frozen-payload, or service migration changes.

## [1.5.24] — 2026-06-25

### Refactor
- **Z-2 Zoho boundary:** `/settings/zoho` Test connection now probes the integration gateway (`checkZohoGatewayHealth` + `fetchZohoBrandStatus` + `deriveZohoReadiness`) instead of direct Zoho OAuth/API. Removed unused `lib/zoho/client.ts` (OAuth refresh, `testConnection`, unwired `createPurchaseReceive` stub).

### Tests
- `lib/zoho/zoho-direct-api-boundary-guard.test.ts` — guard against `zohoapis.com`, `Zoho-oauthtoken`, and `lib/zoho/client` reintroduction; assert settings action uses gateway path.

### Notes
- Settings UX preserved (`organizationName` / `organizationId` success shape). `zoho_credentials` table and credential form unchanged; warehouse default still read from that row. No bag receive, production output, PO sync, commit, or frozen-payload changes.

## [1.5.23] — 2026-06-25

### Tests
- **D-3 BOM dispatcher audit:** `lib/zoho/bom-dispatcher-behavior.contract.test.ts` pins call sites, structural differences, and scenario matrix for `sourceAllocationBuildOptsForProduct` vs `buildAdminPreviewSourceAllocationOpts`. Proves paths are intentionally non-equivalent (nullable `productId` generic fallback, admin blocker-only tail, admin `source`/`warnings` shape).

### Notes
- Audit/contract only. No production logic, Zoho payload, schema, or UI changes.

## [1.5.22] — 2026-06-25

### Refactor
- **D-2 duplication reduction:** Shared static source-scan helpers in `lib/test/source-scan.ts` (`readRepoSource`, `grepRepo`, `grepRepoSymbol`) for guard/contract tests.

### Tests
- Migrated `raw-bag-intake-receive-deprecated.test.ts`, `zoho-live-commit-eligibility-guard.test.ts`, and `commit-source-dedup.test.ts` to the shared helper.
- `lib/test/source-scan.test.ts` — focused helper smoke tests.

### Notes
- Test-only. No runtime, Zoho write, schema, or route changes.

## [1.5.21] — 2026-06-25

### Refactor
- **D-1 duplication reduction:** `CommitSource` (`"manual" | "auto"`) now has a single canonical definition in `lib/zoho/zoho-commit-notes.ts`. `shared-raw-bag-receive-commit.ts` re-exports it; `shared-production-output-commit.ts` drops the parallel `ProductionOutputCommitSource` alias.

### Tests
- `lib/zoho/commit-source-dedup.test.ts` — guard against reintroducing duplicate commit-source type definitions.

### Notes
- Type-only. No Zoho write behavior, payload, or route changes.

## [1.5.20] — 2026-06-25

### Refactor
- **D-1 duplication reduction:** `finished-lots/[id]/zoho-queue-card.tsx` now imports shared `ZohoOpStatusChip` from `zoho-operations/_status-chip.tsx` instead of a byte-identical local `OpStatusChip` copy (~18 lines removed).

### Tests
- `app/(admin)/finished-lots/[id]/zoho-queue-card.test.ts` — guard that the queue card reuses the shared chip and does not reintroduce a local duplicate.

### Notes
- Presentational only. No Zoho write behavior, payload, or route changes.

## [1.5.19] — 2026-06-25

### Cleanup
- **Archived six tracked staging pilot one-shots** to `scripts/archive/pilot/` (git history preserved via rename):
  - `_pilot-sweet-trip-po-commit-once.ts`
  - `_pilot-sweet-trip-po-commit-retry-once.ts`
  - `_pilot-sweet-trip-floor-walkthrough.ts`
  - `_pilot-sweet-trip-prep-master-data.ts`
  - `_pilot-fix-relax-po-commit-once.ts`
  - `_pilot-fix-relax-po-preview.ts`
- Added `scripts/archive/pilot/README.md` — historical one-shots, not deploy/runtime; operator approval required.

### Docs
- `docs/runbooks/2026-06-19-luma-live-write-proof.md` — notes missing preview script; points to archive path.
- `VERSIONING.md` / `tsconfig.scripts.json` — archive location documented.

### Notes
- No app/runtime imports. Root `scripts/_pilot-*.ts` gitignore unchanged (blocks new debris only).
- Script behavior unchanged; usage comments updated to archive paths.

## [1.5.18] — 2026-06-25

### Cleanup
- **Removed vacuous placeholder tests** from `synthesizer-dryrun.test.ts`, `active-rolls.test.ts`, and `material-learning.test.ts`. Replaced synthesizer placeholders with source-file dry-run guard checks.

### Docs
- **Corrected stale floor-board notes** in `docs/CURRENT_PHASE_STATUS.md` and `docs/CLAUDE_BUILD_QUEUE.md`: `app/(admin)/floor-board/_components/` is live (v2 board), not dead.

### Notes
- Added `scripts/_pilot-*.ts` to `.gitignore` for untracked staging debris; six tracked pilot scripts remain in git and runbooks.

## [1.5.17] — 2026-06-25

### Cleanup
- **Removed confirmed-dead UI and server-action debris (~850+ lines).**
  - `components/production/luma-ui.tsx` — never imported; live pages use `components/production/ui.tsx`.
  - `app/(admin)/packaging-output/auto-issue-controls.tsx` + `actions.ts` — superseded by `backlog-row-actions.tsx` + `repairAutoIssueFinishedLotAction`.
  - `app/(floor)/floor/[token]/source-allocation-panel.tsx` — built but never wired to the floor page.
  - `app/(admin)/floor-board/_hooks/use-floor-live-refresh.ts` — superseded by inline SSE in `live-refresh.tsx`.
- **Pruned Zoho note-input dead fields.** Removed ignored `source?` from `RawBagReceiveNotesInput` / `ProductionOutputNotesInput`; commit trigger still appended at commit time via `appendCommitTriggerToNotes`.
- **Simplified raw-bag intake module.** Dropped unused `RawBagReceiveBuildInput` export, `parseZohoPurchaseReceiveId` re-export, and redundant bag query in `verifyRawBagHistoricalZohoReceive`.
- **Deleted 7 untracked local `_pilot-*` script debris files** from the working tree.

### Tests
- `finished-lots-backlog.test.ts` — pins live per-row repair path instead of deleted bulk auto-issue actions.
- `raw-bag-intake-receive.test.ts` — imports `parseZohoPurchaseReceiveId` from canonical module.
- `zoho-live-commit-eligibility-guard.test.ts` — new guard: module stays test-only until queue UI wires it.

### Notes
- No production behavior changes on live Zoho commit paths. Tracked staging pilot scripts under `scripts/_pilot-*` retained.

## [1.5.16] — 2026-06-25

### Cleanup
- **Removed two dead helpers from `lib/zoho/raw-bag-intake-receive.ts`.** After v1.5.15 no-importer guards ran green, deleted:
  - `buildRawBagIntakeReceivePayload` — legacy `line_items[]` payload builder; canonical replacement remains `buildBagFinishReceivePayload` in `lib/zoho/bag-finish-receive.ts`.
  - local `upsertRawBagReceiveRow` — zero callers; canonical writers remain `seedPendingRawBagReceiveRows`, `upsertRawBagReceiveRow` in `bag-finish-receive.ts`, and `setRawBagReconciliationStatus`.

### Tests
- Removed obsolete `buildRawBagIntakeReceivePayload` unit tests from `lib/zoho/raw-bag-intake-receive.test.ts` (kept `parseZohoPurchaseReceiveId` tests).
- Converted `lib/zoho/raw-bag-intake-receive-deprecated.test.ts` to forbidden-reintroduction guards plus canonical-path presence checks.

### Notes
- No production behavior changes. No schema/migration changes. No Zoho live-write changes.

## [1.5.15] — 2026-06-25

### Cleanup
- **Tagged two dead helpers in `lib/zoho/raw-bag-intake-receive.ts` as `@deprecated`.** Caller grep across production code, tests, scripts, and docs confirmed:
  - `buildRawBagIntakeReceivePayload` (exported, line 36) — emits a legacy `line_items[]` payload shape; only the paired test file calls it; no production callers. Canonical replacement: `buildBagFinishReceivePayload` in `lib/zoho/bag-finish-receive.ts` (flat `BagFinishReceiveRequest` shape).
  - `upsertRawBagReceiveRow` (NOT exported, line 123) — zero callers anywhere in the repo; not the same as the live same-named writer in `lib/zoho/bag-finish-receive.ts:224`. Canonical writers to `zoho_raw_bag_receives` today are `seedPendingRawBagReceiveRows` (same file, for new intake seeds), the `bag-finish-receive.ts` version of `upsertRawBagReceiveRow` (for preview/commit flows), and `setRawBagReconciliationStatus` (same file, for reconciliation state).
- Both helpers are retained in place to keep this change behavior-preserving. Slated for removal in a later release once the no-importer guards have run green for one cycle.

### Tests
- `lib/zoho/raw-bag-intake-receive-deprecated.test.ts` — new file (4 tests). Greps the repo to assert neither helper has gained a new caller, and re-reads the file to assert each deprecated symbol still carries an `@deprecated` JSDoc block pointing at the canonical replacement. Excludes node_modules/`.next` and (for the in-file caller check) JSDoc and comment lines so prose mentions don't count as references.

### Notes
- No production code paths changed. No schema/migration changes. No env-gate flips. No Zoho live-write behavior changes.
- Test count: 4609 → 4613 (+4 new guard tests).
- All five gates clean: typecheck, typecheck:scripts, eslint, vitest, next build.

## [1.5.14] — 2026-06-25

### Fixed
- **Daily PO sync timer now fires at 03:59 US Eastern, not UTC.** Production LXC 122 `timedatectl` set to `America/New_York`; timer `OnCalendar` unchanged at `03:59:00` local. Runbook updated with the timezone prerequisite.

## [1.5.13] — 2026-06-25

### Fixed
- **`ZOHO_PO_SYNC_ENABLED` now reaches the app container.** The daily PO sync cron gate was added to `/etc/luma/.env` but missing from `docker-compose.yml`, so the route always returned `status: skipped`. Wired through the app service environment block.

## [1.5.12] — 2026-06-25

### Added
- **Daily Zoho PO sync cron.** New bearer-authed `POST /api/cron/zoho-po-sync` route runs `syncPurchaseOrdersFromZoho()` on a schedule so tablet POs land in the receive dropdown without a manual sync click. Gated by `ZOHO_PO_SYNC_ENABLED=true`; persists one `zoho_sync_runs` row (`PURCHASE_ORDERS`, `source=cron`) and an audit row per pass. Systemd timer `luma-zoho-po-sync.timer` fires daily at **03:59 server local time**. Manual **Sync POs from Zoho** on `/receiving/raw-bags` is unchanged.

### Documentation
- **`deploy/README-zoho-po-sync.md`** — install, env, verification, and rollback runbook for the daily PO sync timer.

## [1.5.11] — 2026-06-25

### Receiving (hardening)
- **Atomic supplier-lot batch quantity increment.** When `createRawBagIntakeAtomic` reuses an existing supplier-lot batch (the v1.5.9 reuse path), `qtyReceived` and `qtyOnHand` are now incremented via SQL-level expressions (`sql\`${batches.qtyReceived} + ${lotDeclared}\``) against the live column instead of a JS read-modify-write (`existingBatch.qtyReceived + lotDeclared`). Under READ COMMITTED, two concurrent intakes against the same supplier lot could previously read the same baseline and overwrite each other's deltas; the atomic form composes correctly.
- **Audit row on batch reuse.** The reuse branch now writes a `batch.qty_increment` audit-log row containing the actor, the existing batch id, the `before` totals (`qtyReceived`, `qtyOnHand`, `tabletTypeId`), and the `after` snapshot (the delta added plus the post-update totals returned by the UPDATE … RETURNING). Brings the reuse path in line with the "every mutation writes audit_log" invariant from `CLAUDE.md`. The new-batch INSERT branch's existing `batch.create` audit is unchanged.

### Fixed
- **Friendlier error when two saves race the same PO.** `mapIntakePersistenceError` now recognizes the `receives_name_unique` constraint (or a `receive_name` detail string) and returns: *"Another receive was created for this PO at the same time. Refresh and try again so Luma can assign the next receive number."* — instead of the generic "duplicate record" message. `{PO}-R{seq}` race conditions surface a clear retry prompt. Existing `batches_kind_number_unique`, `internal_receipt`, `bag_qr`, and generic fallback branches are untouched.

### Tests
- `lib/db/queries/raw-bag-intake-batch-reuse.test.ts` — new file (16 tests) pinning the four phases above. Same source-text-contract style as `lib/db/queries/batches.test.ts:84-88`. Asserts: lookup keys on `(kind, batch_number)`, cross-product mismatch returns the friendly error, the new-batch INSERT branch still writes `batch.create`, `sql` is imported from drizzle-orm, both `qtyReceived` and `qtyOnHand` use column-relative SQL increments (and explicitly forbid the JS read-modify-write form), the reuse update still scopes by `eq(batches.id, existingBatch.id)`, `batch.qty_increment` audit row is present with the expected `targetType` / `targetId` / `deltaQuantity`, and `mapIntakePersistenceError` carries the new `receives_name_unique` branch and friendly copy while preserving the existing fallback and `internal_receipt` / `bag_qr` branches.

### Notes
- No schema changes. No migrations. No dependency changes. No route/nav/UI changes.
- No edits to `lib/zoho/shared-raw-bag-receive-commit.ts`, `lib/zoho/bag-finish-receive.ts`, `lib/zoho/freeze-raw-bag-receive-payload.ts`, or any `drizzle/*` file.
- Test count: 4584 → **4600** (+16 new, none weakened or removed).
- All five gates clean: typecheck, typecheck:scripts, eslint, vitest, next build.

### Intentionally deferred (out of scope for this PR)
- **Unique receipt-number migration (audit LF-1 / Phase E).** Would close the concurrent-duplicate-receipts gap by adding a `UNIQUE` partial index on `inventory_bags.internal_receipt_number`. Requires a Drizzle migration; out of scope per this PR's no-schema rule.
- **Zoho seed failure repair path (audit LF-5 / Phase D).** When `seedPendingRawBagReceiveRows` throws after the transaction commits, bag rows exist without staging rows; today only a `console.error` records this. The bag-finish preview lazily creates the staging row, but bags that never get a preview attempt remain un-seeded. A future PR can add an audit row + a `npm run repair:resend-pending-zoho-seeds` script.
- **Dead-code tagging in `lib/zoho/raw-bag-intake-receive.ts` (audit DH-1 / DH-4 / Phase G).** `upsertRawBagReceiveRow` and `buildRawBagIntakeReceivePayload` are suspected unused in production paths. A future PR can add `@deprecated` tags + a zero-importers guard test. No deletions until callers are fully verified.

## [1.5.10] — 2026-06-25

### Navigation / UX (labeling only — no route changes)
- **`/zoho-operations`** page header retitled to "Zoho operations (legacy atomic-ops history)" with a clearer description that explicitly calls it a HISTORY VIEW and points at `/zoho-production-operations` for current writes.
- **`/zoho-production-operations`** page description updated to call it the "current consolidated production-output queue" and reference `/zoho-operations` as the legacy history view.
- **Sidebar label** for `/zoho-production-operations` changed from "Zoho output" to "Zoho production output" to match the page title and settings-hub label.
- **Settings hub** previously linked only to legacy `/zoho-operations` with a hint that misleadingly described it as the active sync path. Replaced with two entries: `/zoho-production-operations` ("Zoho production output", labeled as the current queue) and `/zoho-operations` ("Zoho operations (legacy)", labeled as history and pointing operators at the current queue in its hint).
- **`/po-reconciliation` ↔ `/po-reconciliation-v2` cross-links** relabeled. v1's "New 8-bucket view →" replaced with "Multi-scope variance lens →"; v2's "← legacy PO reconciliation" replaced with "← Per-PO lens". The two pages are different lenses on the same domain, not legacy-vs-current; the prior wording was misleading.
- **`/inbound/new`** intentionally NOT changed — already correctly labeled "Legacy receive wizard" with a supervisor-fallback amber banner; the existing inbound page test forbids any promotion to a primary CTA.
- **`/roll-management` and `/production-capacity`** intentionally NOT changed — earlier audits flagged them as sidebar orphans, but they are reachable via `components/ui/materials-tabs.tsx` and `components/ui/metrics-tabs.tsx` respectively. They are hidden from the main sidebar by design.

### Tests
- `app/(admin)/settings/settings-page.test.ts` — extended with a new describe block (`settings hub · Zoho routes are labeled by current-vs-legacy`, 3 tests) pinning that the new `/zoho-production-operations` hub entry exists and is labeled as current, that `/zoho-operations` is labeled as legacy, and that the legacy entry's hint points at the current queue.
- `app/(admin)/po-reconciliation/page.cross-link.test.ts` — new file (3 tests) pinning the new cross-link wording in both directions and forbidding the prior misleading strings.

### Notes
- No route deletions. No redirects. No schema/migration changes. No Zoho logic changes. No dependency changes.
- Test count: 4584 (verified end-of-phase). All five gates clean.

## [1.5.9] — 2026-06-25

### Fixed
- **Raw-bag intake save 500 on existing supplier lots.** Batch lookup filtered by `(kind, batch_number, tablet_type_id)` but the database unique index is only `(kind, batch_number)`. A second receive for the same supplier lot could miss the existing batch row and hit a Postgres duplicate-key 500 surfaced as a generic Server Components error. Lookup now keys on `(kind, batch_number)` and returns a clear error when the lot belongs to a different tablet type.
- **Post-save Zoho seed failures no longer mask a successful intake.** If bag rows commit but `seedPendingRawBagReceiveRows` throws, the action still returns success so operators are not prompted to re-save duplicate receipts.

## [1.5.8] — 2026-06-24

### Dependencies
- **Removed four confirmed-unused packages.** Pre-removal grep confirmed zero runtime imports for each.
  - `react-grid-layout` (^2.2.3) — no grid dashboards in the codebase.
  - `@types/react-grid-layout` (^1.3.6) — types for the package above.
  - `recharts` (^3.8.1) — no chart components in the codebase.
  - `pg-boss` (^10.1.5) — described in CLAUDE.md / docs/phases.md as the planned projector worker + Zoho push driver, but was never wired. Tests at `app/(admin)/finished-lots/[id]/zoho-production-output-preview-wiring.test.ts:139,142` and `lib/db/queries/zoho-production-output.test.ts:280` already pin the absence with negative `expect(...).not.toContain("pg-boss")` assertions; these were left intact.

### Tooling
- **`next.config.mjs` cleanup.** Removed dangling `"pg-boss"` references from both `experimental.serverComponentsExternalPackages` and `serverExternalPackages` since the package no longer exists. No behavioral change — Next.js was instructing the bundler to externalize a package that was never imported.

### Documentation
- **`CLAUDE.md`** — "pg-boss for jobs" replaced with an honest description: pg-boss was planned but never implemented; cron-style jobs currently run via systemd timers + bearer-authed `/api/cron/*` routes. "Read models refreshed by pg-boss projector jobs" replaced with the actual mechanism (projector modules in `lib/projector/*` invoked from synchronous write paths and the `rebuild:read-models` script).
- **`docs/phases.md`** — Phase 4 projector step and Phase 5 Zoho push step rewritten to describe what actually exists (synchronous projector + cron-route staging-buffer drain), with a note that pg-boss was the original plan and was removed in v1.5.8.
- **`lib/db/schema.ts:2782`** — Context 6 header comment updated to match the same reality.
- Planning docs that describe HYPOTHETICAL future pg-boss handlers (e.g. `docs/ZOHO_LIVE_SYNC_PLAN.md`, `docs/ZOHO_ITEM_SYNC_PLAN.md`, `docs/CLAUDE_BUILD_QUEUE.md`) were intentionally NOT modified — they document plans, not current architecture, and removing them would lose intent. Historical CHANGELOG entries that mention "no worker/pg-boss" were also intentionally not touched — they are accurate historical statements about what was deferred at the time of those releases.

### Notes
- No app code changes (only the schema.ts comment, the Next config externalization list, and four package.json lines).
- No script changes. No test changes. No behavior changes.
- Test count unchanged at 4577. All five gates clean.

## [1.5.7] — 2026-06-24

### Tooling
- **Added `npm run typecheck:scripts` gate** for the 12 operational scripts exposed via `package.json` (migrate, seed, rebuild-read-models, replay-workflow-events, synthesize-legacy, staging seed/cleanup, validation-snapshot, repair-qr-inventory, fix-station-handpack-kind, verify-deploy, audit-product-zoho-readiness).
- New `tsconfig.scripts.json` extends the base config with an explicit `include` list of those 12 entrypoints and overrides `exclude` to `["node_modules"]` so the base `exclude: ["scripts", ...]` rule does not re-skip the included files. Transitively imported files remain type-checked as part of the program.
- Pilot scripts (`scripts/_*.ts`), historical/repair backfills, Python scripts, and shell scripts are intentionally out of scope and remain excluded.

### Notes
- All 12 operational scripts passed strict TS on first run (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`); no script edits required.
- App typecheck, lint, vitest, and next build all unchanged. Test count unchanged at 4577.

## [1.5.6] — 2026-06-24

### Documentation
- **Corrected two phantom script references in docs.**
  - `docs/COMMERCIAL_TRACEABILITY_PLAN.md:500` referenced `scripts/verify-commercial-trace-7.ts`; the actual on-disk filename is `scripts/verify-commercial-trace.ts` (the script's own header confirms it implements COMMERCIAL-TRACE-7 — only the filename lacks the `-7`).
  - `docs/PRODUCTION_DATA_ENTRY_HARDENING_AUDIT.md:294` referenced `scripts/audit-floor-readiness-counts.ts`; this script was a planned-but-never-built optional helper. Replaced with descriptive prose preserving the original intent.

### Notes
- Documentation-only change. No code edits, no schema changes, no tests added, no behavior changes.
- Test count unchanged at 4577. All four gates remain clean (lint, tsc, vitest, next build).

## [1.5.5] — 2026-06-24

### Documentation
- **Backfilled missing v1.1.x and v1.2.0 release notes** in the historical section of this file (between v1.3.0 and v1.0.2). Entries are paraphrased directly from the commit bodies (`91509a1`, `a697ad0`, `ff6de66`) with no invented details. Resolves pending changelog task: *"backfill CHANGELOG.md entries for v1.1.0, v1.1.1, v1.2.0"*. The v1.3.0 entry already existed and was not touched.

### Notes
- Documentation-only change. No code edits, no schema changes, no tests added, no behavior changes.
- Test count unchanged at 4577. All four gates remain clean.

## [1.5.4] — 2026-06-24

### Changed
- **Retired deprecated `classifyBatchLookupResponse` wrapper in `lib/zoho/component-batch-resolution.ts`.** The wrapper extracted `item_id` / `human_lot_number` from the response body's TOP LEVEL and forwarded them to the canonical `classifyBatchResolveResponse`. For its only (test-only) consumer, both bodies lacked those top-level fields, so the wrapper effectively called `classifyBatchResolveResponse(body, "", "")`. The migration replaces the wrapper-via-test pattern with an explicit `("", "")` call, producing identical output.

### Migrated callers
- `lib/zoho/production-output-v1206.test.ts` — 1 import + 2 call sites (lines 109, 124) now call `classifyBatchResolveResponse` directly with explicit `("", "")` args. Inline comment documents that this matches the wrapper's prior behavior for these specific bodies.

### Behavior preservation proof
- The canonical's UNIQUE branch uses `itemId` / `humanLotNumber` only as **fallback values** when the body lacks `obj.item_id` / `obj.human_lot_number` (lines 173-174, 196-197).
- For the UNIQUE test (`{ resolved: true, resolution: "unique", batch_id: "...", batch_number, available_balance }`): body lacks top-level `item_id`/`human_lot_number`; the wrapper passed `""`; explicit `""` passes identical args. Result shape unchanged.
- For the AMBIGUOUS test (`{ resolution: "ambiguous", candidates: [...] }`): body lacks top-level `item_id`/`human_lot_number`; `parseCandidates` is called with `("", "")` either way. Test only asserts `result.status === "AMBIGUOUS"`; candidate-array shape from `parseCandidates` is unchanged by the wrapper-vs-direct distinction.

### Notes
- No env changes. No DB migrations. No live-write gate flips. No Zoho writes.
- Test count: 4577 → **4577** (no test cases removed; the 2 cases retained their assertions verbatim — only the function call signature was updated).
- Wrapper was the last `@deprecated`-tagged identity/normalizing alias with manageable caller surface. The remaining `@deprecated` tags are all documented intentional fallbacks / compatibility shims (per v1.5.3 CHANGELOG).

## [1.5.3] — 2026-06-24

### Changed
- **Removed 6 dead `@deprecated` aliases with zero production and zero test callers.** All were identity passthroughs or unused dead exports left behind by past renames. Behavior-preserving cleanup.

### Retired symbols
- `CHOCO_DRIFT_BOM_QUANTITY_PER_UNIT` (`lib/zoho/v1206-choco-drift-pilot-contract.ts`) — alias of `CHOCO_DRIFT_RAW_TABLET_BOM_QUANTITY_PER_UNIT`
- `CHOCO_DRIFT_RAW_COMPONENT_ITEM_ID` (same file) — alias of `CHOCO_DRIFT_RAW_TABLET_ITEM_ID`
- `buildChocoDriftNonBatchComponentBatches` (same file) — identity passthrough to `buildChocoDriftComponentBatches`
- `isConsolidatedProductionOutputEnabled` (`lib/zoho/production-output-config.ts`) — identity passthrough to `isProductionOutputPersistEnabled`
- `lookupZohoComponentBatch` (`lib/zoho/component-batch-resolution.ts`) — shape-normalizing passthrough to `resolveZohoComponentBatch`
- `ensureOpenAllocationForProductionStartInTx` (`lib/production/raw-bag-allocation-lifecycle.ts`) — `const` re-export of `ensureOpenRawBagAllocationSessionForWorkflowBag`

### Doc update
- `lib/production/bag-allocation-auto-open.ts` header comment updated to reference the canonical `ensureOpenRawBagAllocationSessionForWorkflowBag` instead of the now-deleted alias.

### Held (still in use)
- `ZOHO_PRODUCTION_OUTPUT_ENABLED_ENV` — though `@deprecated`, the constant is still **read by its own file** at `production-output-config.ts:74` for legacy detection (`legacyEnabledFlagSeen`). KEPT.
- `classifyBatchLookupResponse` — still consumed by `production-output-v1206.test.ts`. The wrapper does data extraction (item_id, human_lot_number from body) so it's not a pure identity passthrough. HELD for a dedicated PR.
- `CommitSource` type + `source` field on `RawBagReceiveNotesInput` (`lib/zoho/zoho-commit-notes.ts`) — comments document these as compatibility shims still in use (audit-log structuring + tested in `zoho-commit-notes.test.ts:92-93`). KEPT.
- v1206 pilot contracts as a whole (`@deprecated DYNAMIC-BOM-DERIVATION-v1.4.4`) — transition fallback for legacy pilot SKUs per v1.4.4 design intent. KEPT.

### Notes
- No env changes. No DB migrations. No live-write gate flips. No Zoho writes.
- Test count: 4577 → **4577** (no test deletions — the retired symbols had zero test callers).

## [1.5.2] — 2026-06-24

### Changed
- **Retired deprecated `buildRawBagReceiveIdempotencyKey` alias in `lib/zoho/source-receipt-evidence.ts`.** The function was a one-line passthrough to the canonical `buildBagFinishReceiveIdempotencyKey` in the same file (output: `luma-bag-finish-receive:${inventoryBagId}`). The migration is behavior-preserving: every production call site previously resolved through the alias to the same canonical body.

### Migrated callers
- `lib/zoho/raw-bag-intake-receive.ts` — 1 import + 4 call sites (lines 42, 127, 253, 414)
- `lib/zoho/source-receipt-contract.ts` — 1 import + 1 call site (line 82)
- `lib/zoho/source-receipt-evidence.test.ts` — 1 import + 1 call site (stable-key contract test, now pinned against the canonical export; same expected string `luma-bag-finish-receive:4a02fc5b-…`)
- `lib/zoho/bag-finish-receive.test.ts` — removed the redundant `describe("idempotency alias", …)` block (it asserted `alias === canonical`; meaningless after retirement). Updated the import to drop the alias.

### Notes
- No env changes. No DB migrations. No live-write gate flips. No Zoho writes.
- Test count: 4578 → **4577** (the 1-case "alias matches canonical" describe block was removed; the substantive "stable bag-level idempotency key" test still pins the exact string `luma-bag-finish-receive:${inventoryBagId}` shape via the canonical function).
- Idempotency semantics preserved: the canonical produces the exact same string the alias had been delegating to.

## [1.5.1] — 2026-06-24

### Changed
- **Retired deprecated `inferRole` alias in `lib/production/active-rolls.ts`.** The function was a one-line passthrough to the canonical `inferRollRole` in `lib/production/roll-role.ts` and had zero production callers — only `lib/production/active-rolls.test.ts` referenced it. The test now imports + calls `inferRollRole` directly, the alias is deleted (~10 LOC), and the canonical helper in `roll-role.ts` is unchanged. Behavior-preserving consolidation: every code path that previously resolved through the alias now resolves to the same `inferRollRole` body it was already calling internally.

### Notes
- No env changes. No DB migrations. No live-write gate flips. No Zoho writes.
- Pure cleanup: `npm run test` count unchanged at 4578/4578 (the 6 test cases still run, now pinned against the canonical export).

## [1.5.0] — 2026-06-24

### Added — partial-bags safe-allocation backfill

- **Bulk backfill of missing OPEN allocation sessions on active workflow runs.** When an active workflow bag has no `raw_bag_allocation_sessions` row, downstream consumption never lands on the ledger; previously a lead had to repair each run from the station screen or wait for forced closeout. The new path lets a lead bulk-repair every **SAFE-classified** active run in one click.
- New admin affordance: `<BackfillSafeAllocationsButton />` rendered in the partial-bags workbench card (`/admin/partial-bags`). Runs the new server action `backfillSafeMissingAllocationsAction` (`app/(admin)/partial-bags/actions.ts`), reports `repaired` / `skipped` counts inline, and only operates on classifications the helper labels `SAFE_OPEN_ALLOCATION`.
- New library module `lib/production/backfill-missing-active-allocation.ts` (801 LOC) — pure logic + transactional apply path. Default disposition: dry-run report only. Writes one audit row per session via `writeAudit` ("BACKFILL-ALLOCATION-v0.4.109" notes). Hard rules baked in: does not close allocations, does not issue lots, does not touch Zoho.
- Paired contract test `lib/production/backfill-missing-active-allocation.test.ts` (465 LOC) — pins the classification ladder and the apply gate.
- CLI runner `scripts/backfill-missing-active-allocations.ts` for ops-style invocation (dry-run by default; `--apply --yes` required to write).

### Notes

- No env changes. No live-write gate flips. No DB migrations. No Zoho writes.
- Backfill function is gated to the SAFE classification only; AMBIGUOUS / CONFLICTING_OPEN_SESSION / FINALIZED runs are skipped (counted toward `skipped`, never silently repaired).
- The lib + test + button + action + page wiring + CLI are interconnected and shipped together so the repo's tracked state stays consistent — partial trees of this feature are not viable (the tracked `partial-bags/actions.ts` and `page.tsx` import directly from the previously-untracked lib + button).

## [1.4.19] — 2026-06-24

### Changed
- **Cleanup sprint (Phase 0/0.5/2 — no behavior change).** Repaired the lint command, re-pinned 4 outdated test assertions, fixed 2 real `<a>` → `<Link>` violations, removed 5 stale `eslint-disable` directives, deleted confirmed dead-code module `lib/production/diagnostics.ts` + its paired shape-only fixture test, and pruned 9 untracked debris pilots from the local working tree.

### Tooling
- Replaced the deprecated `next lint` with `eslint .` driven by a new `eslint.config.mjs` flat config (Next.js `@next/next` recommended + core-web-vitals rules). Added `@typescript-eslint/parser` + `@typescript-eslint/eslint-plugin` (rule definitions only; no rules enabled — so existing inline `// eslint-disable-next-line @typescript-eslint/*` directives resolve). `npm run lint` now runs non-interactively and reports findings; PR gate becomes meaningful.

### Tests
- `lib/zoho/partial-unique-luma-op-migration.test.ts`: pin migration `0067` by tag-lookup instead of last-journal-entry so the test stays green as future migrations append.
- `app/(admin)/production/start/page.test.ts` and `app/(admin)/reports/audit-log/page.test.ts`: read the label assertion from `lib/auth/admin-nav.ts` (its current home after the NAV-PHASED-1 refactor) instead of `components/admin/sidebar.tsx`.
- `app/(floor)/floor/[token]/page.test.ts`: replace the obsolete `filterSealingProductsByTabletType` assertion with checks for the current shared helper (`lib/production/sealing-product`, `resolveSealingProductSelection`, `sealingTabletsByProduct`).

### Notes
- No env changes. No deploy gates flipped. No DB migrations. No production code behavior change.
- Confirmed test count delta: 4584 → 4578 after removing the diagnostics fixture (its 6 contract tests pinned shape of a runtime-orphan module).
- `lib/production/diagnostics.ts` had zero runtime callers across `app/`, `lib/`, `components/`, `scripts/`. Its only reference was the paired `diagnostics.test.ts` (pure-shape fixture, "Phase E.5 — diagnostic layer contract tests") — both deleted together.

## [1.4.18] — 2026-06-19

### Fixed
- **`SOURCE_ALLOCATION_COMPONENT_NOT_IN_BOM` blocker — Luma half resolved.** The Zoho gateway v1.28.0 now validates each `luma_operation_snapshot.source_allocations[]` row against a single `assembly_level`'s BOM (per-row scoped, not broadcast). Luma now stamps `assembly_level` on every row. Implementation: new `deriveSourceAllocationAssemblyLevel(componentRole)` helper in `lib/zoho/luma-operation-snapshot.ts` (returns `unit_assembly` today because all source allocations come from `raw_bag_allocation_sessions` = raw tablets into unit assembly); helper is forward-compatible for re-work flows. Admin action and pilot script thread `componentRole` through to the snapshot builder. Pilot contracts (Choco Drift, FIX Relax, Sweet Trip) gain the literal `assembly_level: "unit_assembly"` on their hard-coded source rows.

### Added — read-only audit / dry-run tooling for source-bag receive coverage
- `scripts/audit-source-bag-zoho-receive-coverage.ts` — read-only TSV report of every source bag referenced by finished_lot_raw_bags, its Zoho receive state, and per-bag eligibility for a bag-finish receive preview.
- `scripts/backfill-source-bag-zoho-receive-previews.ts` — dry-run by default; supports `--inventory-bag-id`, `--finished-lot-id`, `--limit`, `--apply-preview-only`. The apply path is currently a planned no-op (logs what it would do) to keep the safety surface minimal; wiring it to the staging-actions module is a separate owner-approved follow-up.

### Notes
- No env changes. Live-write gates remain OFF.
- The `SOURCE_BAG_ZOHO_RECEIPT_UNCONFIRMED` blocker is unchanged — it depends on Zoho receives being committed per source bag (data, not code). The audit shows 36 of 38 source bags have no `zoho_raw_bag_receives` row.
- `BOM_COMPONENT_INSUFFICIENT_STOCK` for the Sweet Trip display intermediate is also untouched — it reflects Zoho's negative stock for `5254962000006219049` (production has run ahead of Zoho commits). Self-resolves once Luma starts committing production output.
- `buildLumaProductionOutputOperationId` still retained per v1.4.17 hold.

## [1.4.17] — 2026-06-18

### Fixed
- **`LUMA_OPERATION_NOT_PERSISTED` gateway blocker resolved.** The production-output preview admin action was building the `luma_operation_snapshot.luma_operation_id` via `buildLumaProductionOutputOperationId` (returns `luma-production-output:${id}`, no `-preview` prefix) while the envelope was built via `buildProductionOutputOperationId` (returns `luma-production-output-preview:${id}`). The Zoho gateway compared the two and emitted `LUMA_OPERATION_NOT_PERSISTED` when they didn't match. The snapshot now sources its `lumaOperationId` from `buildResult.payload.luma_operation_id`, so envelope and snapshot can never drift. The non-preview helper is retained for a future commit path. Surfaced first on the v1.4.12 BlueRaz #36 preview rerun, after the partial-unique migration unblocked the upsert collision.

### Notes
- No env changes. Live-write gates remain OFF. No warehouse changes. No payload quantity changes.
- No deletion of `buildLumaProductionOutputOperationId`; it's now unused on the preview path but the commit path may still reference it.
- The `SOURCE_ALLOCATION_COMPONENT_NOT_IN_BOM` blocker remains. Gateway investigation showed the Zoho gateway's `SourceAllocation` model accepts only `source_bag_id` / `item_id` / `human_lot_number` / `quantity` — no `assembly_level` — and the per-level validation broadcasts every row across every level. Resolution requires a coordinated gateway-side change to (a) accept `assembly_level` and (b) filter rows by the current level before validating against that level's BOM. Out of scope for this Luma-only patch.
- The `SOURCE_BAG_ZOHO_RECEIPT_UNCONFIRMED` blocker remains. This is expected pre-live receive behavior and will be resolved by the live receive sequence (separate plan).

## [1.4.16] — 2026-06-18

### Fixed
- **Production output "View Zoho op" no longer 404s.** The action links to the finished lot's Zoho production-output preview card (`/finished-lots/<id>#zoho-push`) instead of a non-existent `/zoho-production-operations/<opId>` detail route.

## [1.4.15] — 2026-06-18

### Fixed
- **Issue finished lot redirect no longer surfaces `NEXT_REDIRECT` as an error.** `redirect()` is called outside the try/catch in the coordinated lot action so successful issue + closeout navigates to the new lot page instead of showing a false failure.

## [1.4.14] — 2026-06-18

### Fixed
- **Raw bag allocation sessions allow negative ending balance.** Migration `0068_rba_sessions_allow_negative_ending_balance` relaxes `rba_sessions_qty_signs` so `ending_balance_qty` can be negative when packaging consumption exceeds the vendor label count. Coordinated lot issue + repair closeout no longer fails at the database layer.

## [1.4.13] — 2026-06-18

### Fixed
- **Issue finished lot action accepts negative ending balance.** The coordinated lot Zod schema no longer requires `endingBalanceQty >= 0`, so repair allocation closeout can submit when packaging consumption exceeds the vendor label count (v1.4.11 UI/server closeout path).

## [1.4.12] — 2026-06-18

### Fixed
- **Partial-unique migration `0067_zoho_prod_output_ops_partial_unique_luma_op` lands here.** The v1.4.10 CHANGELOG entry below describes the same partial-unique migration work but its files were not deployed — v1.4.10 was never released as a tagged build, and v1.4.11 shipped on top of it with the vendor-label fix only. v1.4.12 carries the actual migration SQL, the schema mirror update, the `_journal.json` registration, and the migration contract tests. Behavior, contract, and posture are identical to the v1.4.10 entry — see below for full detail.

### Notes
- No env changes. Live-write gates remain OFF. No warehouse changes. No payload quantity changes.
- v1.4.11 vendor-label fix (commit `6745de9`) preserved by construction.
- No row deletes; the voided op `114778f7-b64e-4c50-9a57-aba5e2db7651` remains in place as audit history.

## [1.4.11] — 2026-06-18

### Fixed
- **Issue finished lot — over-consumption vs vendor label is a warning, not a blocker.** When packaging-derived tablet consumption exceeds the source bag's intake label count, the repair/closeout form still allows issuing the lot and closing allocation. Negative ending balance remains visible; packaging output is treated as the ledger source of truth.

## [1.4.10] — 2026-06-18

### Fixed
- **`zoho_production_output_ops.luma_operation_id` uniqueness is now scoped to non-voided rows.** Migration `0067_zoho_prod_output_ops_partial_unique_luma_op` replaces the prior global `UNIQUE INDEX` on `luma_operation_id` with a partial unique index `WHERE voided_at IS NULL`. Voided ops (audit history) no longer block a fresh preview attempt against the same finished lot. The upsert continues to look up active rows only (`isNull(voidedAt)`); no app code change, no retry-suffixed operation IDs, no row deletes, no unvoiding. Unblocks BlueRaz #36 — the v1.4.6 gateway preview returned HTTP 200, then `upsertZohoProductionOutputPreviewOp` crashed on the legacy voided op `114778f7-b64e-4c50-9a57-aba5e2db7651` whose `luma_operation_id` collided with the new INSERT under the prior non-partial constraint.

### Contract (locked)
- One active (`voided_at IS NULL`) row per `luma_operation_id`.
- Multiple voided rows for the same `luma_operation_id` are allowed (audit history).
- The upsert keeps targeting active rows only.

### Notes
- Constraint swap is additive — preserves all existing rows. The voided op `114778f7-b64e-4c50-9a57-aba5e2db7651` is intentionally left in place as audit history.
- No env changes. Live-write gates remain OFF. No warehouse changes. No payload quantity changes.
- No new per-SKU hard-coded contract. No app-level operation-ID rotation. No data deletes.

## [1.4.9] — 2026-06-18

### Fixed
- **Settings hub respects role access.** Configuration links on `/settings` are filtered by the signed-in user's role (`SESSION`, `LEAD`, `ADMIN`, `OWNER`), matching each destination page's auth guard. Managers and staff no longer see admin-only setup links they cannot open. Owner-only areas (legacy import, danger zone) are hidden from admins.

## [1.4.8] — 2026-06-18

### Fixed
- **Floor sealing product picker excludes wrong-route SKUs and auto-assigns when unambiguous.** Card-route stations (blister, sealing, packaging) now only offer `CARD` finished goods — variety packs and bottle SKUs are excluded. When a bag's tablet type matches exactly one compatible card product, sealing auto-saves that product instead of showing a dropdown.

## [1.4.7] — 2026-06-18

### Fixed
- **Admin sidebar respects role access.** Nav links are filtered by the signed-in user's role (`STAFF`, `LEAD`, `MANAGER`, `ADMIN`, `OWNER`) using the same gates as each destination page (`requireSession`, `requireLead`, `requireAdmin`). Operators no longer see admin-only pages they cannot open.

## [1.4.6] — 2026-06-18

### Fixed
- **Dynamic BOM derivation matches the pilot contract's batch-tracking semantics.** `deriveNormalizedBomQuantitiesFromRows` now returns an empty `batchTrackedItemIds` Set regardless of how many tablets it derives, mirroring the existing Choco Drift / Sweet Trip / FIX Relax pilot contracts. The v1.4.4 deriver populated the Set with every derived raw item ID, which triggered Zoho batch resolution for tablets whose lots aren't registered as Zoho batches — that surfaced as `ZOHO_BATCH_MISSING` for BlueRaz lot `CA4RA16` during the v1.4.4 BlueRaz #36 preview attempt. Batch tracking remains opt-in; a future explicit mechanism can enable per-item tracking when operators register Zoho batches. The `normalizedBomQuantities` derivation is unchanged.

### Notes
- No migration. No env changes. Live-write gates remain OFF.
- No new per-SKU hard-coded contract. No BlueRaz pilot.
- No payload quantity changes. No warehouse changes.
- v1.4.5 repair-allocation balance auto-derive (commit `7ddf6c0`) preserved by construction.

## [1.4.5] — 2026-06-18

### Fixed
- **Issue finished lot — repair allocation closeout:** Starting and ending tablet balances are now derived automatically from the linked source bag intake record and calculated consumption. Operators no longer type starting/ending balances on the repair path; Luma loads `pill_count` / declared intake and computes ending balance. Submit is blocked with a clear message when consumption exceeds the bag count (negative ending balance).

## [1.4.4] — 2026-06-18

### Fixed
- **Production-output preview / commit now derives `normalizedBomQuantities` from Luma product setup data instead of per-SKU hard-coded pilot contracts.** New helper `lib/zoho/derive-normalized-bom-quantities.ts` reads `products.tablets_per_unit` + `product_allowed_tablets` + `tablet_types.zoho_item_id` and builds the map automatically. Both dispatchers — the admin preview action and the consolidated cron path — try the Luma-data derivation first and only fall back to the existing Choco Drift / Sweet Trip / FIX Relax pilot contracts as a transition mode. Existing pilots are flagged `@deprecated` and the dispatcher is no longer extensible by SKU. Unblocks BlueRaz #36 (the previous generic `BOM_QUANTITY_PENDING` gateway-level blocker is replaced with specific Luma-side blockers: `MISSING_TABLETS_PER_UNIT`, `MISSING_ALLOWED_TABLETS`, `MISSING_TABLET_ZOHO_ITEM_ID`).

### Notes
- No migration. No env changes. Live-write gates remain OFF.
- No new per-SKU hard-coded contract added (no BlueRaz pilot).
- No `Hyroxi Mit A - BlueRaz` / `tt-product-30` / raw item ID hard-coded anywhere except in test fixtures.
- BlueRaz packaging spec (`product_packaging_specs`) is still empty — non-blocking for production-output preview / commit because Zoho composite-item BOMs carry packaging; flagged as an operator follow-up if Luma packaging inventory bookkeeping needs it.
- Existing Choco Drift / Sweet Trip / FIX Relax flows unchanged by transitive fallback.

## [1.4.3] — 2026-06-17

### Fixed
- **Production output search:** Receipt / product search on `/packaging-output` no longer crashes with "Page failed to render". The workbench query was joining PO data through a non-existent `inventory_bags.po_line_id` column; it now follows the real genealogy path (`inventory_bags` → `small_boxes` → `receives` → `purchase_orders`).

## [1.4.2] — 2026-06-17

### Fixed
- **Admin Zoho preview attaches the persisted operation snapshot.** `previewZohoProductionOutputAction` now calls `buildSourceAllocationsForFinishedLot` and `buildLumaOperationSnapshotFromOpRow`, then `attachSnapshotToPayload` + `verification: { mode: "snapshot" }` before the gateway call. The upsert persists the four snapshot-source fields (`finalized_at`, `product_id`, `product_family`, `finished_sku`) and the source allocation rows so the gateway's snapshot verification matches the persisted Luma op. Previously the admin preview produced `LUMA_OPERATION_NOT_PERSISTED` and `ONE_SHOT_SCRIPT_BLOCKED` blockers because the snapshot was never attached.
- **Consolidated path no longer rejects NEEDS_MAPPING inserts on lots with cases produced.** The partial NEEDS_MAPPING insert in `upsertConsolidatedProductionOutputOpForLot` (`!sourceWithPo.ok` branch) now pulls `unit_composite_item_id`, `display_composite_item_id`, and `case_composite_item_id` through from the already-built payload, satisfying the table check constraints `zoho_prod_output_ops_case_item_check` / `_display_item_check`. The constraints are not bypassed or relaxed; the inserts simply carry the data the constraint requires. Fix verified against BlueRaz #36.

### Notes
- v1.4.0 warehouse-capability behavior preserved: capability call first, OPTIONAL+missing → omit, `warehouse_id` absent from payload, audit fields persisted unchanged.
- No migration. No env changes. Live-write gates remain OFF.

## [1.4.1] — 2026-06-17

### Fixed
- **Receive pills — supplier lot setup:** Removed the unused "Receipt prefix (optional)" field. Operators enter the full receipt start (e.g. `1001` or `QA-R1001`) in one field; prefix override was redundant with embedded-prefix receipt numbers.
- **Receive pills — "Receive another batch":** After a successful save, the button now reloads `/receiving/raw-bags?poId=…` with the PO from the receive just saved. Operators can still change PO or line; the dropdown is simply pre-filled for back-to-back receives on the same PO.

## [1.4.0] — 2026-06-17

### Added
- **Zoho warehouse capability.** Production-output preview now consumes the Zoho gateway's `GET /zoho/brand-capabilities/warehouse` (gateway v1.23.1) on every preview attempt — read-through, no DB cache yet. New pure helpers `lib/zoho/brand-capabilities-client.ts` (total mapping over the gateway response: REQUIRED / OPTIONAL / UNKNOWN; transport / parse / non-2xx all collapse to UNKNOWN) and `lib/zoho/warehouse-decision.ts` (pure combiner that takes capability + v1.3 warehouse-resolution outcome and returns use / omit / block). When capability is OPTIONAL and no warehouse resolves, the preview payload's `warehouse_id` key is **absent** (not empty string, not null) so Zoho's warehouse-not-used path is exercised correctly for `haute_brands`. UNKNOWN always blocks regardless of resolution — operator-typed values cannot override an unknown capability. Adds four audit fields (`warehouseRequired`, `warehouseOmitted`, `capabilitySource`, `capabilityGatewayRequestId`) persisted on every preview op row via the existing `quantity_basis` jsonb sink (no migration). Preview card surfaces the "This Zoho org does not use warehouses; warehouse will be omitted." banner and renders capability source + gateway request id rows on the persisted snapshot.
- **`/api/health` exposes the operator-facing version** (`version` field next to the existing `sha`). Single source of truth for the running version — matches `package.json` and the admin/floor footer badges.

### Fixed
- **Version-label regression repaired.** The previous release was tagged `0.4.110` in `package.json`, which propagated through `getPackageVersion()` to the admin footer, floor footer, and settings page. Per `VERSIONING.md` the project is post-launch on the `1.x.y` line and the `0.x.y` series is closed forever. This release returns the operator-facing version to the `1.x.y` line (`1.4.0`). Pinned by new guard tests in `lib/version.contract.test.ts` (refuses any `0.x.y` in `package.json`, refuses `/api/health` disagreement, refuses a missing CHANGELOG entry for the current version).

### Notes
- No migration. No env changes. Live-write gates remain OFF (observation mode).
- No `/zoho/cached/*` cutover (still deferred until cached-endpoints phase).
- No fake warehouse IDs, no env-level capability hatch, no UNKNOWN → OPTIONAL fallback anywhere.
- No app-level or product-level warehouse override is set; resolver still routes to OPTIONAL → omit for the haute_brands org.

## [0.4.110] — 2026-06-17

### Added
- **Production Output search/history workbench.** Adds receipt / product / workflow / date / status / PO / limit / page filters to `/packaging-output` so operators can find older issued lots and older awaiting-lot rows outside the 7-day dashboard window. Status badges and drilldowns (workflow, finished lot, Zoho op, PO reconciliation) on every row. New "Push to Zoho" readiness CTA navigates to the finished-lot detail preview without executing any live Zoho action from the workbench. Default `/packaging-output` dashboard behavior (7-day metrics, 20-row backlog queue, `#output-queue` anchor) is preserved unchanged.

## [1.3.0] — 2026-06-16

### Added
- **Production-output warehouse resolution:** Operator pick > per-product override > app-settings default > env > BLOCK. `lib/zoho/warehouse-resolution.ts` is the canonical pure helper. Migration 0066 adds `products.zoho_default_warehouse_id`. `/settings/zoho` warehouse input is now the primary app-wide default (env becomes fallback only). Product admin page gains a per-product override input. Unblocks the production-output preview test (#36) without a `ZOHO_WAREHOUSE_ID` env edit on the LXC.

### Notes
- No env changes. Live-write gates remain OFF (observation mode).
- No Zoho v1.23.0 cached-endpoint integration yet (`/zoho/cached/*` paths are still unused). Cached warehouse dropdown will replace the free-text input once the gateway ships v1.23.0.

## [1.2.0] — 2026-06-16

### Added
- **Overs/extras resolution workflow.** Operator-driven decision panel for raw-bag receives that hit the staged `NEEDS_REVIEW` + `OVER_RECEIVE_EXCEEDS_PO_REMAINING` blocker (per `docs/OVERS_EXTRAS_RESOLUTION_DESIGN.md`). Four decisions:
  - `adjust_down` — lowers staged qty, freshens idempotency key + buffer, transitions row back to `PENDING` for the next commit attempt
  - `hold_for_po_update` — `HELD` with `held_reason` carrying the operator note (tag persists until unhold, which re-clears it)
  - `needs_overs_po` — row stays `NEEDS_REVIEW` with the awaiting-overs-PO tag visible in the staging UI sub-queue
  - `reconciled_manually` — terminal `VOIDED` with operator-supplied reason
- New panel `app/(admin)/partial-bags/[inventoryBagId]/zoho-receive/overs-resolution-panel.tsx` (308 LOC).

### Scope guards (pinned by source-level contract tests)
- Cron still skips `NEEDS_REVIEW`.
- Manual commit-now still blocked while `NEEDS_REVIEW`.
- `inventory_bags.declared_pill_count` is never mutated.
- No split-receive and no auto-create overs PO in v1.2.0.
- Bag edit / regenerate clears `overs_decision_*` (audit log preserves prior decision history).

### Schema
- Migration `0065` adds six additive columns to `zoho_raw_bag_receives` (`overs_decision`, `overs_decision_at`, `overs_decision_by_user_id`, `overs_decision_note`, `adjusted_received_quantity`, `parent_op_id`) plus a partial index on `overs_decision`. No DROP / RENAME / type change.

### Tests
- 60 new tests (32 pure helpers + 28 source-level contract). Total suite at release: 4251/4251 passing; tsc clean; next build clean.

### Notes
- No env changes. Live-write gates remain OFF (observation mode).
- Inventory bags and the Zoho gateway are never touched by this workflow; the staging buffer remains the only source of write intent.

## [1.1.1] — 2026-06-16

### Fixed
- **Forward new v1.1.0 env vars to the app container.** `docker-compose.yml` only forwards env vars listed under `services.app.environment`. v1.1.0 added three new vars (`LUMA_CRON_SECRET`, `ZOHO_AUTO_COMMIT_ENABLED`, `ZOHO_AUTO_COMMIT_BUFFER_HOURS`) that were set in `/etc/luma/.env` on LXC 122 but never reached the container — the cron endpoint returned 503 because `LUMA_CRON_SECRET` was unset inside the process. Adds those three vars to the compose environment block with fail-closed defaults (`LUMA_CRON_SECRET` empty → 503; `ZOHO_AUTO_COMMIT_ENABLED=false` → cron is a no-op; `ZOHO_AUTO_COMMIT_BUFFER_HOURS=24` → production review window).

### Notes
- Build-system fix only. No behavior change in Luma or the gateway.

## [1.1.0] — 2026-06-16

### Added — Zoho staging-buffer system

Operators can run by hand or auto-commit on a 24h review window.

### Schema
- Migration `0062` — extends `zoho_raw_bag_receive_status` enum with `HELD`, `NEEDS_MAPPING`, `COMMITTING`, `VOIDED`.
- Migration `0063` — staging-buffer columns on `zoho_raw_bag_receives` and `zoho_production_output_ops` (`auto_commit_eligible_at`, `held_at`, `voided_at`, `void_reason`, `commit_idempotency_key`, `commit_attempt_count`, `commit_request_payload`, `mapping_blockers`). Adds `products.zoho_live_commit_enabled`.
- Migration `0064` — extends `zoho_raw_bag_receive_status` with `NEEDS_REVIEW` for business-decision blockers (overs, etc.).
- All additive; schema.ts mirrored; journal updated.

### Shared commit functions
- `lib/zoho/shared-raw-bag-receive-commit.ts` and `lib/zoho/shared-production-output-commit.ts` — one path per surface, used by both manual and auto-commit callers. Each:
  - pre-flight gate via `resolveAutoCommitWriteGates()` BEFORE claim, so guard-blocked never burns `commit_attempt_count` and never calls the live gateway
  - atomic conditional `UPDATE` claim: status → `COMMITTING` with attempt count +1 only on real attempts
  - state machine: `PENDING` / `PREVIEWED` / `FAILED` → `COMMITTING` → `COMMITTED` / `NEEDS_MAPPING` / `NEEDS_REVIEW` / `FAILED` / `PENDING`-retry
  - distinct result kinds: `COMMITTED`, `STATE_BLOCKED`, `GUARD_BLOCKED`, `NEEDS_MAPPING`, `NEEDS_REVIEW`, `TRANSPORT_RETRYABLE`, `PERMANENT_FAILURE`
  - commit-trigger suffix appended to frozen notes RIGHT BEFORE the gateway call; frozen body is never mutated

### Frozen payloads + accounting notes
- `lib/zoho/zoho-commit-notes.ts` — pure helpers per op type; priority identifiers (Luma op id, receipt #, bag #, lot #, SKU, qty) preserved on truncation; commit-trigger suffix always preserved.
- `lib/zoho/freeze-raw-bag-receive-payload.ts` — freezes payload + accounting notes at preview/seed time and replays verbatim on commit.

### Cron + env
- New `LUMA_CRON_SECRET`, `ZOHO_AUTO_COMMIT_ENABLED`, `ZOHO_AUTO_COMMIT_BUFFER_HOURS` env vars (cron is a no-op while `ZOHO_AUTO_COMMIT_ENABLED=false`).

## [1.0.2] — 2026-06-02

### Added
- **Push to Zoho go-live:** PM-approved SKU allowlist module, operator banners on raw-bag receive and production-output ops, doc index (`ZOHO_PUSH_GO_LIVE_INDEX.md`), updated `LAUNCH_CONTROL.md` for ca2b9a2/v1.0.1+ posture.

## [1.0.1] — 2026-06-02

### Fixed
- **Production-output commit hardening:** Reconcile Luma to COMMITTED from Zoho idempotency replay after network errors, 409 conflicts, or ambiguous gateway responses; never leave successful Zoho proof in FAILED/READY.
- **Preview vs commit idempotency:** Distinct key namespaces (`luma-production-output-preview:` vs `luma-production-output:`) with assertion at commit time.
- **Operator UI states:** Explicit commit lifecycle labels (READY_TO_COMMIT, COMMIT_IN_PROGRESS, COMMIT_AMBIGUOUS_NEEDS_REVIEW, COMMITTED_IN_ZOHO_NEEDS_LUMA_RECONCILE, etc.).
- **Pilot commit scripts:** `withPilotProductionOutputCommitWindow` closes Luma gates in `finally`; documented Zoho shell trap checklist.

## [0.4.115] — 2026-06-02

### Added
- **Pilot #2 Sweet Trip:** `v1206-sweet-trip-pilot-contract.ts` with confirmed 4:1 raw + 1:1 blister BOM, wired through `sourceAllocationBuildOptsForSku()`, tests, and scoped prep/walkthrough scripts.

## [0.4.114] — 2026-06-15

### Fixed
- **Workflow submissions deploy:** Split blister counter segment client helpers from the DB loader so `next build` does not bundle `lib/db` into the workflow table.

## [0.4.113] — 2026-06-12

### Fixed
- **Workflow submissions blister totals:** Show PVC counter segments (roll change + bag complete) and blister bag total in the expanded bag view. Submission `count_total` alone only reflects the last machine-counter segment after a roll change.

## [0.4.112] — 2026-06-12

### Fixed
- **Missed bag backfill deploy:** Split client-safe contract types from the server backfill module so `next build` no longer bundles `lib/db` into the settings form.

## [0.4.111] — 2026-06-12

### Added
- **Missed blister bag backfill:** Admin settings tool at `/settings/missed-bag-backfill` to append historical card assignment, PVC roll change, and blister complete events when a bag was run on the floor but never scanned. Dry-run preview, typed confirmation, audit log, roll read-model rebuild, and live board snapshot restore. CLI: `scripts/apply-missed-blister-bag-backfill.ts`.

## [0.4.110] — 2026-06-02

### Fixed
- **Production-output commit payload:** Map internal LUMA consolidated ops to the Zoho Integration service body before commit; preview and commit now share `buildProductionOutputServicePayloadFromLuma` so the contract cannot drift.
- **Commit response parsing:** Parse Zoho bundle IDs from `steps[]` (FIX Relax assembly path) so `zoho_bundle_ids` persist without manual reconciliation.

## [0.4.109] — 2026-06-02

### Added
- **Production Output backlog:** Auto-issue blocker visibility and next-step actions on `/packaging-output` (`Auto-issue status`, `Next step`, repair/auto-issue row actions).
- **Backlog repair:** Safe backlog repair and auto-issue actions for finalized bags missing lots, with estimated tablet consumption from product math.
- **Issue Finished Lot repair:** Improved repair copy and prefill on `/finished-lots/new` so admins do not manually calculate normal tablet consumption.
- **QA packet:** `docs/QA_AUTO_LOT_ALLOCATION_VERIFICATION.md` for allocation/auto-lot verification.

## [0.4.108] — 2026-06-05

### Added (ZOHO-PRODUCTION-OUTPUT-CONSOLIDATED-1)
- **Consolidated Zoho commit:** One shared-service production-output request per finished lot via `POST /zoho/luma/production-output/commit`, with stable idempotency, outbox table, and admin UI at `/zoho-production-operations`.
- **Feature flags:** `ZOHO_PRODUCTION_OUTPUT_ENABLED` and related env gates default off; legacy `zoho_assembly_ops` path remains unless explicitly enabled.

### Added (WORKFLOW-SUBMISSION-CORRECTION-RECOVERY-1)
- **Submission correction:** OWNER/ADMIN numeric corrections via shared `SUBMISSION_CORRECTION` service with metrics reprojection and downstream Zoho op voiding when safe.
- **Wrong-route recovery:** New `WORKFLOW_RECOVERY` event and admin forms on `/workflow-submissions` for auditable bag rerouting without rewriting history.

## [0.4.107] — 2026-06-05

### Fixed (FINISHED-LOT-ISSUE-PREFILL-1)
- **Production output queue:** `Review / issue lot` now opens the finished-lot issue form for the selected workflow bag instead of a blank manual lot form.
- **Issue lot prefill:** The form preloads the selected bag's receipt number, product, finalized date, cases, displays, loose count, and unit output from canonical read models while keeping the admin able to review/edit before issuing.

## [0.4.106] — 2026-06-05

### Added (AUTO-FINISHED-LOT-RELEASE-1)
- **Packaging close-out release:** Full-bag packaging close-out now keeps `PACKAGING_COMPLETE` and auto `BAG_FINALIZED`, then creates and releases a linked finished lot using the source receipt number as the lot/trace code.
- **Exception safety:** Partial packaging is excluded, and missing receipt/shelf-life/open allocation cases leave the bag finalized with an audit exception instead of fabricating a finished lot.

## [0.4.105] — 2026-06-04

### Fixed (PRODUCTION-OUTPUT-RECEIPT-1)
- **Output queue receipt column:** Production output now shows receipt numbers from `inventory_bags.internal_receipt_number` (with legacy `workflow_bags.receipt_number` fallback) instead of blank dashes for new Luma workflows.

## [0.4.104] — 2026-06-04

### Fixed (QR-ACTIVE-WORKFLOW-CONTEXT-1)
- **QR card assignments:** Assigned cards now show the active workflow id, stage/paused/finalized state, PO/receipt/tablet/bag context, and a direct timeline link instead of only “Active workflow.”
- **Floor pickup labels:** Resume/pickup dropdowns now include PO/tablet/bag context when available, so operators and supervisors can identify active cards like Card #55/#81 without guessing.

## [0.4.103] — 2026-06-04

### Added (WORKFLOW-SUBMISSION-ADMIN-REPAIR-1)
- **Workflow submissions admin repair:** OWNER/ADMIN users can append a missing BLISTER close-out for a STARTED bag with no submission events, releasing the bag for downstream sealing without editing historical events.
- **Audit trail:** The repair appends `BAG_RESUMED` when needed, `BLISTER_COMPLETE`, `BAG_RELEASED`, and an `audit_log` entry with the supervisor note and counter value.
- **Admin bag labels:** Workflow submissions avoids duplicating the PO prefix when PO numbers are already stored as values like `PO-00206`.

## [0.4.102] — 2026-06-03

### Fixed (READY PARTIAL FLOOR READINESS)
- **Partial restart readiness:** Ready partial bags with stale ASSIGNED workflow (e.g. `bag-card-104`) no longer fail floor start with “This bag is already in production.” Floor restart passes `allowPartialBagRestart` through readiness evaluation, matching admin Start run.

## [0.4.101] — 2026-06-03

### Fixed (READY PARTIAL FLOOR START)
- **Ready partial floor scan:** Inventory-resolved partial bags (e.g. `bag-card-104` after supervisor estimate) no longer block on a stale non-finalized legacy workflow assignment. First-op station scans create a new workflow run with product selection instead of returning “not ready for this station yet.”
- **Classification order:** Partial Ready eligibility is evaluated before the active-workflow gate so `/partial-bags`, admin Start run, and floor scan share the same rules.

## [0.4.100] — 2026-06-03

### Fixed (MULTI-SEALING-STATION-UNBLOCK-1)
- **Sealing station handoff:** Overlapped sealing stations can now manually release their station pin after another sealing station submits the final full-bag close-out, preventing completed bags from blocking the other sealer tablets.

## [0.4.99] — 2026-06-03

### Fixed (PARTIAL-BAGS RESOLVE RENDER HOTFIX)
- **Resolve page crash:** Stop passing `PartialBagReviewContext` Date fields into the client resolve form; only serializable `inventoryBagId` and `declaredPillCount` cross the RSC boundary.
- **Resolve submit crash:** Allocation ledger events now use valid UUID `clientEventId` values instead of `{uuid}-open` suffix strings rejected by Postgres.

## [0.4.98] — 2026-06-03

### Fixed (FLOOR-CURRENT-BAG-PO-PREFIX-1)
- **Floor current bag label:** Avoids duplicating the PO prefix when received PO numbers are already stored as values like `PO-00238`.

## [0.4.97] — 2026-06-03

### Changed (FLOOR-CURRENT-BAG-CONTEXT-1)
- **Floor current bag label:** Station pages now show PO / tablet / bag context as the primary current-bag label when received-bag lineage is available, with the QR card label kept as secondary text.
- **Pause reasons:** Added **Shift break** as a pause reason on all station pause dropdowns and server pause validation.
- **Counter snapshots:** `shift_break` does not require a BLISTER/COMBINED counter snapshot; `shift_end` and `machine_jam` snapshot rules unchanged.

## [0.4.96] — 2026-06-03

### Fixed (LEGACY PARTIAL STATUS + SUPERVISOR ESTIMATE)
- **Workflow submissions badge:** Partial sealed/packaged workflows (including legacy void-repaired bags like `bag-card-104`) display `PARTIAL` instead of misleading `BLISTERED`. Display-only — `read_bag_state.stage` unchanged for floor resume.
- **Supervisor estimate resolution:** Resolve inventory form warns that estimate is low confidence, requires a 10+ character reason, and never prefills from sealed cards. `/partial-bags` shows remaining source and confidence for Ready rows.

## [0.4.95] — 2026-06-03

### Added (BAG-CARD-104 LEGACY PARTIAL FINALIZATION VOID SUPPORT)
- **Append-only void correction:** Projector and read-model synthesizer honor `SUBMISSION_CORRECTED` with `correction_kind: VOID_ERRONEOUS_BAG_FINALIZATION` — erroneous legacy `BAG_FINALIZED` after partial packaging is voided without deleting events or rewriting payloads.
- **One-off repair script:** `scripts/repair-bag-card-104-legacy-partial-finalization.ts` — dry-run by default; apply gated by `ALLOW_PRODUCTION_REPAIR`, `CONFIRM_WORKFLOW_BAG_ID`, and `CONFIRM_BAG_CARD`. **No production repair is applied by this release.**
- **Honest inventory:** No remaining-tablet fabrication, no allocation session repair, no inventory readiness changes.

## [0.4.94] — 2026-06-03

### Fixed (PARTIAL-SEAL-DISPLAY-1)
- **Workflow submissions display:** Historical partial `SEALING_COMPLETE` events now render `payload.sealed_partial_count` as `Sealed partial` instead of showing a blank sealed count.
- **Honest remaining count:** Partial seal display keeps remaining tablets unknown; no sealed-card-to-remaining-tablet inference and no DB backfill/event rewrite required.
- **Verify script:** `scripts/verify-partial-seal-display.ts`.

## [0.4.93] — 2026-06-03

### Fixed (FLOOR-PARTIAL-BAG-START-RESOLUTION-1)
- **Floor partial bag scans:** Idle linked partial bags (e.g. legacy `bag-card-104` after finalize) no longer show the receive-first error. Needs review bags get an operator-safe inventory review message; Ready partial bags can start/restart with fresh product selection.
- **Shared classifier:** `loadRawBagStartClassificationForScan` reuses `/partial-bags` eligibility (`classifyPartialBagInventoryEligibility`, `canRestartAvailablePartialRawBag`) for floor lookup, floor scan, and admin start.
- **Verify script:** `scripts/verify-floor-partial-bag-start-resolution.ts`.

## [0.4.92] — 2026-06-03

### Added (PARTIAL-BAG-REVIEW-CLOSEOUT-WORKFLOW-1)
- **Admin partial bag resolution:** `/partial-bags` Needs review rows get **Resolve inventory** — lead+ can record physically verified remaining tablets (count / weigh-back / supervisor estimate) and create a closed allocation session without DB scripts.
- **Audit:** `partial_bag.inventory_resolution` with prior state, method, remaining count, workflow bag id.
- **Verify script:** `scripts/verify-partial-bag-review-closeout.ts`.

### Fixed (PARTIAL-SUBMIT-MUST-NOT-FINALIZE-WORKFLOW-1 — regression guard)
- **Partial packaging must not finalize:** Confirmed v0.4.89+ floor path emits `partial_packaging: true`, skips `BAG_FINALIZED`, keeps QR assigned, and stays resumable at sealing; added `scripts/verify-partial-submit-does-not-finalize.ts`.
- **Historical note:** Production workflow `3d026c01…` (bag-card-104) finalized before v0.4.89; not mutated — remains Needs review until admin resolution.

## [0.4.91] — 2026-06-03

### Fixed (PARTIAL-BAG-NOT-LISTED-AFTER-PARTIAL-PACKAGING-1 follow-up)
- **`/partial-bags` legacy partial rows:** Surfaces finalized partial-close + packaging workflows missing allocation sessions (e.g. bag-card-104 legacy auto-finalize path) as **Needs review**, not hidden.
- **Audit script:** `--card`, `--workflow-bag-id`, `--recent`, `--limit` read-only filters; packaging timestamp includes legacy partial-close downstream packaging.

## [0.4.90] — 2026-06-03

### Fixed (PARTIAL-BAG-NOT-LISTED-AFTER-PARTIAL-PACKAGING-1)
- **Partial bag admin visibility:** `/partial-bags` now lists ready partial bags plus honest review rows for partial-packaged workflows that lack allocation closeout or inventory linkage (no silent hide).
- **Safe inventory return:** Partial `PACKAGING_COMPLETE` may `RETURNED_TO_STOCK` when an OPEN allocation session has manual consumption or weigh-back ledger evidence — never from sealed card counts.
- **Audit script:** `scripts/audit-partial-bag-visibility.ts` for read-only DB diagnosis.

### Tests
- `partial-bag-inventory-lifecycle.test.ts`, extended `partial-bags.test.ts`, `scripts/verify-available-partial-bag-after-partial-packaging.ts`.

## [0.4.89] — 2026-06-03

### Fixed (PARTIAL-PACKAGING-MUST-NOT-TERMINATE-CARD-ASSIGNMENT-1)
- **Partial packaging lifecycle:** `PACKAGING_COMPLETE` after a partial sealing close-out now emits `partial_packaging: true`, keeps `read_bag_state.stage` at `BLISTERED`, skips auto-finalize, and leaves the workflow QR card assigned.
- **Sealing resume:** Operators can scan the same reusable workflow card at sealing after partial downstream packaging; pickup eligibility is event-history aware (not a global `PACKAGED` reopen).
- **Legacy rows:** Assigned bags stuck at `PACKAGED` without whole-bag sealing close remain resumable only when partial-close evidence exists.

### Tests
- `sealing-partial-closeout.test.ts`, `sealing-partial-projector.test.ts`, updated `verify-sealing-partial-closeout.ts`, `scripts/verify-partial-packaging-resume.ts`.

## [0.4.88] — 2026-06-03

### Fixed (BLISTER-STARTED-BAG-RESUME-CLOSEOUT-1)
- **BLISTER same-station resume:** Scanning an assigned workflow card whose bag is still `STARTED` re-opens that bag at the first-op station instead of failing downstream pickup validation.
- **Operator errors:** Removed developer text (`no pickup stages defined`); stage mismatches use plain-language copy.
- **Card label normalization:** `Card #55`, `Bag Card 55`, and `bag-card-55` resolve to the same reusable QR card where applicable.
- **Dropdown backup:** First-op stations list in-progress `STARTED` bags for resume alongside received intake cards.

### Tests
- `stage-progression.test.ts`, `floor-scan-resolve.test.ts`, `scripts/verify-blister-started-bag-resume.ts`.

## [0.4.87] — 2026-06-03

### Fixed (SEALING-STATION-PICKUP-WORKFLOW-CARD-1)
- **Floor scan resolution:** `lookupCardByTokenAction` now resolves assigned workflow pickup cards before idle pool cards when the operator scans a reusable `bag-card-N` token that matches a mid-production card by label suffix (e.g. `bag-card-104` → **Bag Card 104**).
- **Sealing waiting banner:** `needsSealingFinalClose` now honors durable partial sealing close-out per bag instead of hardcoding `hasPartialSealingCloseout: false`.

### Tests
- `lib/production/floor-scan-resolve.test.ts`, lookup collision test in `scan-card-form.test.ts`, `scripts/verify-sealing-station-pickup-workflow-card.ts`.

## [0.4.86] — 2026-06-03

### Fixed (SEALING-PARTIAL-CLOSEOUT-COUNT-VALIDATION-1)
- **Sealing Step 3 partial submit:** No longer requires machine counter presses when segment totals already exist. Partial close-out derives `sealed_partial_count` from recorded segments only.
- **Error copy:** Zero-segment partial close-out now says “Record at least one sealing segment before submitting a partial bag” instead of the counter-presses message.

### Tests
- Floor action + UI source guards; `verify-sealing-partial-closeout.ts` static contract updated.

## [0.4.85] — 2026-06-02

### Fixed (PARTIAL-BAG-RESTART-PRODUCT-SELECTION-1)
- **Available partial raw bags:** Admin `/production/start?inventoryBagId=` restarts a partial bag with a **new** workflow bag; finished product is chosen for this run (filtered by `product_allowed_tablets`), not copied from the prior run.
- **Partial-bags page:** “Start run” links to the start form; “Last product” remains reference-only.
- **Floor partial resume:** Allocation sessions load by `inventory_bag_id` (not the finalized workflow bag); resume eligibility uses `canResumeFinalizedWorkflowOnInventoryBag`.
- **QR validation:** `validateRawBagQrForStart` allows `ASSIGNED` + prior workflow bag id when partial restart is eligible.

### Unchanged
- **Active partial-sealed packaging:** Product stays locked on the current workflow run (`SEALING_PRODUCT_ALREADY_SAVED` / partial close-out path).

### Tests
- `lib/production/partial-bag-restart.test.ts`, `app/(admin)/production/start/actions.partial-restart.test.ts`, `scripts/verify-partial-bag-restart.ts`.
- Closeout: `scripts/verify-partial-bag-restart-e2e.ts` (staging DB E2E + cleanup sweep), `lib/production/partial-bag-restart-e2e.harness.test.ts`.

## [0.4.84] — 2026-06-02

### Added (SEALING-PARTIAL-CLOSEOUT-1)
- **Sealing Step 3:** Submit whole bag (unchanged `{ lane_close: true }` → `SEALED`) or **Submit partial bag** with required reason enum (+ note when Other).
- **Partial close-out payload** on existing `SEALING_COMPLETE` (no migration): `partial_close`, `lane_close: false`, `sealed_partial_count` from segment totals, `partial_close_reason` / label / optional note.
- **Partial path:** Global stage stays `BLISTERED`; skips full sealed-bag throughput increment; auto-releases to packaging queue; packaging complete allowed at `BLISTERED` when partial close-out exists; QR/card assignment preserved through packaging.

### Intentionally not wired
- **Raw-bag allocation auto-close** on partial seal — sealed output is in cards, not tablets; closing allocation sessions would fabricate inventory counts without a reliable card→tablet mapping.

### Tests (SEALING-PARTIAL-CLOSEOUT-1)
- `lib/production/sealing-partial-closeout.test.ts`, `lib/projector/sealing-partial-projector.test.ts`, stage-progression / sealing-segments / floor action tests; `scripts/verify-sealing-partial-closeout.ts`.

## [0.4.83] — 2026-06-02

### Added (RAW-BAGS-READINESS-BADGES-1)
- **Receive pills page:** Per-bag Ready for floor badges on draft rows, post-save summary, and quick lookup — reuses `floor-readiness` helpers (no duplicated rules).
- **Admin labels:** Blocked / Warning / Ready for floor with human checklist lines (not internal codes).

### Tests (RAW-BAGS-READINESS-BADGES-1)
- `lib/production/floor-readiness.test.ts`, `app/(admin)/receiving/raw-bags/page.test.ts`.

## [0.4.82] — 2026-06-02

### Changed (SEALING-SEGMENT-UX-1)
- **Sealing floor workflow:** Three-step layout (save product → record segment → complete sealing) with clearer segment-vs-close-out copy.
- **Product lock:** Locked-product badge and blocked-work messaging before product save; complete sealing also gated until product is saved.
- **Segment form:** Labels presses/cards per press; explains partial progress vs final close-out.
- **No behavior change** to product persistence, accounting, roll/counter logic, or product reassignment.

### Tests (SEALING-SEGMENT-UX-1)
- `stage-action-buttons.test.ts`, `sealing-product.test.ts` — step layout and copy guards.

## [0.4.81] — 2026-06-02

### Fixed (TEST-STABILIZATION-1)
- **Floor action source guards:** Assert `refreshMaterialReadModelsAfterBlister` after pause roll segments instead of stale direct `rebuildRollUsage` in `actions.ts` (refactored in material-projection wiring).
- **Bug/UI backlog:** Live baseline updated to v0.4.80 @ `ce258c5`.

### Tests (TEST-STABILIZATION-1)
- `app/(floor)/floor/[token]/actions.test.ts` — guards match current roll/material projection path.
- `lib/projector/material-read-model-refresh.test.ts` — blister refresh contract includes `rebuildRollUsage`.

## [0.4.80] — 2026-06-02

### Changed (BUG-UI-FIX-BATCH-1)
- **Settings system panel:** Shows package release (`v0.4.x`) separately from git SHA; adds Shift review link under Workflow.
- **Inbound receive detail:** Floor QR column labels `BAG-*` placeholders honestly; column renamed for clarity.
- **Receive pills page:** Post-save note points admins to Inbound to confirm **Ready for floor** badges.
- **Workflow submissions:** Description mentions Shift review for post-shift counter checks.
- **Docs:** `docs/BUG_UI_BACKLOG.md` consolidates prioritized bug/UI work; LAUNCH_CONTROL and blister checklist baselines updated.

### Tests added (BUG-UI-FIX-BATCH-1)
- `lib/ui/format-bag-qr-display.test.ts`, settings page source guards.

## [0.4.79] — 2026-06-02

### Added (PRODUCTION-DATA-ENTRY-HARDENING-1)
- **Ready for floor validation:** Pure helpers evaluate inventory-bag and QR-card lineage (receipt, tablet, physical QR link, receive/PO context) before production start.
- **Receiving visibility:** Inbound receive detail shows per-bag floor-readiness badges with admin guidance.
- **Floor/admin blocks:** Fresh-bag floor scan and admin Start production refuse `BLOCKED` lineage with operator-safe copy — no guessing or override.
- **No migrations:** Readiness is computed from existing tables; product remains deferred to sealing (`saveSealingProductAction`).

### Tests added (PRODUCTION-DATA-ENTRY-HARDENING-1)
- `lib/production/floor-readiness.test.ts` plus source guards on floor scan and admin start paths.

## [0.4.78] — 2026-06-02

### Added (SHIFT-REVIEW-1)
- **Admin post-shift review:** `/shift-review` read-only page for blister counter segments, pause/end-shift snapshots, roll changes, and close-outs.
- **Conservative flags:** Missing shift-end snapshot, duplicate-looking segments, close-out matching prior pause, missing paired PVC/foil, missing lineage, finalized/finished-lot suspicious patterns.
- **Recovery guidance:** Links flagged findings to the read-only recovery dry-run harness — no apply path and no data mutation.

### Tests added (SHIFT-REVIEW-1)
- Shift review helper, flag detection, admin page source guards, auth smoke route.

## [0.4.77] — 2026-06-02

### Added (RECOVERY-DRY-RUN-HARNESS-1)
- **Read-only recovery CLI:** `scripts/material-change-recovery-dry-run.ts` loads real bag/station/roll context and runs `planMaterialChangeRecovery` without writing data.
- **Clear dry-run reporting:** Human and `--json` output include eligibility, blockers, warnings, before/after preview, proposed preview events (NOT PERSISTED), and affected read models.
- **Exit codes:** `0` for OK/WARNING preview, `2` for BLOCKED planner result, `1` for invalid input/runtime failure.
- **No apply path:** No admin UI, no server actions, no event writes, no read-model rebuilds.

### Tests added (RECOVERY-DRY-RUN-HARNESS-1)
- CLI parsing, exit-code, report, loader mapping, and mutation source guards.

## [0.4.76] — 2026-06-02

### Added (COUNTER-SNAPSHOT-GUARD-1)
- **Server-side counter snapshot guards:** Blocks obvious duplicate or impossible blister counter submissions before `ROLL_COUNTER_SEGMENT_RECORDED` rows are written.
- **Protected paths:** Pause machine-jam/shift-end snapshots, roll-change counter segments, and blister close-out on BLISTER/COMBINED stations.
- **Actionable floor errors:** Duplicate, invalid count, missing active roll, and close-out double-count cases return operator-facing messages without exposing internal IDs.
- **No accounting change for valid paths:** Valid pause, roll-change, partial/depleted swap, and blister close-out behavior is unchanged when counts pass validation.
- **No recovery apply:** This slice adds guards only — no admin repair UI or dry-run apply tooling.

### Tests added (COUNTER-SNAPSHOT-GUARD-1)
- Pure guard unit tests plus source guards on pause, roll-change, and blister close-out write paths.

## [0.4.75] — 2026-06-02

### Changed (PAUSE-ENDSHIFT-COPY-1)
- **Blister counter snapshot copy:** Pause, end-shift, roll change, and blister close-out UI now describe counts as good blisters/cards since the last physical machine counter reset — not lifetime machine totals.
- **Save-before-reset reminders:** Roll change and blister close-out forms include explicit guidance to save the snapshot before resetting the physical counter and to stop for a supervisor if the counter was reset too early.
- **Reason-aware pause errors:** Client and server validation for missing counter snapshots use machine-jam vs end-shift wording instead of always referencing a machine jam.
- **No accounting changes:** Event emission, `ROLL_COUNTER_SEGMENT_RECORDED` behavior, and roll-swap logic are unchanged in this slice.

### Tests added (PAUSE-ENDSHIFT-COPY-1)
- Copy and error-message source guards for pause, end-shift, roll change, and blister close-out helper text.

## [0.4.74] — 2026-06-02

### Added (SEALING-PRODUCT-PERSIST-1)
- **Explicit Save product at sealing:** Operators choose a finished SKU and tap **Save product** before recording sealing segments or close-out. Selection is no longer browser-only state.
- **Refresh-safe product lock:** Saved product persists on `workflow_bags.product_id`, survives page reload, and displays read-only with lock copy. Normal floor UI cannot casually change it.
- **Server-side sealing guards:** Segment and sealing complete actions require a saved product and re-read the bag row server-side instead of trusting client-only `productId`.
- **Read-model update:** `PRODUCT_MAPPED` now updates `read_bag_state` product columns immediately after save.

### Tests added (SEALING-PRODUCT-PERSIST-1)
- Floor action, UI, and projector source guards for save action, save-first gating, idempotent re-save, overwrite rejection, and segment without FormData productId.

## [0.4.73] — 2026-06-02

### Added (MATERIAL-CHANGE-RECOVERY-DRY-RUN-1)
- **Material-change recovery dry-run foundation:** Pure planning helpers and tests preview roll-change recovery events, blockers, warnings, before/after state, and read-model impact without querying or mutating production data.
- **Safety guardrails:** Dry-run planning blocks finalized/finished-lot boundaries, duplicate segment risk, ambiguous active rolls, missing requester/reason, and replacement-roll prior-count attribution.
- **No apply path:** This slice adds no admin UI, no confirm/apply action, no event writes, no roll-lot updates, and no read-model rebuilds.

## [0.4.72] — 2026-06-02

### Changed (HANDPACK-TABLET-CONTEXT-1)
- **Hand-pack tablet lineage:** Blister hand-pack now resolves tablet context from the scanned bag's received inventory lineage instead of normal-operator tablet selection.
- **Read-only floor context:** Linked hand-pack bags show the resolved tablet type and keep finished product selection deferred to sealing.
- **Honest missing-lineage block:** Bags missing received tablet context block hand-pack completion with receiving/admin repair copy instead of allowing guessed tablet selection.

## [0.4.71] — 2026-06-02

### Changed (DEPLOY-VERIFY-1)
- **Deploy drift guard:** `deploy/lxc/luma-deploy.sh` rebuilds when git HEAD changes, when `/api/health` or `/app/.git-sha` disagrees with checkout, or when the running SHA cannot be read; waits for health to confirm the new SHA after build.
- **`npm run verify:deploy`:** Exits non-zero on SHA mismatch or unhealthy `/api/health` (compares local HEAD to the **running** container, not disk checkout alone).
- **Auth smoke:** `/workflow-submissions` added to authenticated route coverage.

### Tests added (DEPLOY-VERIFY-1)
- Deploy SHA compare unit tests and source guards for deploy script, verify-deploy, and workflow-submissions smoke route.

## [0.4.70] — 2026-06-02

### Changed (WORKFLOW-SUBMISSIONS-DISPLAY-P1)
- **Workflow submissions traceability display:** `Receipt #` now shows canonical internal receipt numbers from linked inventory bags first, with the legacy workflow receipt as fallback.
- **Human-readable bag labels:** The `Bag` column now shows PO / tablet / bag context when available, with the internal workflow id kept as muted secondary debug text.
- **Honest missing-context fallback:** Legacy or unlinked workflow rows now say `Legacy bag …` instead of fabricating receipt, PO, tablet, or bag lineage.

## [0.4.69] — 2026-06-02

### Added (STATION-MGMT-1)
- **Machines & stations admin slice:** Edit machine/station display names, deactivate/reactivate (no hard delete), active vs inactive lists on `/machines`. Uses existing `is_active` columns — no migration.
- **Floor guard:** Inactive stations show a clear block message on `/floor/[token]` and reject new floor actions while preserving scan tokens and historical data. End shift / close session remains allowed so operators can exit cleanly.

### Tests added (STATION-MGMT-1)
- Station management helper and admin/floor wiring tests (access, edit-without-token-rotation, deactivate guards, no hard delete, inactive floor block).

### Changed (PARTIAL-ROLL-SWAP-LAUNCH-P1)
- **Mid-bag material changes now require old-roll status:** Operators choose whether the removed PVC/Foil roll is finished/depleted or removed with material remaining.
- **Partial roll removal:** Choosing “Removed with material remaining” records the same bag/roll counter segment, emits `ROLL_UNMOUNTED` instead of `ROLL_DEPLETED`, returns the old roll to `AVAILABLE`, and mounts the replacement roll without assigning it the prior count.

### Tests added (PARTIAL-ROLL-SWAP-LAUNCH-P1)
- Source/wiring tests cover old-roll status UI, server event branching, depleted-path compatibility, partial-removal payloads, and event ordering.

## [0.4.67] — 2026-06-01

### Added (ZOHO-PRODUCTION-OUTPUT-SLICE-C3A)
- **Mock commit state machine:** QUEUED ops can be claimed (`COMMITTING`), completed to `COMMITTED` or `FAILED`, and exercised via `mockCallZohoProductionOutputCommit` only. Includes `evaluateZohoProductionOutputProcessCommitEligibility`, audit events `commit_started` / `commit_succeeded` / `commit_failed`, and a test-only orchestrator. No real HTTP, no admin process button, no worker/pg-boss.

### Tests added (ZOHO-PRODUCTION-OUTPUT-SLICE-C3A)
- Processor eligibility, claim/complete/orchestrator, mock gateway, and guard tests (no live `/commit`, no `zoho_assembly_ops` writes).

## [0.4.66] — 2026-06-01

### Added (ZOHO-PRODUCTION-OUTPUT-SLICE-C2)
- **Queue-only gate:** OWNER/ADMIN can queue an APPROVED, commit-ready production-output op for a future worker (`APPROVED` → `QUEUED`) with `commit_requested_at`, `commit_requested_by_user_id`, and a deterministic `commit_idempotency_key`. No Zoho HTTP, no worker, no pg-boss/outbox enqueue, and no `/commit`/`/apply`/`/send` endpoints.
- **Finished-lot UI:** Ready approved ops show “Queue for future Zoho commit” with explicit no-write copy; queued ops show waiting-for-worker state and idempotency key. C1 readiness blockers still gate queueing.

### Tests added (ZOHO-PRODUCTION-OUTPUT-SLICE-C2)
- Queue eligibility/idempotency, query/gate-action, and wiring tests cover transactional readiness re-check, duplicate-queue rejection, audit `zoho_production_output_op.queue`, and absence of live-write/worker paths.

## [0.4.65] — 2026-06-01

### Added (ZOHO-PRODUCTION-OUTPUT-SLICE-C1)
- **Future commit readiness gate:** Approved Zoho production-output preview rows now expose read-only readiness blockers for a future live commit, including hash drift, non-HIGH metrics/genealogy, missing preview state, existing committed output, and legacy Zoho double-post risks.
- **Commit metadata foundation:** Added nullable commit metadata/status columns and uniqueness guards to `zoho_production_output_ops`. This slice does not add queueing, workers, `/commit`, `/apply`, `/send`, outbox enqueue, or live Zoho writes.
- **Finished-lot readiness UI:** Approved finished-lot preview cards show “Future commit readiness” with blocker explanations and no queue/commit button.

### Tests added (ZOHO-PRODUCTION-OUTPUT-SLICE-C1)
- Schema/query/wiring tests cover commit metadata shape, readiness evaluation, legacy `zoho_assembly_ops`/`zoho_pushes` blockers, no live endpoint references, and read-only UI states.

## [0.4.64] — 2026-06-01

### Added (BLISTER-PAUSE-COUNT-SNAPSHOT-1)
- **Machine-jam pause snapshots:** BLISTER and COMBINED machine-jam pauses now require a machine counter snapshot. Positive counts close a roll counter segment for active PVC/Foil rolls; zero is stored as an actual snapshot without emitting roll segments.
- **Shift-end counter guard:** Ending shift with an active BLISTER/COMBINED bag now routes through a shift-end counter snapshot before closing the operator session, leaving the bag paused for the next shift.

### Tests added (BLISTER-PAUSE-COUNT-SNAPSHOT-1)
- Source and helper tests cover BLISTER/COMBINED pause requirements, zero-count handling, shift-end guard wiring, roll segment payload metadata, and exclusions for SEALING/PACKAGING.

## [0.4.63] — 2026-05-27

### Added (ZOHO-PRODUCTION-OUTPUT-SLICE-B)
- **Approval / void gate:** Finished-lot Zoho production-output preview ops support `APPROVED` and `VOIDED` statuses with frozen `approved_request_hash`, required void reason, and audit log entries. Approval is blocked for DRAFT, missing preview, `metrics_state = MISSING`, `genealogy_state = MISSING` or `LOW`. Still preview-only — no commit/apply/send or live Zoho write.

### Tests added (ZOHO-PRODUCTION-OUTPUT-SLICE-B)
- `drizzle/0052_zoho_production_output_approval.sql` + schema/query/wiring/gate-action tests.

## [0.4.62] — 2026-05-27

### Added (RECEIVE-ADD-BAG-NOTES-1)
- **Add bag to existing receive:** Open receives show **Add bag** on the detail page. New bags attach to the same receive/box context (inherited PO, tablet, batch) with required add reason; closed receives are blocked with clear copy.
- **View bag notes without edit:** Long bag notes on the receive detail table expand in-place via **View**; empty notes stay clean.

### Tests added (RECEIVE-ADD-BAG-NOTES-1)
- `lib/receive/add-bag.test.ts` — validation, box resolution, bag numbering, summary helpers.
- `app/(admin)/inbound/[id]/page.test.ts` — add-bag wiring, closed-receive guard, notes cell, audit action.

## [0.4.61] — 2026-05-27

### Changed (ROLL-CHANGE-QA-SORT-COPY-1)
- **Natural roll dropdown order:** Mount and mid-bag change-roll pickers sort roll labels numerically (PVC-4 before PVC-23). Legacy-prefixed labels sort after standard numbered rolls.
- **Mid-bag change-roll copy:** Clarifies that the entered counter closes the segment for the removed roll, the other active roll, and the bag — not the replacement roll, which starts after the change.

### Tests added (ROLL-CHANGE-QA-SORT-COPY-1)
- `lib/production/roll-lot-sort.test.ts` — PVC/FOIL natural order, legacy labels, immutability.
- `lib/production/idle-roll-lots.test.ts` — role filter + natural sort integration for replacement dropdown.

## [0.4.60] — 2026-05-30

### Added (PACKAGING-RECONCILIATION-SLICE-A)
- **`MATERIAL_ESTIMATED_VOIDED` enum value:** Added to `materialEventTypeEnum` in schema and Drizzle migration `0050_material_estimated_voided.sql` (`ALTER TYPE ... ADD VALUE IF NOT EXISTS`). Required by Slice B to mark pending estimated consumption events as voided when a receipt is reconciled.
- **`planPendingConsumptionAttribution` helper:** Pure planning function in `lib/projector/packaging-lot-receipt-attribution.ts`. Takes pending estimated events + a received lot, returns an attribution plan (FIFO, material-scoped, quantity-capped, partial splits supported). No DB writes; foundation for Slice B.

### Tests added (PACKAGING-RECONCILIATION-SLICE-A)
- `lib/projector/packaging-lot-receipt-attribution.test.ts` — planner tests covering full attribution, partial attribution, cross-material isolation, FIFO ordering, deterministic tie-break, zero/negative guards, invalid event qty, empty inputs.

### Added (PACKAGING-RECONCILIATION-SLICE-B)
- **Receipt attribution wired for manual packaging receipts:** When a packaging material lot is received via the admin receive flow, any pending `MATERIAL_CONSUMED_ESTIMATED` events (null-lot, same material) are attributed to the new lot via FIFO greedy matching. Attribution emits append-only `MATERIAL_CONSUMED_ACTUAL` + `MATERIAL_ESTIMATED_VOIDED` pairs inside the receipt transaction. Partial attribution is supported — unattributed remainder stays pending for future receipts.
- **Idempotency guard:** Migration `0051_material_estimated_voided_idempotency.sql` adds a partial unique index preventing double-voiding the same estimated event on receipt retry.
- **Pending display updated:** `loadPendingConsumptionRows`, `loadPendingConsumptionByMaterial`, and `loadMaterialBalanceSummary` subtract prior `MATERIAL_ESTIMATED_VOIDED` quantities. Fully attributed events disappear from pending; partially attributed events show remaining pending qty.

### Tests added (PACKAGING-RECONCILIATION-SLICE-B)
- DB loader tests: row mapping, empty result, string-to-Date conversion for `occurred_at`
- Write helper tests: ACTUAL+VOIDED pair insertion, partial attribution multi-row, zero-pending no-op, zero-qty early exit, `onConflictDoNothing` called on all inserts
- PackTrack Slice-C TODO comment added to `lib/integrations/packtrack/receipts.ts`

## [0.4.59] — 2026-05-27

### Added (ROLL-MANAGEMENT-ACCESS-FOOTER-KG-1)
- **Admin roll management landing:** New `/roll-management` page under Inventory lists blister/combined stations with links to each station's floor roll page. Sidebar and Materials tabs include the shortcut.
- **Consistent version footer:** Floor station sub-pages (including roll management) share `LumaBuildFooter` via `app/(floor)/floor/[token]/layout.tsx`; admin pages continue using `AdminFooter`.

### Changed (ROLL-MANAGEMENT-ACCESS-FOOTER-KG-1)
- **Operator roll weights in kg:** Mount, weigh, unmount, and active-roll displays convert grams to kg for operators; backend storage remains grams.
- **Mount form role-first:** Select PVC or FOIL before the roll lot dropdown; lots filter by material kind with clear empty states.

### Tests added (ROLL-MANAGEMENT-ACCESS-FOOTER-KG-1)
- `idle-roll-lots.test.ts` — role-first PVC/FOIL filtering.
- `page.test.ts` — footer moved to station layout.
- `sidebar.test.ts` — roll management nav link.

## [0.4.58] — 2026-05-30

### Fixed (MULTI-SEALING-FINAL-CLOSE-UNSTICK-1)
- **Sealing segment no longer auto-releases the bag:** After `SEALING_SEGMENT_COMPLETE`, the bag stays pinned at the sealing station so **Sealing complete — all machines done** remains visible. Operators explicitly hand off to the next sealing machine via a new button when needed.
- **Idle sealing station surfaces bags awaiting lane-close:** When no bag is active, sealing stations show a banner and pickup labels for BLISTERED bags with segment(s) but no final close, so stuck bags (e.g. Bag Card 102) can be picked up to finalize.

### Tests added (MULTI-SEALING-FINAL-CLOSE-UNSTICK-1)
- `sealing-segments.test.ts` — `needsSealingLaneClose` helper.
- `actions.test.ts` — segment keeps pin; `releaseSealingHandoffAction` guards.
- `stage-action-buttons.test.ts` — handoff button wiring.

## [0.4.57] — 2026-05-30

### Added (ZOHO-PRODUCTION-OUTPUT-PREVIEW-FORM-1)
- **Finished-lot Zoho production-output preview:** Owner/Admin users can run a preview-only production-output request from a finished lot detail page using explicit Zoho PO, PO line, and warehouse inputs. The flow calls only the Zoho Integration Service preview endpoint and performs no live Zoho write.
- **Preview request/response summary:** The card shows the generated request summary, preflight/steps/warnings response details, HTTP status, request ID, and idempotency replay state without rendering bearer secrets.
- **Mapping blockers:** Missing PO, PO line, warehouse, or product composite item IDs return clear admin-facing blockers before any HTTP request when possible.

### Added (ZOHO-PRODUCTION-OUTPUT-SLICE-A)
- **Durable preview snapshots:** Added `zoho_production_output_ops` to store the active preview-only production-output mapping per finished lot, including request payload/hash, response snapshot, metrics confidence, genealogy confidence, PO/line/warehouse targets, and quantity basis.
- **Preview persistence:** Finished-lot Zoho preview now updates the active draft/preview row after preview calls. Successful previews become `PREVIEWED`; validation responses stay `DRAFT` and do not masquerade as successful previews.
- **Preview metadata in UI:** The finished-lot preview card shows stored snapshot status, last preview time, request hash, mapping summary, metrics state, and genealogy state while continuing to say “Preview only — no Zoho write performed.”

### Tests added (ZOHO-PRODUCTION-OUTPUT-PREVIEW-FORM-1 / SLICE-A)
- `lib/zoho/production-output-preview.test.ts` — payload mapping, idempotency key/hash, data-quality state classification, bearer headers, preview endpoint, no commit path, and 400/422 feedback handling.
- `lib/db/queries/zoho-production-output.test.ts` — migration/table shape, active-per-lot constraint, request hash changes, and missing metrics stored as nullable values rather than confirmed zero.
- `zoho-production-output-preview-actions.test.ts` — missing warehouse blocks before HTTP, successful preview persistence, service-validation draft persistence, and missing metrics/genealogy state handling.
- `zoho-production-output-preview-wiring.test.ts` — finished-lot page wiring, preview-only copy, persisted metadata rendering, no page-load call, no rendered secrets, and no approval/send/live-write controls.

## [0.4.56] — 2026-05-30

### Fixed (PACKAGING-CLIENT-EVENT-ID-TEXT-CAST-1)
- **Packaging close-out no longer fails with `text = uuid` on consumption summary patch:** `workflow_events.client_event_id` is `text`, but `patchPackagingCompleteConsumptionSummary` compared it with `::uuid`, causing Postgres `operator does not exist: text = uuid` on every floor packaging submit that sends a client event id.

### Tests added (PACKAGING-CLIENT-EVENT-ID-TEXT-CAST-1)
- `packaging-consumption-summary.test.ts` — patch SQL must not cast `client_event_id` to uuid.

## [0.4.55] — 2026-05-30

### Added (PACKAGING-RECONCILIATION-SLICE-A)
- **`MATERIAL_ESTIMATED_VOIDED` enum value:** Added to `materialEventTypeEnum` in schema and Drizzle migration (`ALTER TYPE ... ADD VALUE IF NOT EXISTS`). Required by Slice B to mark pending estimated consumption events as voided when a receipt is reconciled.
- **`planPendingConsumptionAttribution` helper:** Pure planning function in `lib/projector/packaging-lot-receipt-attribution.ts`. Takes pending estimated events + a received lot, returns an attribution plan (FIFO, material-scoped, quantity-capped, partial splits supported). No DB writes; foundation for Slice B.

### Tests added (PACKAGING-RECONCILIATION-SLICE-A)
- `lib/projector/packaging-lot-receipt-attribution.test.ts` — 10 tests covering full attribution, partial attribution, cross-material isolation, FIFO ordering, deterministic tie-break, zero/negative guards, invalid event qty, empty inputs.

## [0.4.54] — 2026-05-30

### Fixed (OPERATOR-PACKAGING-UUID-CLOSEOUT-1)
- **Packaging close-out no longer sends employee UUID as operator code:** Stale `sessionStorage` could restore a UUID into the optional operator-code field; that value was passed as `overrideEmployeeCode` and hit `employees.employee_code` comparison (`text = uuid`). UUID-shaped overrides now route as `employeeId` at the station-accountability boundary; the floor UI only persists/submits 1–4 digit badge codes.

### Tests added (OPERATOR-PACKAGING-UUID-CLOSEOUT-1)
- `accountability.test.ts` — UUID-shaped `employeeCode` resolves via ID lookup; unknown codes fail cleanly in strict mode.
- `station-operator-session.test.ts` — UUID override boundary documents `employeeId` routing.
- `actions.test.ts` — packaging complete wires `resolveStationAccountability` and does not embed code lookup.
- `stage-action-buttons.test.ts` — `operatorBadgeCodeForSubmit` guard and sessionStorage purge.

## [0.4.54] — 2026-05-30

### Added (ZOHO-PRODUCTION-OUTPUT-PREVIEW-FORM-1)
- **Finished-lot Zoho production-output preview:** Owner/Admin users can run a preview-only production-output request from a finished lot detail page using explicit Zoho PO, PO line, and warehouse inputs. The flow calls only the Zoho Integration Service preview endpoint and performs no live Zoho write.
- **Preview request/response summary:** The card shows the generated request summary, preflight/steps/warnings response details, HTTP status, request ID, and idempotency replay state without rendering bearer secrets.
- **Mapping blockers:** Missing PO, PO line, warehouse, or product composite item IDs return clear admin-facing blockers before any HTTP request when possible.

### Tests added (ZOHO-PRODUCTION-OUTPUT-PREVIEW-FORM-1)
- `lib/zoho/production-output-preview.test.ts` — payload mapping, idempotency key, bearer headers, preview endpoint, no commit path, and 400/422 feedback handling.
- `zoho-production-output-preview-actions.test.ts` — missing warehouse blocks before HTTP.
- `zoho-production-output-preview-wiring.test.ts` — finished-lot page wiring, preview-only copy, request summary, no page-load call, and no rendered secrets.


## [0.4.53] — 2026-05-29

### Fixed (OPERATOR-PICKER-UUID-SUBMIT-FIX-1)
- **UUID-shaped operator code no longer crashes packaging complete:** When a station operator session is opened via the employee picker (source `EMPLOYEE_PICKER`), the employee's UUID could reach `resolveAccountableEmployee` as the `employeeCode` argument. The postgres-js driver sends UUID-formatted strings with the `uuid` OID; comparing that against the `text` employee_code column raised "operator does not exist: text = uuid" in PostgreSQL. UUID-shaped values now route through `loadEmployeeById` (uuid = uuid) instead of `loadActiveEmployeeByCode` (text = uuid), eliminating the type mismatch. Non-UUID codes continue through the existing code-lookup path unchanged.

### Tests added (OPERATOR-PICKER-UUID-SUBMIT-FIX-1)
- `station-operator-session.test.ts` — 4 new tests: EMPLOYEE_PICKER session resolves correctly, typed 4-digit code resolves via code lookup, UUID override routes to ID lookup, UUID override gracefully falls through to session when no employee matches.

## [0.4.52] — 2026-05-27

### Added (MULTI-SEALING-SAME-BAG-1)
- **Per-machine sealing segments:** New `SEALING_SEGMENT_COMPLETE` event records each sealing station's counter output while the bag stays `BLISTERED`. Operators can pick up the same bag at multiple sealing machines before lane close.
- **Lane-close final seal:** Pure `SEALING` stations require at least one segment, then a counter-free `SEALING_COMPLETE` with `{ lane_close: true }` advances the bag to `SEALED`. Packaging close-out remains blocked until that final event.
- **Sealed card totals:** Card sealed output is derived from `SUM(SEALING_SEGMENT_COMPLETE.count_total)`; final `SEALING_COMPLETE` does not double-count cards. Daily `bags_sealed` throughput still increments only on final `SEALING_COMPLETE`.
- **Product mapping once:** First segment may map product; later segments are counter-only and reject conflicting product picks.

### Tests added (MULTI-SEALING-SAME-BAG-1)
- `lib/production/sealing-segments.test.ts` — stage prereq, progress fold, migration SQL.
- `actions.test.ts`, `stage-action-buttons.test.ts` — segment vs final wiring.

## [0.4.51] — 2026-05-29

### Verified + hardened (STATION-SEALING-TIMER-ROLLS-CLEANUP-1)
- **Scope A — Station timer anchor confirmed:** Floor page uses the most recent `BAG_PICKED_UP` event for the current station (filtered by `stationId`, ordered desc) as the elapsed timer anchor. Fallback to `bag.startedAt` for first-op stations preserved.
- **Scope B — Handpack boundary confirmed:** `HANDPACK_BLISTER_COMPLETE` is included in `stageBoundaries` in the projector, so handpacked bags compute `sealingSeconds` from handpack completion, not bag start.
- **Scope C — Sealing roll controls confirmed absent:** `FLOOR_ROLL_STATION_KINDS` excludes `SEALING`. `STATION_PAUSE_REASON_MATRIX.SEALING` excludes `pvc_swap`. All verified by existing tests.

### Tests hardened (STATION-SEALING-TIMER-ROLLS-CLEANUP-1)
- `page.test.ts` — Added explicit stationId filter assertion, desc-ordering assertion, and roll sub-page exclusion assertion for SEALING.

## [0.4.49] — 2026-05-29

### Added (ROLL-INTAKE-AUTO-NUMBER-INTEGRATION-1)
- **Automatic roll numbering on receive:** Roll intake rows ask for net weight kg only. Roll numbers are assigned inside `receiveRollsBatchAction` from material kind, receipt type, and PO/reference (`FOIL-221-001`, `Legacy PVC-002`, etc.).
- **Collision-safe sequencing:** New batches continue from the highest existing sequence in the same roll-number group (prefix + reference for normal receipts; `Legacy FOIL-` / `Legacy PVC-` for opening balance).

### Tests added (ROLL-INTAKE-AUTO-NUMBER-INTEGRATION-1)
- `lib/inbound/roll-number-generator.test.ts` — formats, 58-roll batch, collision continuation, legacy isolation.
- `lib/inbound/roll-receive-batch.test.ts` — weight-only client payload validation.
- `roll-kg-input.test.ts` — no per-row roll number inputs; server-side assignment wiring.

## [0.4.48] — 2026-05-27

### Fixed (ROLL-INTAKE-BULK-COUNT-LIMIT-1)
- **Larger roll receipt batches:** Raised per-receipt roll count cap from 50 to 250 so normal PVC/foil shipments (e.g. 58 rolls) are not blocked. Client parser, row resize, and server `rollsJson` validation share `ROLL_COUNT_MAX`.

### Tests added (ROLL-INTAKE-BULK-COUNT-LIMIT-1)
- `lib/inbound/roll-receive-input.test.ts` — 50/58/250 valid, 251 rejected, row resize cap.
- `lib/inbound/roll-receive-batch.test.ts` — server rejects >250 rolls in batch JSON.

## [0.4.47] — 2026-05-27

### Changed (PACKAGING-PENDING-CONSUMPTION-HONESTY-1)
- **Honest pending/negative packaging inventory:** Count-based lot balances in `read_material_lot_state` no longer clamp to zero — production consumption before receipt shows as negative net balance.
- **Split consumption on insufficient on-hand:** `PACKAGING_COMPLETE` writes `MATERIAL_CONSUMED_ACTUAL` up to available lot qty and `MATERIAL_CONSUMED_ESTIMATED` for the remainder (payload flags `insufficient_on_hand`, `observed_qty_on_hand`).
- **Read-model refresh on close-out:** Packaging close-out rebuilds `read_material_lot_state` and `read_material_consumption_daily`; consumption summary persisted additively on `PACKAGING_COMPLETE` payload (`packaging_consumption_summary`).
- **Hand-pack seal pending ledger:** When no blister-card lot is available, `SEALING_COMPLETE` still succeeds and emits `MATERIAL_CONSUMED_ESTIMATED` (existing skip audit flags preserved).
- **Admin visibility:** `/packaging-inventory` shows on-hand, pending consumption, and net balance per material; `/packaging-output` labels estimated-only burn as “Estimated · Needs receipt”.

### Tests added (PACKAGING-PENDING-CONSUMPTION-HONESTY-1)
- `lib/projector/packaging-consumption-hook.test.ts` — split logic + wiring.
- `lib/production/pending-consumption.test.ts` — label + query source.
- `lib/production/packaging-consumption-summary.test.ts` — payload summary + lot-state honesty.
- `app/(admin)/packaging-inventory/pending-consumption-ui.test.ts` — admin UI + action wiring.

## [0.4.46] — 2026-05-29

### Fixed (ROLL-INTAKE-NUMBER-INPUT-FIX-1)
- **Roll intake numeric fields no longer mutate on scroll:** Replaced `type="number"` with text inputs using `inputMode="numeric"` / `inputMode="decimal"` for roll count, net kg rows, and advanced weight/dimension fields — eliminates browser wheel increment/decrement while focused.
- **Roll count editable normally:** Count is held as string text defaulting to `"1"`; users can clear/backspace and type `8` without forced `|| 1` coercion or “18 then delete 1” behavior. Rows sync on blur/submit after validation.
- **Inline validation:** Empty/invalid roll count shows a clear message and blocks submit; decimal kg values like 5.2, 8.75, 0.35 parse on submit before server action.

### Tests added (ROLL-INTAKE-NUMBER-INPUT-FIX-1)
- `lib/inbound/roll-receive-input.test.ts` — roll count and decimal kg parsing, row resize.
- `roll-kg-input.test.ts` — form uses text numeric inputs, no `type="number"`.

### Fixed (ROLL-INTAKE-NUMBER-INPUT-POLISH-1)
- Scroll-safe numeric inputs: all number fields on the roll form use `type="text"` + `inputMode` — wheel-scroll no longer mutates values.
- Editable roll count: field is a controlled text input; operators can select-all and type directly. Row grid updates on blur or submit only.
- PO / reference is now required (schema `min(1)`); UI field marked required.
- Default receipt type changed to "Normal receipt".

## [0.4.45] — 2026-05-27

### Changed (ROLL-INTAKE-UX-LEGACY-1)
- **Simplified roll receive tab:** `/inbound/packaging-materials?tab=roll` now focuses on material, receipt type (normal vs legacy opening balance), PO/reference, roll count, and per-roll number + net kg. Width, thickness, supplier, gross/tare/core, and similar fields moved to a collapsed “Advanced details” section.
- **Multi-roll batch receive:** One submit creates N `packaging_lots` (e.g. 8 legacy foil rolls). Duplicate roll numbers within the batch or in inventory are rejected with clear errors.
- **Already-mounted legacy roll:** When receiving exactly one roll, admin can mark it already mounted on a blister station; Luma records `ROLL_MOUNTED` and sets status `IN_USE` using existing material inventory events (no schema migration).
- **Spent roll / core weight UX:** Floor unmount form now accepts spent roll / core weight in kg (`endingWeightKg` → grams server-side) with clearer operator copy.
- **Idle roll dropdown filter:** Shared `filterSelectableIdleRollLots` helper — only `AVAILABLE` PVC/foil lots appear in mount / change-roll pickers; `DEPLETED`, `SCRAPPED`, and `IN_USE` are excluded.

### Tests added (ROLL-INTAKE-UX-LEGACY-1)
- `lib/inbound/roll-receive-batch.test.ts` — batch validation, JSON parse, role mapping.
- `lib/production/idle-roll-lots.test.ts` — AVAILABLE vs DEPLETED/SCRAPPED/IN_USE filtering.
- `roll-kg-input.test.ts` — updated for new form, batch action, spent-weight kg labels.

## [0.4.44] — 2026-05-29

### Fixed (HANDPACK-TABLET-TYPE-SOURCE-1)
- **HANDPACK_BLISTER tablet type selection at completion:** Before submitting "Hand-pack complete", the operator now selects which tablet type they packed from a required dropdown. Selection is stored in the `HANDPACK_BLISTER_COMPLETE` event payload (`tablet_type_id`). No schema migration needed — `workflow_events.payload` is jsonb.
- **Sealing product filter resolves tablet type from hand-pack event:** `resolveWorkflowBagTabletTypeId` now has a third fallback path: `HANDPACK_BLISTER_COMPLETE` payload → `tablet_type_id`. This means the sealing dropdown automatically filters to compatible products for HANDPACK_BLISTER bags when the operator provided a type.
- **Unknown tablet type still shows warning:** Legacy bags and any HANDPACK_BLISTER bags where operator did not select type continue to show all products with the existing "Tablet type is unknown" hint.
- **Product selection unchanged:** `PRODUCT_MAPPED` with `source: SEALING_SELECTION` still fires at `SEALING_COMPLETE`. Hand-pack completion sets only tablet type, never the finished SKU.
- **scan-card-form.tsx not modified:** Tablet type capture happens at `HANDPACK_BLISTER_COMPLETE`, not at QR scan start — no changes to the scan form or stage progression.

### Tests added (HANDPACK-TABLET-TYPE-SOURCE-1)
- `workflow-bag-tablet-context.test.ts` — Path 3 fallback via HANDPACK_BLISTER_COMPLETE, hint text update.
- `actions.test.ts` — `tabletTypeId` in `eventSchema`, `fireStageEventAction` reads and writes tablet type in payload, product selection stays at sealing.
- `page.test.ts` — tablet types loaded for HANDPACK_BLISTER stations, passed to StageActionButtons, empty for other station kinds.
- `stage-action-buttons.test.ts` — `handpackTabletTypeOptions` prop, tablet type selector shown, completion gate, `fire()` includes `tabletTypeId` for HANDPACK_BLISTER_COMPLETE.

## [0.4.43] — 2026-05-27

### Fixed (HANDPACK-TABLET-TYPE-LINKAGE-1)
- **Floor handpack start links inventory bag:** `scanCardAction` now sets `workflow_bags.inventory_bag_id` from the received inventory bag linked to the bag QR (`inventory_bags.bag_qr_code = qr_cards.scan_token`), matching admin start production.
- **Sealing tablet type fallback:** When `inventory_bag_id` is null on legacy bags, sealing product filter and `PRODUCT_MAPPED` validation resolve tablet type via `CARD_ASSIGNED` → QR card → inventory bag join.
- **Unknown tablet type UX:** Sealing inline product picker shows an explicit message when the list is unfiltered because tablet type could not be resolved.

### Tests added (HANDPACK-TABLET-TYPE-LINKAGE-1)
- `workflow-bag-tablet-context.test.ts` — unfiltered hint copy.
- `actions.test.ts` — scan start inventory linkage + shared tablet resolver at sealing.
- `page.test.ts` — sealing options use `resolveWorkflowBagTabletTypeId`.
- `stage-action-buttons.test.ts` — filter hint prop wiring.

## [0.4.42] — 2026-05-29

### Changed (ROLL-WEIGHT-KG-INPUT-1)
- **Roll receive form now accepts kilograms:** All weight fields (gross, tare, net, core) accept decimal kg values (e.g. 12.4, 8.75, 0.35). The weight-unit selector has been removed — input is always kg.
- **kg → grams conversion at server boundary:** `receiveRollAction` converts entered kg to integer grams via `kgToGrams` before storing. DB columns (`gross_weight_grams`, `tare_weight_grams`, `net_weight_grams`, `core_weight_grams`) are unchanged. `weight_unit` stored as `"kg"` on all new rolls.
- **Admin displays converted to kg:** Recent receipts table ("Net (kg)"), packaging inventory weight column, and material-alerts runout weight column now show `X kg` instead of raw gram integers.
- **Help text updated:** Form footer explains decimal kg input and internal grams storage.

### Tests added (ROLL-WEIGHT-KG-INPUT-1)
- `lib/inbound/roll-weight.test.ts` — 12 tests for `kgToGrams` and `formatGramsAsKg` (conversions, decimals, null handling, roundtrip).
- `app/(admin)/inbound/packaging-materials/roll-kg-input.test.ts` — 19 source-scan tests verifying form labels, field names, action wiring, and display column.

## [0.4.41] — 2026-05-27

### Fixed (PRODUCT-AT-SEALING-UI-FIX-1)
- **Sealing station unmapped bags:** Station-aware amber banner replaces the misleading “started before the first-op product picker” copy at SEALING/COMBINED. Unmapped bags now read “Select finished product before sealing close-out.”
- **Inline product picker at sealing:** Product dropdown (tablet-type filtered) appears on the main stage panel before Sealing complete; the stage button stays disabled until a SKU is chosen.
- **Tablet type lookup:** Sealing product options and `PRODUCT_MAPPED` validation resolve tablet type via `workflow_bags.inventory_bag_id`, not bag-card QR join.

### Tests added (PRODUCT-AT-SEALING-UI-FIX-1)
- `sealing-product.test.ts` — `getUnmappedProductBanner` per station kind.
- `page.test.ts` — station-aware banner + inventory_bag_id join.
- `stage-action-buttons.test.ts` — inline picker + disabled sealing button.
- `actions.test.ts` — inventory_bag_id join for sealing product pick.

## [0.4.40] — 2026-05-29

### Added (ZOHO-FINISHED-GOODS-OUTBOX-1)
- **Auto-enqueue on lot issue:** `createFinishedLot` now persists planned `zoho_assembly_ops` rows after the lot transaction commits, using the existing planner + enqueue service. No Zoho HTTP calls; lot creation still succeeds if enqueue fails.
- **Allocation session backfill:** Closed/depleted `raw_bag_allocation_sessions` for the workflow bag get `finished_lot_id` set at lot creation when still null.
- **Planner ledger fallback:** Assembly planner resolves allocation sessions via `finished_lots.workflow_bag_id` when no rows are linked by `finished_lot_id`.

### Tests added (ZOHO-FINISHED-GOODS-OUTBOX-1)
- `enqueue-after-lot-create.test.ts` — success, idempotent re-enqueue, skipped plan, failure audit, no HTTP.
- `assembly-planner-ledger.test.ts` — workflow_bag_id fallback when lot-scoped ledger is empty.
- `finished-lots-zoho-outbox.test.ts` — createFinishedLot calls enqueue post-commit and does not fail the lot on enqueue errors.

## [0.4.39] — 2026-05-29

### Fixed (DASHBOARD-PREDICTION-DATE-COPY-1)
- **Owner dashboard prediction copy:** The blue prediction panel no longer says “tomorrow … by Friday” when today is already Friday (or when tomorrow is the weekly target). Copy is calendar-aware in Eastern time.
- **Plain operational wording:** Replaced cute “push tomorrow morning’s first hour” phrasing with concise pace + weekly-window guidance.
- **Weak-data honesty:** When the 7-day finalize average is zero, the card states that prediction is directional only instead of inventing bag counts.
- **ET weekday alignment:** Weekly business-day remaining math now uses `America/New_York` (matching finalized-day SQL buckets), not server-local `Date.getDay()`.

### Tests added (DASHBOARD-PREDICTION-DATE-COPY-1)
- `prediction-copy.test.ts` — Friday, Tuesday, Thursday, weekend, no-data, and on-pace cases.
- `loaders.test.ts` — ET weekday helpers; page no longer embeds broken copy.

## [0.4.38] — 2026-05-29

### Fixed (BLISTER-AUTO-RELEASE-1)
- **Blister close-out auto-releases:** `BLISTER_COMPLETE` on `BLISTER` stations now appends `BAG_RELEASED` in the same transaction when the bag reaches `BLISTERED` and is still pinned — matching HANDPACK_BLISTER and SEALING. Operators no longer need a second **Release to sealing queue** tap after machine-counter close-out.
- **COMBINED unchanged:** Auto-release only fires when `station.kind === "BLISTER"`, not on COMBINED stations.
- **Legacy fallback preserved:** Manual release remains available on BLISTER for bags already at `BLISTERED` from before this change.

### Tests added (BLISTER-AUTO-RELEASE-1)
- `actions.test.ts` — BLISTER auto-release chain, COMBINED exclusion, idempotent guards, `count_total` payload.
- `stage-action-buttons.test.ts` — manual release fallback for legacy BLISTERED bags; HANDPACK/SEALING unchanged.

## [0.4.37] — 2026-05-29

### Fixed (OPERATOR-SHIFT-SUBMIT-BLOCK-1)
- **Employee picker opens stable sessions:** Selecting an employee from the floor shift dropdown now sends `employeeId` to `openOperatorSessionAction`, storing a non-null `station_operator_sessions.employee_id` even when `employee_code` is empty.
- **UI honesty for low-confidence sessions:** Active sessions with null `employee_id` show an amber **Low-confidence shift** banner explaining that blister/bottle hand-pack first counts stay blocked until a real employee is selected.
- **First-op stations block free-text-only shift open:** BLISTER, COMBINED, and BOTTLE_HANDPACK refuse opening a shift with free-text name alone. Pick from the list or enter a valid operator code.
- **Accountability policy unchanged:** `BLISTER_COMPLETE` / `BOTTLE_HANDPACK_COMPLETE` still require stable `accountableEmployeeId`; LEGACY_TEXT sessions do not satisfy the guard.

### Tests added (OPERATOR-SHIFT-SUBMIT-BLOCK-1)
- `operator-session-actions.test.ts` — picker `employeeId` insert; free-text blocked on BLISTER.
- `operator-session-form.test.ts` (inline) — UI wiring and warning copy.
- `station-operator-session.test.ts` — `sessionSatisfiesFirstOpCount`, legacy session null id.
- `actions.test.ts` — first-op guard unchanged.

## [0.4.36] — 2026-05-29

### Added (ROLL-CHANGE-WORKFLOW-1)
- **Inline roll-change card on pause:** When a BLISTER or COMBINED bag is paused with the **PVC roll swap** or **Foil roll swap** reason, the floor action area now shows a contextual `RollChangeCard` prompting the operator to record the roll change immediately. Fields: machine counter when roll stopped (required), new roll number (required), new starting weight (optional). Calls the existing `changeRollAction` unchanged. On success, shows a green confirmation; Resume bag is never blocked.
- Station-kind guard: card only renders for `BLISTER` and `COMBINED`. SEALING, HANDPACK_BLISTER, and all other station kinds are unaffected.
- `rollChangeRole?: "PVC" | "FOIL" | null` prop added to `StageActionButtons`. Page.tsx passes `requiredRollChangeRole` (derived from the last `BAG_PAUSED` event payload).

### Tests added (ROLL-CHANGE-WORKFLOW-1)
- `stage-action-buttons.test.ts` — `ROLL-CHANGE-WORKFLOW-1` describe block: import of `changeRollAction`, prop type, render gate (isPaused + non-null role + BLISTER/COMBINED), form field submission (counterSegmentCount, newRollNumber, role), done state, resume not gated, blister form unchanged, scan-card-form not touched.

## [0.4.35] — 2026-05-27

### Changed (MATERIAL-ROLL-CHANGE-1)
- **Roll change on main station page:** BLISTER and COMBINED stations now show a **Machine rolls** panel with PVC/Foil mounted status and primary **Change PVC roll** / **Change Foil roll** actions. Mid-bag changes reuse existing `changeRollAction` via `ChangeRollForm` (same backend as `/floor/{token}/rolls`). This path does not require pausing and works whenever a roll is mounted and replacement inventory is available.
- **PVC/Foil pause reasons retained as a trigger path:** Pausing with "PVC roll swap" or "Foil roll swap" remains available on BLISTER and COMBINED stations. These pause reasons serve as the entry point for the inline `RollChangeCard` workflow added in v0.4.36 — removing them at this stage would break that path. Pause options for BLISTER/COMBINED: Shift ending, PVC roll swap, Foil roll swap, Machine jam, QA check, Other. SEALING, HANDPACK_BLISTER, and hand-work stations have no roll-swap options.

### Tests added (MATERIAL-ROLL-CHANGE-1)
- `station-pause-reasons.test.ts` — BLISTER/COMBINED include pvc_swap/foil_swap; SEALING/HANDPACK_BLISTER/PACKAGING/bottle stations exclude them; default pause is shift_end.
- `page.test.ts` — StationRollPanel wiring, active roll props, Change PVC/Foil buttons.

## [0.4.34] — 2026-05-28

### Changed (BLISTER-MACHINE-COUNTER-1)
- **Foil roll swap pause reason:** BLISTER and COMBINED stations now include "Foil roll swap" in the pause dropdown alongside "PVC roll swap." SEALING, HANDPACK_BLISTER, PACKAGING, and bottle/cap/sticker stations are unchanged. Server `pauseSchema` updated to accept `foil_swap` so the submit does not fail.
- **Blister close-out — machine counter only:** The BLISTER close-out form now shows a single "Machine counter" numeric field. "Blister count" and "Packs remaining" fields are removed. The machine counter value is submitted as `countTotal` (same server path as before). Derived production numbers (tablets used, cards made) are deferred to a future settings-driven derivation system.
- **HANDPACK_BLISTER unchanged:** Remains timed-only; no counter field.
- **SEALING counter unchanged:** Counter presses / cards-per-press logic unaffected.
- **PACKAGING close-out unchanged:** All packaging fields and payload keys unaffected.

### Follow-up (not in this branch)
- Admin/workflow display: BLISTER stage still labelled "Blistered" in reporting. Count stored as `count_total` in the BLISTER_COMPLETE event payload. No admin reporting overhaul in this branch.
- Derivation system: machine counter → tablets used / cards blistered is a future slice once product and machine settings are wired.

### Tests added (BLISTER-MACHINE-COUNTER-1)
- `station-pause-reasons.test.ts` — BLISTER/COMBINED include foil_swap; SEALING/HANDPACK_BLISTER/PACKAGING/BOTTLE_HANDPACK exclude it.
- `stage-action-buttons.test.ts` — Machine counter renders; blister count and packs remaining absent; countTotal payload present; packsRemaining not submitted; HANDPACK_BLISTER timed-only; sealing/packaging unchanged.
- `actions.test.ts` — pauseSchema enum includes foil_swap and pvc_swap; other reasons preserved.

## [0.4.33] — 2026-05-28

### Changed (PRODUCT-SELECTION-AT-SEALING-1)
- **Card/blister start without SKU:** BLISTER and HANDPACK_BLISTER stations no longer require the finished product picker at bag start. Operators scan/start with product deferred; the bag shows the existing amber “No product set” state until sealing maps the SKU.
- **Product at sealing:** SEALING (and COMBINED sealing close-out) requires choosing a finished product when `workflow_bags.product_id` is still null. Selection is filtered by the raw bag’s tablet type. Mapping writes `PRODUCT_MAPPED` with `source: SEALING_SELECTION` in the same transaction as `SEALING_COMPLETE`.
- **Packaging gate:** Packaging close-out is hidden with a clear message when the bag has no mapped product. Server-side packaging prereqs unchanged.
- **Bottle handpack unchanged:** BOTTLE_HANDPACK still requires product selection at start.

### Tests added (PRODUCT-SELECTION-AT-SEALING-1)
- `first-op-product.test.ts`, `sealing-product.test.ts`, `actions.test.ts`, `stage-action-buttons.test.ts`, `page.test.ts` — product-at-start split, sealing mapping order, handpack lot lookup after map, packaging gate, scan-card-form untouched.

## [0.4.32] — 2026-05-28

### Fixed (PACKAGING-BOM-FOOTER-1)
- **Packaging close-out static material footer:** Footer now only appears after the operator enters at least one count > 0 (master cases, displays, loose cards, rework, or ripped). Previously showed unconditionally whenever BOM specs existed, which was confusing before the operator typed anything.

## [0.4.31] — 2026-05-28

### Fixed (DASHBOARD-FINALIZED-TABLETS-1)
- **Dashboard finalized today:** Counts finalized bags from `workflow_bags.finalized_at` bucketed in `America/New_York` instead of `read_daily_throughput.bags_finalized` (which skips events when the firing station has no `machine_id`, e.g. packaging).
- **Top flavors tablet totals:** Sums `read_bag_metrics.units_yielded` instead of `inventory_bags.pill_count`, so floor workflow bags without a linked raw inventory bag show correct yielded tablets.
- **Predicted this week:** Uses the same finalized-bag source for consistency.

### Tests added (DASHBOARD-FINALIZED-TABLETS-1)
- `app/(admin)/dashboard/loaders.test.ts` — source-table contracts, ET day bucketing, bag/tablet consistency.

## [0.4.30] — 2026-05-28

### Fixed (WORKFLOW-DATA-VISIBILITY-1)
- **Workflows page filter crash:** Mark `Input` as a Client Component so its internal `onWheel` handler is valid when used from the server-rendered `/workflow-submissions` filter form (digest `1045651454`).

## [0.4.29] — 2026-05-27

### Fixed (WORKFLOW-DATA-VISIBILITY-1)
- **Workflows page crash:** `/workflow-submissions` no longer throws when rendering bags — dates are serialized to ISO strings at the RSC boundary and client formatters accept `Date | string`. Postgres `count()` coerced to number for event counts.

### Tests added (WORKFLOW-DATA-VISIBILITY-1)
- `workflow-table-helpers.test.ts`, `page.test.ts` — RSC date serialization, Bag 117-style finalized row, optional payload fields, empty timestamps, SQL count coercion.

## [0.4.28] — 2026-05-28

### Changed (PACKAGING-AUTO-FINALIZE-1)
- **Packaging auto-finalize:** PACKAGING stations now auto-finalize in the same transaction as `PACKAGING_COMPLETE`. Operators no longer need a second "Finalize bag" tap after packaging close-out.
- **Shared helper:** Extracted `projectBagFinalizedEvent` for manual finalize and auto-finalize (reuses existing `BAG_FINALIZED` projector path: metrics snapshot, QR release, station unpin).
- **Legacy fallback:** Manual Finalize button remains for bags already at `PACKAGED` but not finalized (e.g. pre-deploy close-outs).

### Tests added (PACKAGING-AUTO-FINALIZE-1)
- `actions.test.ts`, `stage-action-buttons.test.ts` — auto-finalize on PACKAGING only, COMBINED excluded, idempotent clientEventId, manual finalize fallback, sealing/blister unchanged.

## [0.4.27] — 2026-05-28

### Changed (PACKAGING-CLOSEOUT-UX-1)
- **Packaging close-out scroll-safe:** All packaging close-out number inputs (master cases, displays, loose cards, rework, ripped) blur on wheel/trackpad scroll so focused values are not accidentally changed on tablets.
- **Clearer rework/scrap labels:** "Damaged (return to sealing)" → "Needs rework / return to sealing"; "Ripped (scrap)" → "Ripped / unusable". Form payload field names unchanged.

### Tests added (PACKAGING-CLOSEOUT-UX-1)
- `stage-action-buttons.test.ts` — packaging scrollSafe on all NumFields, new labels, old labels absent, sealing counter and blister close-out unchanged.

## [0.4.26] — 2026-05-28

### Changed (SEALING-AUTO-RELEASE-1)
- **Sealing auto-release:** SEALING stations now auto-release to the packaging queue in the same action as `SEALING_COMPLETE`. Operators no longer need a second "Release to packaging queue" tap after sealing.
- **Shared helper:** Generalized hand-pack `maybeAutoReleaseAfterComplete` to also cover `SEALING` (reuses `projectBagReleasedEvent`; idempotent when station already unpinned).

### Tests added (SEALING-AUTO-RELEASE-1)
- `stage-action-buttons.test.ts`, `actions.test.ts` — sealing auto-release, BLISTER manual release unchanged, hand-pack path preserved.

## [0.4.25] — 2026-05-28

### Fixed (SEALING-MATERIAL-NONBLOCKING-1)
- **Sealing completion never blocked by blister-card stock:** `SEALING_COMPLETE` no longer fails with "No available pre-made blister lot found." Missing or unmatched lots skip material issuance and still record the machine counter.
- **Product-matched lot only:** Hand-pack seal material issuance now selects the oldest AVAILABLE lot from the bag product's BOM `BLISTER_CARD` spec only — never a global oldest lot that could decrement the wrong SKU.
- **Skip audit on event:** When material is skipped, `SEALING_COMPLETE` payload records `handpack_blister_material_skipped` and `handpack_blister_material_skip_reason` for downstream review.
- **Counter presses scroll-safe:** Counter presses input blurs on wheel/trackpad scroll so focused values are not accidentally changed.

### Tests added (SEALING-MATERIAL-NONBLOCKING-1)
- `handpack-seal-material.test.ts` — product BOM lookup, non-blocking skip, no global lot.
- `actions.test.ts` — no blocking error, skip audit fields.
- `stage-action-buttons.test.ts` (via handpack test) — scrollSafe on counter input.

## [0.4.24] — 2026-05-28

### Changed (SEALING-COUNTER-UI-2)
- **Sealing close-out simplified:** SEALING station completion now asks only for machine counter presses. Removed "Packs remaining" and "Cards reopened (scrap)" from the floor form — those quantities are not part of the blister-card sealing process.
- **Payload trimmed:** Floor SEALING UI no longer submits `packsRemaining` or `cardsReopened`. Server still records `counter_presses`, `cards_per_press`, and derived `count_total`.
- **Hand-pack material issuance unchanged:** Bags with `HANDPACK_BLISTER_COMPLETE` still issue `BLISTER_CARD` material at sealing using `count_total`.

### Tests added (SEALING-COUNTER-UI-2)
- `stage-action-buttons.test.ts` — SEALING-COUNTER-UI-2 group: counter-only form, no packs/scrap fields, payload guards.

## [0.4.23] — 2026-05-28

### Changed (SEALING-FLOW-CLARITY-2)
- **Unified sealing completion UI:** All SEALING stations now use the machine counter form (Counter presses × cards per press) regardless of upstream hand-pack vs machine blister source. Removed the separate `SealHandpackForm` / plastic blister count path.
- **Hand-pack material issuance preserved:** Bags with `HANDPACK_BLISTER_COMPLETE` in history still emit `PACKAGING_MATERIAL_ISSUED` for `BLISTER_CARD` lots at sealing, using derived `count_total` as the quantity basis.

### Removed (SEALING-FLOW-CLARITY-2)
- `seal-handpack-form.tsx` and `sealHandpackBagAction` — replaced by unified `fireStageEventAction` path.

### Tests added (SEALING-FLOW-CLARITY-2)
- `handpack-seal-material.test.ts` — material helper and unified UI structural guards.
- Updated `actions.test.ts`, `stage-action-buttons.test.ts`.

## [0.4.22] — 2026-05-28

### Fixed (STATION-TIMER-2)
- **Station-scoped elapsed timer:** Downstream stations (SEALING, PACKAGING) now anchor the elapsed timer to the `BAG_PICKED_UP` event for that station, not `workflow_bags.started_at`. Fixes total-bag-age showing instead of time-at-station for overlap pickups.
- **Station-scoped pause math:** Paused seconds are recomputed from `BAG_PAUSED`/`BAG_RESUMED` events after the pickup timestamp. Prevents bag-global `pausedSecondsAccum` (which includes prior-station pauses) from producing negative elapsed at downstream stations.
- **Picked up label:** Active bag header now shows "Picked up HH:MM AM/ET" instead of "Started …" for downstream stations that entered via overlap pickup.
- **Projector: HANDPACK_BLISTER_COMPLETE stage boundary:** Added `HANDPACK_BLISTER_COMPLETE` to the `stageBoundaries` filter in `lib/projector/index.ts`. Previously omitted, which caused `sealingSeconds` for hand-packed bags to measure total bag age rather than time spent at the sealing stage.

### Tests added (STATION-TIMER-2)
- `page.test.ts` — STATION-TIMER-2 group: pickup query, FIRST_OP gate, station-scoped pause math, Picked up label, ElapsedTimer prop, first-op fallback.
- `page.test.ts` — projector HANDPACK_BLISTER_COMPLETE boundary assertion.

## [0.4.21] — 2026-05-28

### Changed (SEALING-COUNTER-1)
- **Sealing completion:** Floor sealing close-out now asks for **machine counter presses** instead of manual blisters sealed. Sealed card count is computed server-side as `counter presses × cards per press` from the bound machine's `cardsPerTurn` config.
- **Config guard:** Sealing stations without a bound machine or valid cards-per-press show a clear error and block completion until configured in **Machines & stations**.
- **Admin:** Machines page supports inline edit of cards per press; create form copy clarifies sealing machine requirement.

### Tests added (SEALING-COUNTER-1)
- `sealing-counter.test.ts` — multiplier math and config resolution.
- `stage-action-buttons.test.ts` — counter UI, config block, no scan-form changes.
- `actions.test.ts` — server-side counter path and hand-pack path preserved.
- `machines/actions.test.ts` — admin validation.

## [0.4.20] — 2026-05-28

### Changed (STATION-SEALING-TOOLS-1)
- **SEALING pause reasons:** Removed PVC roll swap from sealing stations; options are Shift ending, Machine jam, QA check, Other with default **Shift ending**. Blister and Combined keep PVC roll swap.
- **SEALING supervisor tools:** Removed Rolls link from sealing stations. Rolls remains on BLISTER and COMBINED only.

### Tests added (STATION-SEALING-TOOLS-1)
- `station-pause-reasons.test.ts` — SEALING matrix, default shift_end, BLISTER/COMBINED unchanged.
- `floor-station-mobile-nav.test.ts` — SEALING has no Rolls; roll kinds exclude sealing.

## [0.4.19] — 2026-05-28

### Changed (STATION-HANDPACK-AUTO-RELEASE-1)
- **Hand-pack auto-release:** `HANDPACK_BLISTER_COMPLETE` now chains `BAG_RELEASED` in the same server transaction via shared `projectBagReleasedEvent` helper — operators no longer tap a separate "Release to next station" button after timed hand-pack complete.
- **UI:** Manual release button hidden for `HANDPACK_BLISTER` stations (machine blister/sealing release unchanged).

### Tests added (STATION-HANDPACK-AUTO-RELEASE-1)
- `stage-action-buttons.test.ts` — auto-release wiring, shared release helper, HANDPACK-only guard, release button hidden, sealing overlap pickup unchanged, scan-card-form untouched.

## [0.4.18] — 2026-05-28

### Fixed (STATION-KIND-FIX-1)
- **Root cause:** Floor stations are admin-managed (`/machines`); `scripts/seed.ts` does not create them. **Blister Hand Pack Station** was created as `kind=BLISTER` before `HANDPACK_BLISTER` existed (migration 0044) and was never corrected. UI behavior already follows `stations.kind` — no floor logic change required.
- **Kind catalog:** `lib/production/station-kind-catalog.ts` records expected label→kind mappings and marks duplicate **Hand Pack Blister Smoke** for deactivation.
- **Repair script:** `npm run repair:station-handpack-kind` (`scripts/fix-station-handpack-kind.ts`) — dry-run by default; `--apply` with `ALLOW_STATION_KIND_FIX=true` on production. Corrects hand-pack kind, clears machine binding, deactivates smoke duplicate, writes audit rows.
- **After apply:** Blister Hand Pack Station shows timed-only **Hand-pack complete**, hand-work pause reasons (default Shift ending), no Rolls, no count close-out.

### Tests added (STATION-KIND-FIX-1)
- `lib/production/station-kind-catalog.test.ts` — catalog mappings, deactivation list, HANDPACK_BLISTER vs BLISTER floor expectations.
- `app/(floor)/floor/[token]/stage-action-buttons.test.ts` — behavior follows station kind, not station name.

## [0.4.17] — 2026-05-27

### Fixed (PRODUCTION-OVERLAP-3)
- **Idle copy for pickup-only stations:** Changed "Scan a bag QR released from the prior stage" to "Scan a QR card or pick from the list below." — SEALING and PACKAGING can now pick up bags that are still active upstream (overlap), so requiring a release is no longer accurate.
- **Pickup dropdown label:** Changed `optgroup` label from "Pick up released bag (same QR continues)" to "Pick up bag (same QR continues)" in `scan-card-form.tsx` — overlap pickup is not a released-bag operation.

### Tests added (PRODUCTION-OVERLAP-3)
- `stage-action-buttons.test.ts` — completion gate assertions: SEALING_COMPLETE button hidden at STARTED stage (via `EVENT_STAGE_PREREQ` filter); PACKAGING form gated by `packagingReady = currentStage === "SEALED"` (BLISTERED is not ready); PACKAGING stage list uses `[]` override.
- `page.test.ts` — idle copy no longer contains "released from the prior stage"; new text confirmed; scan-card-form optgroup no longer says "released bag".

## [0.4.16] — 2026-05-27

### Changed (PRODUCTION-OVERLAP-2)
- **PACKAGING overlap pickup:** `STATION_PICKUP_FROM_STAGE.PACKAGING` expanded from `["SEALED"]` to `["BLISTERED", "SEALED"]`. A PACKAGING station operator may now scan and claim a bag that sealing is actively working on (bag at BLISTERED stage). `PACKAGING_COMPLETE` remains gated on `SEALED` — the Complete button stays locked until sealing finishes.
- **Waiting-for-sealing banner:** `BagAdvancedBanner` in the floor page shows an amber "Waiting for sealing to complete" card when a PACKAGING station has claimed a bag still at BLISTERED, matching the SEALING waiting banner added in PRODUCTION-OVERLAP-1.

### Tests added (PRODUCTION-OVERLAP-2)
- `lib/production/stage-progression.test.ts` — PACKAGING picks up at BLISTERED; PACKAGING_COMPLETE still rejects BLISTERED; PACKAGING_COMPLETE allows SEALED; PACKAGING cannot pick up STARTED; updated "multi-station travel" invariant to reflect overlap.
- `app/(floor)/floor/[token]/page.test.ts` — PACKAGING banner guard ordering, text, amber styling, sealing mention, PACKAGING prereq stage unchanged.
- `lib/production/flow-overlap-readiness.test.ts` — updated `canBeginUnderCurrentSerialRules` assertions to reflect PACKAGING now accepting BLISTERED in serial rules.

## [0.4.15] — 2026-05-27

### Changed (STATION-NAV-CLEANUP-3)
- **Remove Bag Allocation from operator station flow:** `/floor/[token]/bag-allocation` redirects to the main station page (valid token), matching the variety-pack cleanup. No supervisor tool or station nav links to bag allocation. Navigation-only change — scan/start production behavior unchanged.

### Tests added (STATION-NAV-CLEANUP-3)
- `lib/production/floor-station-mobile-nav.test.ts` — bag-allocation redirect, station page nav scope, hard-stop file scope report.

## [0.4.14] — 2026-05-27

### Changed (STATION-NAV-CLEANUP-2)
- **Remove Variety pack from station supervisor tools:** No station kind links to `/floor/[token]/variety-pack`. BLISTER, SEALING, and COMBINED keep **Rolls** only; all other kinds show no supervisor tools panel. Variety pack production is expected from the main station scan flow.
- **`/floor/[token]/variety-pack`:** Redirects to the station page (valid token) instead of the legacy allocation workflow UI.
- **Bag allocation sub-page nav:** Footer links back to **Station** only (removed cross-links to Variety pack, Bag allocation, Rolls).

### Tests added (STATION-NAV-CLEANUP-2)
- `lib/production/floor-station-mobile-nav.test.ts` — no variety pack on any kind, BOTTLE_HANDPACK empty tools, variety-pack redirect, bag-allocation nav cleanup.

## [0.4.13] — 2026-05-27

### Fixed (STATION-PAUSE-2)
- **Station-specific pause reasons:** Explicit per-`StationKind` matrix in `lib/production/station-pause-reasons.ts` so hand-work stations (HANDPACK_BLISTER, BOTTLE_HANDPACK, PACKAGING, bottle finish) never show PVC roll swap or Machine jam. Machine-bound stations (BLISTER, SEALING, COMBINED) keep roll/jam options. Default selection is `shift_end` on hand-work and `pvc_swap` on machine stations; floor UI resyncs if the selected reason is not valid for the station.

### Tests added (STATION-PAUSE-2)
- `lib/production/station-pause-reasons.test.ts` — matrix coverage, PACKAGING/BOTTLE_HANDPACK guards, default-in-options.
- `app/(floor)/floor/[token]/stage-action-buttons.test.ts` — default helper + `useEffect` resync.

## [0.4.12] — 2026-05-27

### Changed (PRODUCTION-OVERLAP-1)
- **Allow SEALING to scan bags while still STARTED (overlap pickup):** `STATION_PICKUP_FROM_STAGE.SEALING` now accepts `["STARTED", "BLISTERED"]`. Operators can scan the same bag card at the sealing station while blister/hand-pack is still running. SEALING_COMPLETE still requires the bag to be at BLISTERED — the Complete button stays locked until the upstream station fires. An amber waiting banner ("Waiting for blister to complete") appears on the sealing station page while the bag is STARTED, so the operator knows the scan succeeded and sealing is pending upstream.

### Tests added (PRODUCTION-OVERLAP-1)
- `lib/production/stage-progression.test.ts` — 3 new tests: SEALING pickup accepts STARTED, SEALING pickup still accepts BLISTERED, SEALING_COMPLETE still rejects STARTED.
- `app/(floor)/floor/[token]/page.test.ts` — 6 new tests: guard precedes prereq check, banner text, amber styling, stationKind wiring, blister/hand-pack mention, completion gate unchanged.
- `lib/production/flow-overlap-readiness.test.ts` — 2 existing assertions updated to reflect updated serial rules (STARTED now pickup-eligible).

## [0.4.11] — 2026-05-27

### Added (FLOW-OVERLAP-2A)
- **Overlap readiness foundation (no floor behavior change):** Pure helper `lib/production/flow-overlap-readiness.ts` models proposed lane overlap (blister / sealing / packaging) separately from current serial pickup and complete guards. Documents data gaps when partial output cannot be derived from today's event types while global stage remains `STARTED` or `BLISTERED`.

### Tests added (FLOW-OVERLAP-2A)
- `lib/production/flow-overlap-readiness.test.ts` — 12 tests: insufficient data at STARTED, partial-signal overlap vs complete strictness, current serial semantics at BLISTERED/SEALED, global pause assumption.

### Docs (FLOW-OVERLAP-2A)
- `docs/superpowers/plans/2026-05-26-flow-overlap-2a-foundation.md` — implementation memo for FLOW-OVERLAP-2B (what is derivable today, required events/read-model fields, pause model, hard stops).

## [0.4.10] — 2026-05-27

### Fixed (STATION-PAUSE-REASONS-1)
- **Station-specific pause reasons (complete fix):** `machine_jam` was still shown on all stations including HANDPACK_BLISTER, which has no machine. Extracted pause reason lists into `lib/production/station-pause-reasons.ts`. Machine-bound stations (BLISTER, SEALING, COMBINED) retain "PVC roll swap" and "Machine jam". All hand-work stations (HANDPACK_BLISTER, BOTTLE_HANDPACK, PACKAGING, BOTTLE_CAP_SEAL, BOTTLE_STICKER) now show only "Shift ending", "QA check", and "Other". Staging was on v0.4.8 (partial fix — pvc_swap gated but machine_jam not yet gated).

### Tests added (STATION-PAUSE-REASONS-1)
- `lib/production/station-pause-reasons.test.ts` — 8 tests: machine/hand kind matrices, HANDPACK_BLISTER specifics, shift_end/qa_check/other universal presence, per-category defaults, unknown-kind fallback, non-empty labels.
- `app/(floor)/floor/[token]/stage-action-buttons.test.ts` — updated: pause reason tests now verify helper import/usage and that no inline station-kind conditionals remain in JSX.

## [0.4.9] — 2026-05-27

### Changed
- **Station supervisor tools (STATION-TOOLS-CLEANUP-2):** Tightened which optional floor sub-pages appear under **Supervisor tools**. `HANDPACK_BLISTER` and packaging/bottle finish stations show no tools. Card/blister kinds no longer link to **Variety pack** (bottle allocation workflow). **Variety pack** remains on `BOTTLE_HANDPACK` only. **Rolls** stays on `BLISTER`, `SEALING`, and `COMBINED` (PVC/foil machine path). Bag allocation and admin Start production remain removed.

### Tests added (STATION-TOOLS-CLEANUP-2)
- `lib/production/floor-station-mobile-nav.test.ts` — per-kind tool matrix, empty panel guard.

## [0.4.8] — 2026-05-27

### Fixed (STATION-HANDPACK-1)
- **HANDPACK_BLISTER timed-only completion:** `HANDPACK_BLISTER_COMPLETE` is now in a `TIMED_ONLY_EVENTS` set, excluding it from `hasGenericStages`. The count input no longer renders on the Blister Hand Pack station — completion is one tap ("Hand-pack complete") with no count or packs-remaining field.
- **Station-kind-aware pause reasons:** The "PVC roll swap" pause option is hidden on `HANDPACK_BLISTER` stations, which don't use PVC film. Pause reason defaults to "Shift ending" on HANDPACK_BLISTER and "PVC roll swap" on all other stations.

### Tests added (STATION-HANDPACK-1)
- `app/(floor)/floor/[token]/stage-action-buttons.test.ts` — 11 tests: HANDPACK_BLISTER_COMPLETE in TIMED_ONLY_EVENTS, not in RICH_FORM_EVENTS, hasGenericStages gate, no count field, BLISTER path preserved (BLISTER_COMPLETE in RICH_FORM_EVENTS, BlisterCompleteForm exists, triggered by BLISTER_COMPLETE only), PVC option gated by station kind, pause defaults, shift_end/other always available.

## [0.4.7] — 2026-05-27

### Fixed
- **QR card retire (QR-CARDS-RETIRE-1):** Retire on `/qr-cards` now refreshes the list after success and shows inline errors instead of silent failure. Retire stays enabled for intake-reserved cards (`ASSIGNED` without a workflow bag); only mid-production cards (`ASSIGNED` + active bag) are blocked, matching server rules.

### Tests added (QR-CARDS-RETIRE-1)
- `app/(admin)/qr-cards/actions.test.ts` — action auth, revalidate, friendly errors.
- `app/(admin)/qr-cards/qr-cards-retire.test.ts` — Retire button wiring, refresh, disable rules.
- `lib/production/qr-card-retire.test.ts` — mid-production eligibility matrix.

## [0.4.6] — 2026-05-27

### Added (STATION-ACTIVE-UX-1)
- **Eastern station times:** `formatFloorTimeEastern` helper (`lib/floor-time.ts`) formats all floor-visible timestamps in `America/New_York` with DST awareness instead of relying on the Docker container's UTC locale.
- **Live elapsed timer:** `ElapsedTimer` client component (`elapsed-timer.tsx`) displays active production time ticking every second; freezes with "Paused at" label when `isPaused=true`. Formula accounts for accumulated pause seconds and current pause delta.
- **Clearer operator field label:** `placeholder="Operator code"` replaces the ambiguous "Op # (4 digits)" text in the stage-action-buttons input.

### Tests added (STATION-ACTIVE-UX-1)
- `lib/floor-time.test.ts` — 10 tests covering `formatFloorTimeEastern` (winter/summer DST, string input, minute padding) and `formatElapsedSeconds` (zero, sub-minute, minutes, hours, negative clamping, fractional floor).
- `app/(floor)/floor/[token]/page.test.ts` — 13 new tests: Eastern time import/usage, no bare `toLocaleTimeString()` on `startedAt`, `ElapsedTimer` placement + props (startedAtMs, pausedSecondsAccum, isPaused, pausedAtMs), use-client directive, setInterval/clearInterval, "Paused at" label, updated Op placeholder.

## [0.4.5] — 2026-05-27

### Changed
- **Station nav cleanup (STATION-NAV-CLEANUP-1):** Removed **Start production** from the admin sidebar; `/production/start` now redirects to **Live floor** (`/floor-board`) with no fallback form. Removed **Bag allocation** from all station supervisor-tool links (the `/floor/[token]/bag-allocation` route remains for validation tooling). Receive success and partial-bags links now point to Live floor instead of the obsolete start page.

### Tests added (STATION-NAV-CLEANUP-1)
- `app/(admin)/production/start/page.test.ts` — redirect-only page, sidebar not promoted.
- `lib/production/floor-station-mobile-nav.test.ts` — no station shows bag allocation in supervisor tools.

## [0.4.4] — 2026-05-27

### Tests added (FLOOR-FIRST-RUN-E2E-2)
- `FLOOR-FIRST-RUN-E2E-2 · first-op camera-scan → product → start` — 8 structural tests proving the full scan → product-select → Start submission path: `submitWithCardId` uses `explicitProductId ?? productId`; onClick priority-1 branch preserves `productId` state; multi-product path sets `resolvedCardId` and clears `productId` for picker; lookup failure surfaces `scanError` without clearing `resolvedCardId`; `e.preventDefault()` precedes submit on scan path; `submitWithCardId` catch block surfaces errors; operator session not required for scan-start; synchronous projector guarantees no read-model lag after commit.

### Added
- `docs/floor-scan-e2e-verification.md` — manual verification checklist for the camera-scan → product → Start production flow on staging. Covers 5 paths: auto-submit (single product), multi-product picker, typed scan, failure/error, and downstream pickup. Includes post-submit DB check SQL and auth smoke reminder.

## [0.4.3] — 2026-05-27

### Changed
- **Floor station mobile polish (STATION-MOBILE-UX-2):** Tighter mobile layout on `/floor/[token]` — compact station header (no “Online” badge), shorter idle-bag copy, de-emphasized internal bag id, slimmer materials and supervisor-tools panels. Tool and loaded-material visibility remain gated by station kind. No scan/start or dropdown behavior changes.

### Tests added (STATION-MOBILE-UX-2)
- `lib/production/floor-station-mobile-nav.test.ts` — BOTTLE_HANDPACK, BOTTLE_CAP_SEAL, BOTTLE_STICKER, loaded-material visibility.
- `app/(floor)/floor/[token]/page.test.ts` — mobile layout structural guards.

## [0.4.2] — 2026-05-27

### Changed
- **Floor station mobile UX (STATION-MOBILE-UX-1):** Removed the always-visible top row of Rolls / Bag allocation / Variety pack links from `/floor/[token]`. Those validation tools now appear only inside a collapsed **Supervisor tools** section at the bottom of the page, and only on station kinds where each tool is relevant. Primary mobile flow is station header → operator shift → loaded materials (when applicable) → current bag scan/start. No scan, QR lookup, or production-start logic changes.

### Tests added (STATION-MOBILE-UX-1)
- `lib/production/floor-station-mobile-nav.test.ts` — station-kind tool visibility matrix.
- `app/(floor)/floor/[token]/page.test.ts` — layout guards (no primary nav, scan card + footer preserved).

## [0.4.1] — 2026-05-27

### Fixed
- **Floor scan → product select → Start production works end-to-end (FLOOR-FIRST-RUN-E2E-1):** After a camera or typed scan resolved a bag QR, clicking "Start production" would re-enter `handleResolvedToken` instead of submitting. Root cause: the button `onClick` checked `scanInput.trim()` before `resolvedCardId`. After a successful scan, `scanInput` holds the card label (e.g. "bag-card-117"), making it truthy — so the click re-scanned, clearing the selected product ID and resetting the product picker. Fix: reordered the priority in `onClick` to check `resolvedCardId` first (matching the existing `handleScanKeyDown` priority order). Operator can now: scan bag QR → see confirmation chip → pick product by name → tap Start → bag enters production without any RSC overlay or native browser validation popup.

### Tests added (FLOOR-FIRST-RUN-E2E-1)
- `FLOOR-FIRST-RUN-E2E-1 · submit button onClick priority` — 4 structural tests asserting correct priority order and early-return in button onClick.

## [0.4.0] — 2026-05-27

### Added
- **Declared pill count on bag edit (RECEIVE-EDIT-2B-2):** Supervisors (`requireLead`) can correct a bag’s declared pill count from `/inbound/[receiveId]/bag/[bagId]/edit`. Updates `inventory_bags.declared_pill_count` only; live `pill_count` is unchanged. Audited under existing `inventory_bag.edit` with `declaredPillCount` in before/after snapshots. Bag edit history and `/reports/audit-log` show a readable “Declared pills” diff. Blocked when the bag is in production (notes-only policy).

### Tests added (RECEIVE-EDIT-2B-2)
- `lib/db/queries/bag-edits.test.ts` — production guard for declared pill count.
- `lib/receive/bag-edit-history.test.ts` — declared pills diff line.
- `app/(admin)/inbound/[id]/bag/[bagId]/edit/actions.test.ts` — parsing and validation.
- `app/(admin)/inbound/[id]/bag/[bagId]/edit/bag-edit-form.test.ts` — structural guards (no `pill_count` writes).

## [0.3.9] — 2026-05-27

### Fixed
- **Floor product dropdown shows product names only (PRODUCT-DROPDOWN-1):** The product select shown after scanning a bag at a first-op station was rendering `{sku} — {name}` (e.g. `LUMA-fix-beyond-cocoa-cal-6Q2PS — FIX Beyond - Cocoa Calm`). Floor operators only need the product name. Also fixed the "Making:" chip on the active-bag panel which showed `Making: SKU — Name`. Both now show product name only. No filtering, scan, or QR lookup logic changed.
- **Build fix — Button variant (from RECEIVE-EDIT-2B-1):** `app/(admin)/inbound/[id]/page.tsx` used `variant="outline"` which is not a valid variant for the Luma Button component. Changed to `variant="secondary"`.

### Tests added (PRODUCT-DROPDOWN-1)
- `PRODUCT-DROPDOWN-1 · floor product select shows name only` — 2 structural tests.
- `PRODUCT-DROPDOWN-1 · floor Making chip shows name only` — 2 structural tests.

## [0.3.8] — 2026-05-27

### Added
- **Receive notes and open/close edit (RECEIVE-EDIT-2B-1):** Supervisors (`requireLead`) can edit receive-level notes and mark a receive open or closed from `/inbound/[id]/edit`. Only `receives.notes` and `receives.closed_at` are updated; PO, shipment, receive name, bags, and batches are unchanged. Changes are audited as `receive.edit` on target `Receive` with before/after snapshots of notes and closedAt. Receive detail page includes a secondary **Edit receive** link.

### Tests added (RECEIVE-EDIT-2B-1)
- `lib/db/queries/receive-edits.test.ts` — patch builder for notes and open/close.
- `app/(admin)/inbound/[id]/edit/page.test.ts` — structural guards (editable scope, requireLead).
- `app/(admin)/inbound/[id]/edit/actions.test.ts` — requireLead enforcement and delegation.
- `app/(admin)/inbound/[id]/page.test.ts` — Edit receive link on detail page.
- `lib/audit/audit-log-view.test.ts` — receive.edit display in audit log viewer.

## [0.3.7] — 2026-05-27

### Added
- **Admin audit log viewer (AUDIT-LOG-1):** Read-only `/reports/audit-log` page for supervisors (`requireLead`). Shows the latest 100 `audit_log` rows with time, actor, action, target, compact summary, and per-row details expansion (human-readable lines + collapsed before/after JSON). Optional filters: action substring, target type, actor email substring. Sidebar link under Reports.

### Tests added (AUDIT-LOG-1)
- `lib/audit/audit-log-view.test.ts` — summary formatting helpers.
- `app/(admin)/reports/audit-log/page.test.ts` — structural guards for page, filters, nav.

## [0.3.6] — 2026-05-27

### Fixed
- **PostgresError 22P02 crash on floor bag scan (FLOOR-SCAN-ERROR-2):** Scanning any bag QR whose `scanToken` is a slug (e.g. `bag-card-117`) caused a Server Components render error overlay (digest `2676337210`) after the camera decoded the code. Root cause: `lookupCardByTokenAction` used `or(eq(qrCards.scanToken, token), eq(qrCards.id, token))` unconditionally. When `token` is a slug, Drizzle passes it as the `$2` parameter to the UUID-typed `id` column, and PostgreSQL throws `invalid input syntax for type uuid: "bag-card-117"` (22P02). Fix: added a `UUID_RE.test(token)` guard — non-UUID tokens only hit `scanToken`; UUID-format tokens (legacy labels printed before QR-SCAN-PAYLOAD-1) continue to search both columns. Also wrapped the DB query in try-catch so any future unexpected DB error surfaces as an inline error rather than an RSC overlay.

### Tests added (FLOOR-SCAN-ERROR-2)
- `FLOOR-SCAN-ERROR-2 · non-UUID scan token does not hit UUID column` — 4 tests in `scan-card-form.test.ts`:
  - DB query wrapped in try-catch with `return { error }` (not rethrow).
  - Non-UUID slug returns `ok` when card found by `scanToken`.
  - Non-UUID slug returns not-found error when no card.
  - UUID-format token (legacy label) still resolves via both columns.
- Updated `QR-SCAN-PAYLOAD-1 · lookupCardByTokenAction dual lookup` test 1 to assert `UUID_RE.test(token)` gate instead of unconditional `.where(or(`.

## [0.3.5] — 2026-05-27

### Fixed
- **Server Components render error after floor scan (FLOOR-SCAN-ERROR-1):** Scanning a bag QR at the Blister Hand Pack Station (and any station that renders or imports the QC panel) showed the Next.js "An error occurred in the Server Components render" overlay immediately after a successful scan. Root cause: `qc-actions.ts` and `app/(admin)/qc-review/actions.ts` both exported `__testInternals` (a plain object) from a `"use server"` file. Next.js App Router validates "use server" module exports during RSC renders triggered by `router.refresh()` — any non-async export throws digest `2276167736` at runtime. The initial page load used a cached module evaluation that bypassed the check; `router.refresh()` (called after `scanCardAction` succeeds) performed a fresh RSC fetch that triggered the validation. Fix: removed both `__testInternals` const exports. The private `assertNoLinkedConflict`, `loadLinkedEventAccountability`, and `hasExistingResolution` functions remain in their respective files for internal use.

### Tests added (FLOOR-SCAN-ERROR-1)
- `FLOOR-SCAN-ERROR-1 · use-server file export guard` — 5 structural tests in `scan-card-form.test.ts`:
  - `qc-actions.ts` starts with `"use server"`.
  - `qc-actions.ts` does not export `__testInternals`.
  - `qc-actions.ts` does not export any plain `const` object.
  - `admin/qc-review/actions.ts` does not export `__testInternals`.
  - `admin/qc-review/actions.ts` does not export any plain `const` object.

## [0.3.4] — 2026-05-27

### Added
- **Per-bag edit history on receive detail (RECEIVE-EDIT-2A-1):** `/inbound/[id]` now loads `audit_log` rows for each inventory bag on the receive. The bags table shows an **Edits** column (`No edits` / `N edits` linking to history). Below the table, an **Edit history** section uses expandable panels per bag with timestamp, actor, action label, and readable before/after summaries (weight in kg, receipt #, QR token, notes, supplier lot). Related `qr_card.released_at_bag_edit` and `qr_card.reserved_at_bag_edit` rows are included when they match scan tokens from bag edits. Read-only — no change to edit behavior.

### Tests added (RECEIVE-EDIT-2A-1)
- `lib/receive/bag-edit-history.test.ts` — audit summarization and grouping.
- `app/(admin)/inbound/[id]/page.test.ts` — structural guards for audit fetch and history UI.

## [0.3.3] — 2026-05-27

### Improved
- **Receive detail post-save edit discoverability (RECEIVE-EDIT-AUDIT-1):** Confirmed bag edit workflow is fully implemented at `/inbound/[id]/bag/[bagId]/edit` (weight, notes, receipt #, QR scan token, supplier lot, edit reason, audit log). Receive detail bags table now includes a short helper explaining post-save edits, renames the row action to **Edit bag**, and labels the actions column. No backend or schema changes.

### Tests added (RECEIVE-EDIT-AUDIT-1)
- `app/(admin)/inbound/[id]/page.test.ts` — structural guards for edit route link, helper copy, kg display.

## [0.3.2] — 2026-05-27

### Fixed
- **Camera scan input blank after scan (FLOOR-SCAN-LIVE-1):** Two bugs caused the scan input to appear empty after a camera QR scan.
  1. `handleResolvedToken` had no `catch` block. If `lookupCardByTokenAction` threw (DB error, network failure, Next.js serialization error), the exception propagated silently — `setScanInput` never ran and no error was displayed. The form appeared unresponsive.
  2. `setScanInput` was only called *after* the server lookup completed. During the roundtrip (~100–500 ms) and on the auto-submit path (where `router.refresh()` fires immediately), the input showed only the placeholder text. Operators had no visible confirmation of what was scanned.
- **Fix:** Raw scan token is now set in the input immediately when the scan starts (before the server round-trip). On successful lookup, it is overwritten with the human-readable bag label and the green confirmation chip. On error, the raw token remains so operators can verify the QR payload.
- **`?debug=1` diagnostic mode:** Appending `?debug=1` to any floor station URL logs the raw camera-decoded QR value to the browser console (`[floor-scan] camera decoded: ...`). Use this to diagnose QR encoding issues in the field without polluting normal operation.

### Tests added (FLOOR-SCAN-LIVE-1)
- `handleResolvedToken sets scanInput to raw.trim() immediately — before lookup` (index-order guard).
- `handleResolvedToken has catch block` — confirms `} catch (err) {` exists within `handleResolvedToken` body and calls `setScanError`.
- `handleCameraResult logs decoded QR value to console when ?debug=1 is set in URL`.

## [0.3.1] — 2026-05-27

### Added
- **`npm run audit:product-zoho-readiness` (PRODUCT-MAP-3):** Runs the read-only `scripts/audit-product-zoho-readiness.ts` fleet audit. Requires `DATABASE_URL`.

### Improved
- **Zoho readiness banner copy (PRODUCT-MAP-3):** Product detail banner now uses compact labels (`Zoho ready`, `Zoho mapping incomplete`, `Zoho IDs missing`, `Inactive product`) via `zohoReadinessShortLabel`. Long-form labels remain in `zohoReadinessLabel` for tooling.
- **Audit script output (PRODUCT-MAP-3):** Lists product name, SKU, kind, and ID on every row; prints ready/inactive buckets; section headers match banner vocabulary.

### Tests added (PRODUCT-MAP-3)
- Long unit ID (>60 chars) in `zohoItemIdUnit` → READY (assembly columns accept 100 chars; legacy `zoho_item_id` back-sync limit does not affect readiness).
- `zohoReadinessShortLabel` compact copy (4 assertions).

No schema changes. No Zoho outbound write behavior changes. No floor/station/camera/QR scan changes.

## [0.3.0] — 2026-05-27

### Changed
- **Camera scan is now the primary floor workflow (FLOOR-SCAN-UX-2):** After a successful QR scan (camera or typed), the scan input now shows the bag card's human label (e.g., `bag-card-117`) instead of going blank. A green confirmation chip appears below showing the full resolved context: card label, PO number, bag number, and tablet type. Operators have immediate visual confirmation of what was scanned without touching the dropdown.
- **Dropdown is explicitly backup-only:** The dropdown comment and surrounding hint text clarify that physical QR scanning is the primary path. The dropdown exists for recovery scenarios only.
- **Enter-on-resolved-input submits:** After a camera or typed scan resolves a card, pressing Enter in the scan input submits the workflow (or shows a product-required error) rather than trying to re-scan the label text.
- **Typing invalidates resolved card:** If an operator edits the scan input after a resolved scan, the resolved state clears and the next Enter triggers a fresh lookup.

### Internal
- `lookupCardByTokenAction` now returns `cardLabel: string` (from `qrCards.label`) alongside `cardId`.
- Source-text guard tests added for the scan confirmation lifecycle and the `cardLabel` return value.

### Version rationale
v0.3.0 (not a patch): this completes the camera scan as the trusted primary production floor path. Without visual confirmation, operators default to the dropdown and camera scanning is not viable in practice. With it, camera scan is the production-validated primary workflow.

## [0.2.49] — 2026-05-26

### Fixed
- **QR label payload mismatch (QR-SCAN-PAYLOAD-1):** Printed bag QR labels were encoding `qrCards.id` (the UUID primary key), but `lookupCardByTokenAction` was matching by `qrCards.scanToken` (a separate column). Every physical scan — camera or USB/Bluetooth barcode scanner — silently returned "Bag QR not found." New labels now encode `qrCards.scanToken`, the correct lookup key. The floor scan lookup now also accepts `qrCards.id` as a backward-compatible fallback so labels printed before this fix continue to resolve (TODO: remove the id fallback once all legacy labels are retired/reprinted).
- **Floor station footer version metadata:** The station page footer now shows `v{version} · {sha} · {branch}`, matching the admin UI. Operators and supervisors can confirm which deployed version is running on floor tablets.

### Tests added (QR-SCAN-PAYLOAD-1)
- Source-text guard: `lookupCardByTokenAction` uses `or()` wrapping both `scanToken` and `id` clauses.
- Source-text guard: QR label page calls `renderQrSvg(r.card.scanToken)` — not `r.card.id`.

## [0.2.48] — 2026-05-26

### Added
- **Zoho product readiness helper (PRODUCT-MAP-3):** Pure `classifyProductZohoReadiness` in `lib/zoho/product-zoho-readiness.ts`. Classifies active products as READY / PARTIAL / MISSING based only on configured Zoho item IDs (`zohoItemIdUnit`, `zohoItemIdDisplay`, `zohoItemIdCase`). Floor readiness (tablet mapping) is a separate concern, not mixed into the Zoho level. `zohoReadinessLabel` and `zohoReadinessReasonLabel` provide UI copy.
- **Zoho readiness banner on product detail page (PRODUCT-MAP-3):** A compact `ZohoReadinessCard` banner appears inside the existing Zoho assembly mapping card on each product detail page, showing the product's Zoho readiness level, specific missing IDs, and a separate note if tablet mapping is absent. Supervisors can see at a glance whether a product can generate valid Zoho assembly payloads.
- **`scripts/audit-product-zoho-readiness.ts` (PRODUCT-MAP-3):** Read-only CLI script. Prints a grouped summary: total/active/ready/partial/missing/inactive counts, per-product missing Zoho IDs, floor readiness gaps, and BOM materials missing Zoho item IDs. Usage: `DATABASE_URL=postgres://... tsx scripts/audit-product-zoho-readiness.ts`. Run before enabling Zoho dry-run or live writes.

### Tests added (PRODUCT-MAP-3)
- `lib/zoho/product-zoho-readiness.test.ts` (13 tests): inactive early-return, unit-only READY/MISSING, unit+display PARTIAL/READY/MISSING, unit+display+case READY/PARTIAL/MISSING, tablet mapping separation, legacy field contract.

## [0.2.47] — 2026-05-26

### Fixed
- **Camera scanner stuck on spinner on HTTPS (CAMERA-SCAN-ROOTCAUSE-1):** The `<video>` element was rendered inside `{phase === "scanning" && ...}`, making `videoRef.current` null when the `getUserMedia` promise resolved during the "starting" phase. The `if (video)` check failed silently — the OS granted camera access but `.play()` was never called and `setPhase("scanning")` was never reached. Scanner stayed on the spinner forever even on HTTPS/public URL. Fixed by always rendering the video element in the DOM and toggling visibility via a CSS `hidden` class, so `videoRef.current` is non-null when the async stream arrives.

### Added
- **Camera diagnostics panel (CAMERA-SCAN-ROOTCAUSE-1):** When the camera fails to start, a compact diagnostics panel now appears inside the scanner error UI. Shows operator-friendly status for: HTTPS secure context, Camera API availability, camera permission (denied/granted), hardware BarcodeDetector support or jsQR fallback, and whether the camera stream started. Helps operators and supervisors identify whether the issue is HTTPS, permissions, or browser support.
- **`lib/floor/camera-diagnostics.ts`:** Pure helpers `classifyCameraCapabilities` (injectable, testable) and `getStaticCameraDiagnostics` (reads browser globals for React use).

### Tests added (CAMERA-SCAN-ROOTCAUSE-1)
- `lib/floor/camera-diagnostics.test.ts` (5 tests): HTTP context, HTTPS + all APIs, iOS Safari (no BarcodeDetector / jsQR handles), Android Chrome, always-true jsQrFallback invariant.
- Structural camera-scanner invariants (9 tests added to `scan-card-form.test.ts`): video DOM fix (CSS hidden, not conditional render), `setStreamStarted(true)`, `setPermissionDenied(true)`, `CameraDiagnosticsPanel` in error phase, HTTPS diagnostic label, camera permission label, stream-stop in BarcodeDetector path, stream-stop in jsQR path.

## [0.2.46] — 2026-05-22

### Fixed
- **Zoho item ID no longer requires double-entry (PRODUCT-MAP-2):** The product creation dialog was writing the "Zoho item ID (single unit)" value to `products.zoho_item_id` (legacy column) instead of `products.zoho_item_id_unit`. After creation, the mapping page pre-filled from the fallback with a "Save to confirm" hint, forcing supervisors to click Save a second time. Fixed by changing the dialog field `name` to `zohoItemIdUnit` and adding the same `zohoItemId` back-sync already present in `zoho-mapping-actions.ts`.

### Improved
- **Canonical Zoho item ID labels (PRODUCT-MAP-2):** The product creation dialog and Zoho mapping form now use consistent labels: "Zoho item ID — single unit", "Zoho item ID — display", "Zoho item ID — case". Removed the "display & case IDs coming soon" placeholder (both fields have been supported since ZOHO-ASSY-1).
- **Floor readiness card on product detail (PRODUCT-MAP-2):** A compact status banner now appears on every product detail page showing one of: "Ready for floor selection" (active + has at least one tablet mapping), "Missing tablet mapping — floor selection unavailable" (active + no mappings), or "Inactive — cannot be assigned to new production runs". Links supervisors to the BOM section when configuration is needed.

### Tests added (PRODUCT-MAP-2)
- Dialog field correctness (4 tests): `zohoItemIdUnit` field name, no stray `zohoItemId` input, fallback defaultValue for old products, correct label.
- `saveProductAction` back-sync (4 tests): derives legacy `zohoItemId` from `zohoItemIdUnit` — short value, >60 chars, null, and not-submitted.
- Mapping form canonical labels (4 tests): unit/display/case labels match spec.
- Floor readiness classification (3 tests): ready / missing-tablet / inactive states.
- Floor compatibility contract (6 tests): product with no tablet mapping excluded when type known, all products shown when type null, zero-match config error, single-match auto-select, multiple-match narrowed picker.

## [0.2.45] — 2026-05-22

### Fixed
- **Floor scan: `narrowProducts` test function corrected (FLOOR-SCAN-1):** The `narrowProducts` helper in `scan-card-form.test.ts` was testing a more permissive filter rule (treating `allowedTabletTypeIds=[]` as "accepts all tablet types") than the actual production code (`filteredProducts` excludes products with an empty `allowedTabletTypeIds` array — intentionally marked as incomplete configuration). The test function and the "shows unmapped product regardless of scanned tablet" assertion are corrected to match actual behavior, with an explanatory comment.

### Improved
- **Floor scan form wording (FLOOR-SCAN-1 Task 6):** Typed scan input placeholder changed from "Scan or type bag QR…" to "Scan bag QR…". Dropdown backup optgroup labels updated to "Received bags available for this station" and "Received bags available for this station — start new run".

### Tests added
- **FLOOR-SCAN-1 · downstream station fresh-bag guard** (4 tests): structural checks that `actions.ts` defines `FRESH_BAG_STATION_KINDS`, blocks non-first-op stations from starting fresh bags, rejects IDLE cards with "Receive Pills" message, and blocks RETIRED cards.
- **FLOOR-SCAN-1 · camera scanner HTTPS requirement** (5 tests): verifies `camera-scanner.tsx` checks `window.isSecureContext`, shows "Camera access requires HTTPS. This page is served over HTTP" on insecure context, shows browser-unsupported fallback, links to typed input, and routes camera decode result through the same `onResult` handler as typed scan.
- **FLOOR-SCAN-1 · typed scan flow structural guards** (5 tests): confirms `handleResolvedToken` narrows products by tablet type ID before auto-submit decision, verifies the scan-resolved card path (`resolvedCardId`, `scannedTabletTypeId`) works for cards not in the server-rendered dropdown, and confirms zero-product config error is shown (no silent no-op).

## [0.2.44] — 2026-05-22

### Improved
- **Legacy receive wizard title corrected (UI-POLISH-4):** The `/inbound/new` legacy wizard page title was "New receive", implying it is the normal receive entry point. Renamed to "Legacy receive wizard" with an updated description ("Supervisor fallback only. For normal tablet intake use Receive pills; for packaging use Receive packaging."). The amber warning banner and links to the correct pages were already in place from a prior fix; this aligns the page heading with that message.

### Audit findings (no further changes needed)
- "Pack-out" wording: only in code/JSX comments in `packaging-output/page.tsx`; all user-visible labels already say "Production output" or "Output queue".
- "Purchase orders" tab: already renamed "Receives".
- "Receive another batch" button: already navigates to `/receiving/raw-bags` via full page load.
- `/inbound/new` promotion: not linked from any sidebar, nav button, or CTA. `inbound/page.test.ts` asserts this.
- "cards" for PO line items: not found.

### Tests
- Added `UI-POLISH-4 · legacy wizard labeling` suite (4 tests) in `app/(admin)/inbound/new/page.test.ts`: pins wizard title as "Legacy receive wizard", confirms amber banner text, and verifies both fallback links.

## [0.2.42] — 2026-05-22

### Improved
- **PO line receive status on Receive Pills page (RECEIVE-LINE-STATUS-1):** Each PO line card on the Receive Pills page now shows an explicit local-status chip:
  - **Available** (green) — no Luma receive exists for this line.
  - **Received in Luma** (sky blue) — one or more Luma receives already exist for this line.
  Active (currently-being-received) lines show a **"Receiving now"** chip (brand color).
- **Prior-receive warning banner:** When an operator selects a PO line that already has Luma receives, an inline sky-colored note appears: "This line already has N receive(s) in Luma (M bags). A new receive will be added." This makes intentional multi-receive scenarios explicit rather than silent.
- Lines remain selectable regardless of prior-receive status. Multiple receives per PO line are intentionally supported by the schema (`receives.po_line_id` is nullable-per-line, totals are aggregated, not replaced). Blocking selection would require a schema-level constraint that is out of scope for this task.

### Data model note
- Zoho per-line receivable status (`to_be_received` / `partially_received` / `received`) is **not stored locally** in `po_lines`. Only PO-level status exists on `purchase_orders` (gated by `RECEIVABLE_PO_STATUSES = ["OPEN", "RECEIVING"]`). Per-line Zoho blocking is not implementable without a schema addition (`po_lines.zoho_line_status`). Noted for future work.

### Tests
- Added `classifyPoLineLocalStatus` unit tests (4): undefined total → available, receiveCount=0 → available, receiveCount=1 → received, receiveCount>1 → received.
- Added `poLineLocalStatusLabel` unit tests (6): available label, available ignores total, singular bag, plural bags, multiple receives label, graceful no-total fallback.

## [0.2.43] — 2026-05-22

### Improved
- **Machines & Stations page helper copy (STATION-2 T3):** The Machines & Stations admin page now includes inline explanatory copy distinguishing the station/machine model: stations are floor scan targets (each has an optional machine FK); machines are physical equipment with output/cycle characteristics. Starting stations (BLISTER, HANDPACK_BLISTER, BOTTLE_HANDPACK, COMBINED) require product selection; downstream stations receive bags already in-flight.

### Changed
- **Admin Start Production demoted (STATION-2 T4):** The Start Production admin page is now explicitly marked as a supervisor fallback path. Page description updated to "Supervisor fallback path — for day-to-day production, operators scan bag QRs at the floor station." Sidebar navigation reordered so the floor station scan path is the primary entry point.

### Fixed
- **HANDPACK_BLISTER missing from station creation Zod schema (STATION-2 T5):** Creating a station of kind `HANDPACK_BLISTER` through the admin UI returned a Zod validation error because the kind was absent from the server action's enum. Added `HANDPACK_BLISTER` to the `stationKindSchema` in `machines/actions.ts`. Floor guard in `floor/[token]/actions.ts` now has a citation comment referencing the full list of first-op station kinds. Added 6 guard-audit tests in `lib/production/first-op-product.test.ts` covering HANDPACK_BLISTER product-kind mapping and floor-eligibility boundaries.

## [0.2.40] — 2026-05-22

### Improved
- **Receives history page actions corrected (UI-POLISH-3):** The "+ New receive → /inbound/new" button has been removed from the Receives history page. It pointed to a legacy wizard that is not the correct entry point for tablet or packaging receiving. Replaced with two explicit CTAs: "Receive pills" (→ `/receiving/raw-bags`) and "Receive packaging" (→ `/inbound/packaging-materials`). Both the header actions and the empty-state now use these routes.
- **Legacy wizard banner:** `/inbound/new` (the old receive wizard) now displays a prominent amber info banner: "This is a legacy wizard — use it only as a supervisor fallback." with direct links to the correct receive pages, so any user who arrives there is immediately redirected.

### Tests
- Added `app/(admin)/inbound/page.test.ts` (RECEIVE-NAV-1): 7 assertions verifying the correct links are present, `/inbound/new` is not promoted as a primary CTA, correct icons are used, and empty-state mirrors the header actions.

## [0.2.39] — 2026-05-22

### Fixed
- **QR card sort order:** RAW_BAG cards now sort numerically by label suffix regardless of label format (`bag-card-N`, `Bag Card N`, mixed case/separator). The previous `localeCompare({ numeric: true })` was unreliable for mixed-format labels (e.g. hyphenated vs space-separated) and ICU-dependent in certain environments. Replaced with an explicit `numericSuffix` extractor that parses the trailing integer and sorts by integer value directly.
- **ASSIGNED RAW_BAG cards with no context:** Cards with status ASSIGNED but no linked inventory bag were silently displaying "Reserved at receive" with no further detail. Root cause: Drizzle left-join returns `intakeBag: { id: null, ... }` — a truthy object — when no matching bag row exists. Guard now checks `intakeBag?.id` rather than truthy-object. Three outcome paths: (1) bag found with context → "Reserved at receive · [receive] · Bag N · Receipt # · [tablet]"; (2) bag found but all detail fields null → amber "Reserved at receive · missing details"; (3) no bag at all → italic "Assigned — missing bag context".

- **HANDPACK_BLISTER station kind missing from admin dropdown (STATION-1):** The "Add a station" form in Machines & stations did not include `HANDPACK_BLISTER` as a selectable station kind, making it impossible to create hand-pack blister stations through the UI. Added to the dropdown with a "(no machine)" note distinguishing it from the machine-backed BLISTER kind.

### Improved
- Receiving tabs: "Purchase orders" tab renamed to "Receives" — the `/inbound` page shows receive history, not a PO list.
- Recall page: "Pack-out — N" section heading renamed to "Production output — N" for consistency with sidebar and page title.
- "Receive another batch" button now navigates to `/receiving/raw-bags` (full page load, clean form state) instead of manually resetting each React state field in-place.
- Station/machine model documented in `lib/production/first-op-product.ts`: station = floor scan target (optional machine FK), machine = physical equipment, starting stations (BLISTER/HANDPACK_BLISTER/BOTTLE_HANDPACK/COMBINED) require product selection, downstream stations receive bags already in-flight.

### Tests
- Added 5 `numericSuffix` unit tests covering hyphenated, spaced, zero-padded, large, and no-digit cases.
- Added 6 `sortQrRows` tests: "Bag Card N" title-case format, mixed hyphenated/spaced labels, bag-card-101 after bag-card-100, Bag Card 2 before Bag Card 10, bag-card-9 before bag-card-10 (explicit task requirements).

## [0.2.38] — 2026-05-22

### Fixed
- **Floor station typed/camera bag QR now advances the flow (FLOOR-START-5):** At first-op stations (Blister, Handpack Blister, Combined, Bottle Handpack), typing or scanning a bag QR previously resolved the token but then silently returned without submitting or showing the product picker. Root causes: (1) the product picker guard `isReceivedCardSelected` required the card to be in the server-rendered dropdown list — cards not yet visible in the dropdown caused a silent no-op; (2) single-product auto-submit was never wired. Now:
  - Typed/camera scan sets a `resolvedCardId` state that grants the same picker/submit access as a dropdown selection, regardless of whether the card is in the dropdown.
  - When exactly one product is compatible with the scanned bag's tablet type, the form submits automatically without requiring a button click.
  - When multiple products are compatible, the product picker appears immediately after the scan, and "Start production" submits via the programmatic path (not native form submit, which would use the wrong select value).
  - When zero products are configured for the tablet type, the config-error message now fires for scan-resolved cards too.
  - `explicitProductId` parameter added to `submitWithCardId` to avoid the stale-closure problem when auto-submitting before `setProductId` settles.

### Tests
- Added 18 tests covering FLOOR-START-5: structural invariants (resolvedCardId state, hasCardSelected derivation, auto-submit wiring, stale-closure fix), hasCardSelected pure-logic table (6 cases covering dropdown/scan/empty/stale-id paths), and auto-submit trigger conditions (single/multiple/zero product cases).

## [0.2.37] — 2026-05-22

### Improved
- QR Cards admin page is now a compact table instead of tall card rows, dramatically reducing scroll on pages with 100+ cards. Each row shows label + scan token, type badge, status badge, assignment context, and retire action.
- Numeric sort already in place (bag-card-1 … bag-card-200, not lexicographic). Summary tiles condensed to a 4-column grid.
- Search now matches receive name in addition to label, token, receipt #, lot, and product.

### Tests
- Added 3 unit tests for receive-name search in `matchesQrSearch`.

## [0.2.36] — 2026-05-22

### Fixed
- **New Receive PO dropdown regression:** The "New receive" wizard was showing all purchase orders instead of only open/receiving tablet POs. The `is_tablet_po = true` filter was dropped in a prior commit that restructured status filtering. Now uses `and(inArray(status, RECEIVABLE_PO_STATUSES), eq(isTabletPo, true))` matching the raw-bag intake page.
- Added empty-state note below the PO selector when no open tablet POs are available.

### Tests
- Added 9 regression tests in `app/(admin)/inbound/new/page.test.ts` guarding the PO filter: verifies `eq(isTabletPo, true)` present, `notInArray` not used, `RECEIVABLE_PO_STATUSES` referenced, and constant contains only OPEN/RECEIVING.

## [0.2.35] — 2026-05-22

### Fixed
- **Floor station crash (Start Production digest):** `revalidatePath` calls in `scanCardAction` were outside the try/catch; any throw produced a Next.js digest error instead of a user-visible message. Now wrapped in a defensive try/catch. Form action handler also gained a `catch` clause so uncaught server action exceptions show a message instead of the crash overlay.
- **Typed-token submit popup:** Clicking "Start bag" while a bag QR token was typed in the text input (without pressing Enter first) triggered the browser "Please select an item in the list" popup from the required `<select>`. Submit button now calls `handleResolvedToken` when the input is non-empty, bypassing native form validation.
- **Camera HTTPS message:** On HTTP deployments, `navigator.mediaDevices` is undefined (browsers block camera in non-secure contexts). The scanner now detects `window.isSecureContext` and shows "Camera access requires HTTPS — ask your IT team to enable HTTPS, or type the bag QR code manually" instead of the generic "not available" message.
- **Product picker narrowing:** At first-op stations (Blister, Handpack Blister, Combined, Bottle Handpack), the product dropdown now shows only products compatible with the scanned bag's tablet type via `product_allowed_tablets`. Products with no tablet mapping remain visible. Previously showed the full product catalog regardless of tablet type.
- **Auto-select product:** When a scanned bag's tablet type narrows the product list to exactly one option, it is auto-selected.
- Number inputs no longer change value on mouse-wheel scroll. The shared `Input` component now blurs on wheel when `type="number"`, preventing accidental increment/decrement across all admin forms (receiving, products, settings, BOM editor, batches, machines, packaging receipts, etc.).

### Improved
- Sidebar "Pack-out" label renamed to "Production output" to match the page title and reduce ambiguity with packaging materials.
- "Pack-out queue" section label on the Production output page renamed to "Output queue".
- Empty-state message updated from "No bags pending pack-out" to "No bags pending output".

## [0.2.34] — 2026-05-22

### Fixed
- QR conflict error at bag edit now includes receive and bag context: "This QR is already assigned to bag 2 in receive PO-001-R1. Choose another QR or resolve the existing assignment first." Previously showed a generic "assigned to another raw bag" message with no context.
- Receipt number uniqueness is now pre-checked with a friendly error before hitting the database unique constraint. Previously a duplicate receipt number would surface a raw Postgres error.
- Receipt number is now trimmed consistently (both in the uniqueness check and when writing to the database).

### Improved
- Extracted `shouldReleaseQrAtBagEdit` as a testable pure helper (returns true only for intake-reserved cards; never for IDLE, mid-production, or RETIRED cards).

### Tests
- Added 4 unit tests for `shouldReleaseQrAtBagEdit`.
- Added 11 unit tests for `editBagAction` covering weight kg→grams conversion, negative/NaN weight rejection, no-op unchanged fields, notes trim/blank→null, and error propagation.
- Added 8 DB-mocked integration tests for `editInventoryBag` covering: no-op same QR, QR conflict message format (with and without receive name), receipt# conflict, old-QR safe-release (intake-reserved only), and audit write.

## [0.2.33] — 2026-05-22

### Fixed
- Floor station raw-bag picker now shows **only received/intake-reserved bags** — IDLE pool QR cards (not yet linked to any inventory bag) are no longer visible in the dropdown. Previously, unlinked pool cards could appear and confuse operators.
- Scanning an IDLE QR card at a floor station now returns an actionable error: "This bag QR has not been linked to a received bag. Receive the bag first on the Receive Pills page."

### Improved
- Dropdown labels now include full context: QR label · PO number · Bag number · Tablet type · Receipt number (e.g., "B-001 · PO-00238 · Bag 2 · MIT B Green Apple · Receipt #352180").
- Empty state message shown when no received bags are available for the current station: "No received bags are currently available for this station. Use the Receive Pills page to receive bags and assign QR codes."
- Camera scanner now uses the native `BarcodeDetector` Web API on Chrome/Android (faster, no canvas overhead), with jsQR as fallback for Safari/Firefox.

## [0.2.32] — 2026-05-22

### Improved
- Floor station raw-bag picker now filters to bags whose tablet type is compatible with the station's product kinds. A BLISTER/COMBINED/HANDPACK_BLISTER station shows only CARD/VARIETY-compatible bags; BOTTLE_HANDPACK stations show only BOTTLE/VARIETY-compatible bags. Reduces the dropdown from ~200 items to the relevant subset. Cards with no linked inventory bag remain visible as a safety fallback.

## [0.2.31] — 2026-05-22

### Changed
- Receive detail bags table: added **Bag #** as the first column, showing the per-box bag ordinal operators use in the field (e.g., Bag 1, Bag 2). Receipt # retained alongside it.
- Receive history table: column renamed from "Tablet type" to "Tablet / Flavor". Multi-flavor receives now show "First Flavor + N more" instead of the raw comma-separated list.

### Improved
- QR card management: ASSIGNED raw-bag cards now show full assignment context — receive name, bag ordinal, receipt #, and tablet type (e.g., "Reserved at receive · PO-00238-R1 · Bag 2 · Receipt # 352180 · MIT B Green Apple"). Fallback "Assigned — no bag context found" for cards where the intake bag link is missing.

## [0.2.30] — 2026-05-22

### Fixed
- Product dialog no longer overwrites assembly Zoho IDs (`zohoItemIdUnit`, `zohoItemIdDisplay`, `zohoItemIdCase`) when saved — fields absent from the form are now skipped rather than nulled.
- Assembly mapping form pre-fills the unit Zoho ID field from the product's existing `zohoItemId` when the dedicated unit ID is not yet set, so operators aren't asked for the same value twice. Shows a "Pre-filled from product Zoho item ID. Save to confirm." hint.
- Saving the assembly mapping form now back-syncs `zohoItemId` (commercial trace column) from `zohoItemIdUnit`: syncs when <= 60 chars, clears when > 60 chars (to prevent stale divergence), clears when unit ID is cleared.

## [0.2.29] — 2026-05-22

### Fixed
- FLOOR-START-3: Added `BOTTLE_HANDPACK` to `FIRST_OP_STATION_KINDS`. Bottle hand-pack is a first-operation station — fresh bag scans now require product selection there, consistent with the existing floor UI behavior.
- `scanCardAction` server-side guard: rejects fresh-bag starts at downstream stations (SEALING, PACKAGING, BOTTLE_CAP_SEAL, BOTTLE_STICKER). Previously only the floor UI enforced this; a crafted POST could bypass it.
- Admin `startProductionForRawBagAction` now rejects non-first-op stations with a clear error message.
- Admin Start Production station dropdown now filters to first-op stations only (BLISTER, HANDPACK_BLISTER, BOTTLE_HANDPACK, COMBINED).

### Added
- Floor station page: context-aware no-bag message for downstream stations ("accepts bags released from a prior stage") and inline hint when no eligible pickups exist ("scan the bag QR when it arrives").
- Idle card dropdown placeholder updated to "Select a received bag QR…"; optgroup updated to "Received bags".
- Receives list: new Tablet type column shows distinct tablet type names for each receive (e.g. "MIT B Orange Citrus"), making multiple receives for the same PO distinguishable.

<!-- FUTURE: Machine vs station model cleanup
  Machines are physical equipment with output/cycle characteristics.
  Stations are floor scan locations / URLs.
  Hand-pack stations should probably be stations, not machines, unless
  they need machine-like output config. There is visible duplication on
  the Machines & stations admin page. This needs a future cleanup task.
-->

## [0.2.28] — 2026-05-22

### Added
- FLOOR-START-2: camera QR scanning via jsQR — "Open camera" button next to the scan input opens a modal that uses `getUserMedia` (rear-camera preferred), decodes frames via `jsQR` in a `requestAnimationFrame` loop, and fires the same `lookupCardByTokenAction` + `submitWithCardId` path as the typed-input scanner. Degrades gracefully if the Camera API is unavailable or permission is denied.
- Idle card dropdown now shows secondary info: internal receipt number and tablet type name (via LEFT JOIN to `inventory_bags` + `tablet_types`).
- Eligible-pickup dropdown now shows product SKU alongside bag stage (via LEFT JOIN to `workflow_bags` + `products`).

### Changed
- Dropdown placeholder updated from "Select an available bag QR…" to "Select an eligible bag QR…".
- Dropdown groups: idle cards group is "Start a new bag" when pickups are also present; pickup group is "Pick up released bag (same QR continues)".
- Helper text added above dropdown: "Scanning the physical bag QR above is preferred. Use the dropdown only as a backup."
- Submit button now reads "Start production" when the product picker is visible; "Start bag" otherwise.
- Installed `jsqr@1.4.0` as a runtime dependency.

## [0.2.27] — 2026-05-22

### Added
- FLOOR-START-1: floor station scanner now has a text input for wedge scanners. Typing or scanning a QR label token and pressing Enter validates the card via `lookupCardByTokenAction` and either starts the bag immediately or, at first-op stations requiring a product pick, populates the card selector and shows the product picker.
- `lookupCardByTokenAction` server action: resolves a physical QR scan token to a card ID with inline validation (not-found, wrong card type, retired card). Full eligibility check (stage, station kind) is deferred to `scanCardAction`.

### Changed
- `idleCards` query in `FloorStationPage` now filters to `cardType = 'RAW_BAG'` only. VARIETY_PACK, WORKFLOW_TRAVELER, and UNKNOWN cards no longer appear in the bag selector dropdown.
- `idleCards` now sorted numerically by label (bag-card-1, bag-card-2, …, bag-card-200) via `localeCompare({ numeric: true })`.
- Idle card picker is no longer shown at pickup-only stations (SEALING, PACKAGING, BOTTLE_CAP_SEAL, BOTTLE_STICKER). Only stations that can start fresh bags (BLISTER, HANDPACK_BLISTER, BOTTLE_HANDPACK, COMBINED) receive idle card options.
- `scanCardAction` now rejects non-RAW_BAG cards on the fresh-scan path: "Only bag QR cards (RAW_BAG type) can be used to start production."
- Floor scanner dropdown placeholder updated from "Pick an idle card…" to "Select an available bag QR…".
- Floor scanner submit button text updated from "Scan card" to "Scan bag QR".
- No-bag copy updated from "Scan a card to begin" to "Scan a bag QR or select one below."
- Idle cards optgroup label updated from "Idle cards" to "Available bag QRs".

### Tests
- 9 new tests in `scan-card-form.test.ts`: `lookupCardByTokenAction` invariants — empty token, not-found, VARIETY_PACK, UNKNOWN type, RETIRED status, valid IDLE RAW_BAG, valid intake-reserved ASSIGNED RAW_BAG, valid ASSIGNED pickup RAW_BAG, whitespace trimming. Total: 2228 tests.

## [0.2.26] — 2026-05-22

### Added
- VARIETY-2b: migration `0044_variety_qr_card_fk.sql` adds `variety_qr_card_id UUID REFERENCES qr_cards(id) ON DELETE SET NULL` to `variety_runs`. Backfills existing rows by matching `parent_scan_token` to `qr_cards.scan_token` where `card_type = 'VARIETY_PACK'`. Unmatched legacy rows remain null.
- `varietyQrCardId` field on `varietyRuns` Drizzle schema with partial index `variety_runs_qr_card_idx`.

### Changed
- `startOrResumeVarietyRunAction` now stores `varietyQrCardId = qrCard.id` when opening a new variety run, linking the run to the physical QR card record via FK.
- `closeVarietyRunAction` now prefers `varietyQrCardId` (FK path) for the QR release lookup; falls back to `parentScanToken` text scan for legacy rows where FK is null. Backward compatible.
- `variety_runs.parentScanToken` JSDoc updated: kept for display and legacy fallback; FK integrity now via `varietyQrCardId`.

### Tests
- 2 new tests in `variety-run-actions.test.ts`: "stores varietyQrCardId in the new run row" (verifies FK stored at insert via captured mock values), "uses varietyQrCardId (FK) to look up QR card when available" (verifies FK-preferred close path). Total: 2224 tests.

## [0.2.25] — 2026-05-22

### Fixed
- VARIETY-2a: `startOrResumeVarietyRunAction` now validates the parent scan token against `qr_cards`: rejects blank tokens, tokens not in the card pool, non-VARIETY_PACK card types, and RETIRED cards. On new run creation, the VARIETY_PACK card must be IDLE and is atomically set to ASSIGNED. On resume, the existing open run is returned without changing QR state.
- VARIETY-2a: `closeVarietyRunAction` now releases the parent VARIETY_PACK QR card back to IDLE inside the close transaction. Writes `VARIETY_QR_RELEASED` audit entry. Handles legacy runs with no QR card record gracefully (writes `VARIETY_QR_RELEASE_SKIPPED_LEGACY` audit, does not crash).
- VARIETY-2a: `closeAllocationSessionAction` now releases the source bag's RAW_BAG QR card to IDLE when the bag becomes EMPTIED (`endingBalanceQty = 0`). Writes `RAW_BAG_QR_RELEASED` audit entry. No release for partial bags (`endingBalanceQty > 0`) or non-RAW_BAG card types.
- VARIETY-2a: `markBagDepletedAction` now releases the source bag's RAW_BAG QR card to IDLE. Writes `RAW_BAG_QR_RELEASED` audit entry.

### Added
- 17 new unit tests: 12 in `variety-run-actions.test.ts` (QR validation and release scenarios) and 4 in new `bag-allocation-actions.test.ts` (RAW_BAG QR release for partial/depleted/wrong-type cases).

### Changed
- No DB migrations. All changes are code-only (VARIETY-2a minimum safe phase).

## [0.2.24] — 2026-05-22

### Added
- Variety parent/child QR workflow audit (VARIETY-1): documented two critical gaps — (1) `startOrResumeVarietyRunAction` accepts any string as `parentScanToken` with no `qr_cards` lookup; (2) VARIETY_PACK QR cards are never released because variety source bags have no `workflow_bag` and `BAG_FINALIZED` never fires. Chosen fix approach (VARIETY-2): code-only validation first (no migration), then optional `varietyQrCardId` FK on `variety_runs`.
- `docs/backlog.md` updated with VARIETY-1 findings: gap descriptions, chosen approach (Option B), minimum safe implementation phase, and known risks.

## [0.2.23] — 2026-05-22

### Added
- Available Partial Bags page (`/partial-bags`): shows AVAILABLE raw bags that have been through ≥1 production run, with remaining estimate, last used product/date, and a Start run link. No new DB status — derived from `rawBagAllocationSessions` ledger.
- `loadAvailablePartialBags()` DB query + `isAvailablePartialBag`, `hasOpenAllocationSession`, `deriveRemainingEstimate` pure helpers in `lib/production/partial-bags.ts`. 20 unit tests covering all spec cases.
- "Available Partial Bags" link added to Operations section of sidebar (after "Start production").

### Changed
- Start Production now blocks a bag if it has an OPEN allocation session (belt-and-suspenders guard — AVAILABLE status already blocks IN_USE bags, but this provides an explicit error message for any edge case).

## [0.2.22] — 2026-05-22

### Added
- `npm run verify:deploy` script (`scripts/verify-deploy.ts`): calls `/api/health` on the deployed host, compares the baked-in SHA against local `git rev-parse HEAD`, and reports whether the deploy is current. Host defaults to `http://192.168.1.134:3000`; override with `LUMA_HOST=<url>`.
- `docs/versioning.md`: documents the `0.MINOR.PATCH` version scheme, when to bump, the step-by-step bump procedure, how the systemd deploy timer works, and how build metadata (SHA/branch/date) reaches the footer.

### Changed
- Confirmed v0.2.21 container running after deploy completed (07:31 UTC). `BUILD_GIT_SHA` and `BUILD_GIT_BRANCH` now populate correctly in deployed containers — fix from CAPACITY-1 deploy-service update is confirmed working.

## [0.2.21] — 2026-05-22

### Changed
- "Purchase orders" tab in Receives/Inbound renamed to "Receives" to reflect that it shows receive history, not PO master records.
- "Receives" page (`/inbound`) title and description updated to match.
- Sidebar "Pack-out" nav entry renamed to "Production output" to match page title and avoid confusion with packaging materials.
- `/packaging-output` page title and per-bag breakdown section header renamed from "Packaging output" to "Production output".
- Zoho Operations page description now explicitly states "Dry-run validation only — live writes are disabled."
- Sidebar test updated to assert "Production output" label (was "Pack-out").

## [0.2.20] — 2026-05-22

### Changed
- QR Card Management: cards now sorted numerically (bag-card-1, bag-card-2, …, bag-card-49, …, bag-card-200) instead of lexicographically. Sort priority: RAW_BAG → VARIETY_PACK → WORKFLOW_TRAVELER/UNKNOWN.
- QR Card Management: search now matches receipt number and supplier lot in addition to label and scan token.
- QR Card Management: assigned-to display now shows clear "Active workflow" or "Reserved at receive" labels with context instead of bare truncated IDs.
- QR Card Management: print labels page now only prints idle RAW_BAG cards, matching the "Print idle raw bag labels" button label. Previously printed all idle cards regardless of type.

### Added
- `sortQrRows` and `matchesQrSearch` pure helpers in `lib/production/qr-sort.ts`. 19 unit tests.

## [0.2.19] — 2026-05-22

### Changed
- Start Production no longer asks the operator to select a QR card. The raw bag's QR card — reserved at receiving — is identified automatically from the bag's `bagQrCode` and activated when production starts. The "Confirm QR card" step is removed; Step 4 is now a single "Start run" button.
- Start Production page no longer queries or displays the idle/intake-reserved QR card count badge.
- Start Production server action now auto-derives the QR card from `qrCards.scanToken = bag.bagQrCode` instead of accepting a `qrCardId` input parameter.

### Added
- Comprehensive QR validation in `startProductionForRawBagAction`: explicit errors for no QR on bag, card not found, wrong card type, retired card, card already assigned to active workflow.
- `validateRawBagQrForStart` pure helper in `lib/production/start-production.ts`. 11 unit tests.

## [0.2.18] — 2026-05-22

### Changed
- Admin footer now shows accurate build metadata: SHA field shows "local" in dev (was "dev"); branch is always shown when deployed (was suppressed for main); BUILD_AT "unknown" is suppressed instead of displayed.
- Production Capacity page rows now sorted: rows with any meaningful inventory data (tablets on hand, runnable units/displays/cases > 0) appear first, rows with all-zero data appear last. Within each group, alphabetical by product name.

### Added
- `hasCapacityData` and `sortCapacityRows` pure helpers in `lib/production/capacity.ts`. 14 unit tests covering all sorting and data-presence edge cases.

## [0.2.17] — 2026-05-22

### Changed
- Start Production flow reordered: step 2 is now "Pick station" (moved from step 4). Product selection (step 3) uses the station type to narrow candidates before the operator sees them.
- Start Production: when the station type unambiguously resolves the product (exactly one CARD product for a CARD station, or exactly one BOTTLE product for a BOTTLE station), the product is auto-selected and shown as a read-only confirmation. The operator never sees the picker.
- Start Production: when multiple products remain after station filtering, only the compatible products are shown (e.g. only CARD products at a BLISTER station). If a station/product kind mismatch is detected (config error), a warning is shown alongside the full fallback list so production is never blocked.
- Start Production: COMBINED stations and unknown station types show all configured products without filtering.

### Added
- `resolveStartProductionProduct` pure helper in `lib/production/start-production.ts`. Station→product-kind mapping: BLISTER/SEALING/PACKAGING → CARD; BOTTLE_HANDPACK/BOTTLE_CAP_SEAL/BOTTLE_STICKER → BOTTLE; COMBINED → no filter. Returns `auto | choose | config_error` discriminated union. 19 unit tests.
- `docs/backlog.md` updated with two Start Production notes: server-side station/product validation and COMBINED station product grouping.

## [0.2.16] — 2026-05-22

### Added
- Receive Pills bag rows table now shows inline QR validation state without requiring a save attempt:
  - Red border + "Duplicate in this receive" label when the same QR token appears in two or more rows.
  - Amber border + "Not in idle RAW_BAG pool" label when a manually-entered token is absent from the IDLE RAW_BAG pool (covers: non-existent tokens, wrong card type, retired cards, and already-assigned cards).
  - Save button is disabled when any row has a duplicate QR conflict (hard error). Not-in-pool rows show a warning but do not block save — the server transactional validation remains authoritative.
- `validateQrTokens` pure helper added to `lib/production/raw-bag-intake.ts`. 11 unit tests covering all states and edge cases.
- `docs/backlog.md` updated with: README.md needed, architecture diagram needed (with full scope), QR Card Management table redesign note.

## [0.2.15] — 2026-05-22

### Fixed
- Bag edit QR reassignment: WORKFLOW_TRAVELER and UNKNOWN card types are now rejected with "Only RAW_BAG cards can be assigned to raw bags." Previously only VARIETY_PACK was explicitly checked.
- Bag edit QR reassignment: a card that is intake-reserved (ASSIGNED + null workflow bag) but already linked to a *different* inventory bag is now rejected with "This QR card is already assigned to another raw bag." Previously the DB unique index would catch the collision with a cryptic error message.

### Changed
- Receive detail page summary sidebar now shows aggregate "Weight (kg)" total across all bags that have a recorded weight.
- `validateQrCardForRawBag` extracted as an exported pure helper in `lib/db/queries/bag-edits.ts`. 7 unit tests added.

## [0.2.14] — 2026-05-22

### Added
- Receive detail page (`/inbound/[id]`): bags table below the boxes card. Columns: bag #, receipt number, QR code, supplier lot, weight (kg), status chip. Each row has an "Edit" link to the bag edit page.
- Bag edit page (`/inbound/[id]/bag/[bagId]/edit`): safe post-save edits for weight, notes, internal receipt number, QR code, and supplier lot. Sensitive field changes require an edit reason. Bags currently in production are locked to notes-only.
- QR card reassignment at bag edit: transactionally releases the old intake-reserved card to IDLE and assigns the new card. Validates that new cards are not RETIRED, not VARIETY_PACK, and not active in production. Both changes are written to the audit log.
- `validateBagEditFields` pure helper with 14 unit tests covering all guard conditions.
- Receive pills page: PO line cards now show local Luma receive counts alongside the PO quantity. Shows "Receiving" (active form), "N bags · N rcvs" (prior receives), or "None yet".
- Receive pills success panel: "View receive" primary button links directly to the new receive detail page.

## [0.2.13] — 2026-05-22

### Changed
- Start Production: step 3 renamed from "Assign a workflow QR card" to "QR card". Subtitle now explains that the QR card was reserved at receiving and is pre-selected automatically. All misleading "reusable floor badge" / "workflow QR" copy removed.
- Start Production page header: updated description to reflect the receive-first flow.
- Start Production step list: "Assign QR card" → "Confirm QR card".
- Start Production success panel body: updated to "The QR card is now active on this bag."

### Fixed
- Start Production: VARIETY_PACK cards are now excluded from the QR card dropdown and rejected by the server action with error "Variety pack cards cannot be used for raw bags."
- Receive pills page: "Receive another batch" button now resets all form state and calls `router.refresh()` so the QR card pool reflects the newly-assigned cards. Previously, soft navigation to the same route left stale client state.
- Receive pills page: "Start production" button in the success panel now links to `/production/start` (was incorrectly `/qr-cards`).
- Receive pills page: all `type="number"` inputs now blur on mouse-wheel scroll to prevent accidental value changes.

### Added
- QR Card Management: ASSIGNED cards now show contextual "Assigned to" information. Intake-reserved cards (ASSIGNED, no workflow bag yet) show "Assigned at intake: {receipt} · lot {supplier_lot}". Active production cards continue to show the workflow bag ID and product name.
- `docs/backlog.md`: backlog items captured for post-save editing, PO line status, Shipments rename, Production output rename, QR UX cleanup.

## [0.2.12] — 2026-05-21

### Fixed
- Receive pills page: Zoho readiness banner no longer shows `NEEDS_REAUTH` from the old direct-OAuth gateway. Readiness is now based solely on whether `ZOHO_SERVICE_BEARER_SECRET` and `ZOHO_SERVICE_BASE_URL` (or `ZOHO_INTEGRATION_URL`) are configured. Three-tier banner: "not configured" / "synced data available" / "no tablet POs yet".
- `validateAssemblyServiceConfig` now accepts `ZOHO_SERVICE_BASE_URL` as the preferred env var name, with `ZOHO_INTEGRATION_URL` as a backward-compatible fallback. Existing `.env` files using `ZOHO_INTEGRATION_URL` continue to work without changes.
- Dead `zohoReadiness` prop removed from `RawBagIntakeForm` (was received but never used).

## [0.2.11] — 2026-05-21

### Fixed
- Sidebar tests: updated 20 stale expectations from `1ce88c1` Settings hub restructure. Section names updated to "Operations" / "Oversight" / "Configure"; labels updated ("Pack-out", "Workflows", "Find lot / batch"); removed routes no longer in sidebar (/qr-cards, /standards, /workflow-validation, /settings/users); invoice allocations and Workflows placement assertions corrected. All 2093 tests pass.

## [0.2.10] — 2026-05-21

### Changed
- Raw bag intake PO sync now uses tablet-filtered endpoint (`?luma_tablet_only=true`). Only tablet POs are synced, stored, and shown in the intake dropdown.
- Intake PO dropdown badge updated to "N tablet POs" (was "N open/receiving POs").
- Sync banner: "Synced N tablet POs · N details · N lines" with anomaly flag count when any POs lack the `is_tablet_po` flag.

### Added
- `is_tablet_po` boolean column on `purchase_orders` (migration 0042, additive nullable). Set to `true` for all POs from the tablet-filtered endpoint; old POs remain null and are excluded from raw bag intake.
- `extractIsTabletPo()` pure helper in `inventory-service-client.ts` — reads `app_flags.luma.is_tablet_po`.
- `tabletOnly: boolean` option on `listInventoryPurchaseOrders()` — appends `?luma_tablet_only=true`.
- `nonTabletFlagged` counter in `PoSyncResult` — counts contract anomalies (POs from filtered endpoint without the flag set to true).
- 13 new unit tests: tabletOnly URL routing, extractIsTabletPo semantics, tablet-filtered po-sync behavior (2096 total).

## [0.2.9] — 2026-05-21

### Added
- Raw bag intake: per-row supplier lot number column. Each generated bag row inherits the setup-level supplier lot; operators can override individual rows before saving. Rows with a lot that differs from the setup lot get an amber highlight.
- Multi-batch intake: when rows have different supplier lot numbers, a separate `batches` row is upserted per unique lot. Each `inventory_bag` links to its lot's batch. No schema migration required.
- 8 new unit tests: `generateBagRowSeed` lot seeding + trimming + default; Zod schema per-row lot acceptance/rejection; `preflightRawBagIntake` row mapping (2083 total).

## [0.2.8] — 2026-05-21

### Fixed
- Zoho readiness banner: three-tier status model. Offline Zoho with local POs shows neutral "Using synced PO data from Luma" info message instead of alarming warning. Warning only appears when Zoho is offline AND no local POs exist.
- PO dropdown: removed `[OPEN]`/`[RECEIVING]` status tag from main option label — PO number + vendor is sufficient.
- Helper copy: "Pick a PO to choose the tablet line item being received." (was: "Pick a PO to see its line items as receive cards.")
- Zero-line empty state: improved copy — now mentions all three resolution options (sync, different PO, manual reference).
- Stale server action: `handleSave` and `SyncPoButton` now catch thrown errors and show "App updated — please refresh" instead of hanging indefinitely.

### Added
- Raw bag intake: per-row Remove (x) button. Removing an unsaved row frees its QR code from the pending submission; pool exhaustion warning updates automatically.
- Start Production: when a raw bag is looked up and has a QR card reserved at intake, that card is auto-selected in the QR picker and labelled "QR card assigned at intake for this bag." If the reserved card is unavailable, a warning is shown.
- 6 new QR edge-case unit tests: 10-row unique assignment, row removal QR freeing, pool exhaustion threshold, empty-pool null-fill (2072 total).

### Removed
- Section 3 bag rows title no longer shows duplicate "(N generated, N unsaved)" — now shows just the current count.

## [0.2.7] — 2026-05-21

### Added
- Raw bag intake: "Declared total" field replaces "Declared count per bag" — enter the total count across all bags; it is distributed evenly (remainder to first bags) via `distributeDeclaredTotal`.
- Raw bag intake: QR code auto-assignment from available `RAW_BAG IDLE` pool when generating rows (`assignQrCodesFromPool`). If the pool is smaller than the bag count, remaining rows have null QR and a warning banner is shown.
- Raw bag intake: weight per row entered in kilograms (stored as grams in DB). Column header changed to "Weight (kg)".
- Raw bag intake: QR cards are atomically reserved (`status = ASSIGNED`, `assignedWorkflowBagId = null`) within the same transaction as bag creation. Validation rejects non-RAW_BAG, non-IDLE, and unknown cards. Audit log entries written per reserved card.
- QR lifecycle: ASSIGNED+null workflowBagId is now treated as "intake-reserved" across floor scanner (`page.tsx`, `actions.ts`) and admin production-start (`page.tsx`, `actions.ts`), so intake-reserved cards proceed to production without requiring a status reset.
- `retireQrCard` now allows retiring intake-reserved (ASSIGNED+null workflowBagId) cards; only genuinely mid-production cards are blocked.
- `revalidatePath("/qr-cards")` added to `createRawBagIntakeAction` so QR Card Management immediately reflects reserved cards after a successful receive.
- 11 new unit tests: 6 for `assignQrCodesFromPool` (pool assignment, partial pool, empty pool, no-mutation) + 5 for kg/grams conversion contract.

### Removed
- "Default weight per bag (grams)" field from Supplier lot setup section — weight is now entered per-row in kg.

## [0.2.6] — 2026-05-21

### Added
- QR card type classification: new `qr_card_type` enum (`RAW_BAG`, `VARIETY_PACK`, `WORKFLOW_TRAVELER`, `UNKNOWN`) and `card_type` column on `qr_cards` (migration 0040). Existing cards with `bag-card-*` tokens are backfilled to `RAW_BAG`; `variety-pack-*` tokens to `VARIETY_PACK`.
- `scripts/repair-qr-inventory.ts` — idempotent script to seed physical card inventory: bag-card-1..200 (RAW_BAG) + variety-pack-1..5 (VARIETY_PACK). Run via `npm run repair:qr-inventory`.
- QR validation helpers in `lib/db/queries/qr-cards.ts`: `listAvailableRawBagQrCards`, `listAvailableVarietyPackQrCards`, `getNextAvailableRawBagQrCard`, `validateQrCardUsableForRawBag`, `validateQrCardUsableForVarietyPack` — each enforces type + status eligibility rules with exact rejection reasons.
- 14 unit tests for QR card validation helpers.

### Improved
- QR Card Management UI: per-type summary tiles (Raw bag / Variety pack), new filter tabs (All / Raw bag / Variety pack / Assigned / Idle / Retired / Unknown), type badge on each row, scan token shown in row, search includes scan token, print button scoped to idle raw bag cards.

## [0.2.5] — 2026-05-21

### Fixed
- PO line sync: `upsertLines` now skips lines whose Zoho status is `received`, `not_receivable`, or any unknown value. Only `to_be_received` and `partially_received` lines are inserted/updated in `po_lines`.
- Sync POs banner now shows full detail: "N POs · N details · N lines synced" so operators can confirm detail fetches and line upserts at a glance.

### Added
- TODO comment in po-sync.ts marking where `is_tablet_po` scoping will plug in once Zoho Integration exposes the normalized field.

## [0.2.4] — 2026-05-21

### Fixed
- PO sync now fetches line items: `syncPurchaseOrdersFromZoho()` calls the Zoho detail endpoint for every OPEN/RECEIVING PO and upserts `po_lines` rows keyed on `zohoLineItemId`. Lines auto-match to local `tabletTypeId` via `tablet_types.zoho_item_id`; unmatched lines store the Zoho item name + id in `notes`. Sync result now reports `lineUpserted`, `lineSkipped`, and `detailsFetched`.
- Raw-bag intake: empty-state message now directs users to the Zoho sync button rather than the inbound page.

## [0.2.3] — 2026-05-21

### Improved
- Packaging output page: MetricCard now supports `variant="light"` for the admin UI. All metric cards on the Packaging output page now use white/light-surface cards with proper contrast instead of dark `bg-slate-900` tiles. Floor-board MetricCards unchanged (still `variant="dark"` by default).
- Packaging output page: "Unknown" product label replaced with muted "—" dash in queue tables.
- Packaging output page: Added conditional note in queue section header when product name is blank (bag not yet mapped via PRODUCT_MAPPED event).
- Packaging output page: Removed spurious italic from empty-state text and null dash spans.

## [0.2.2] — 2026-05-21

### Added
- Zoho Integration inventory read client (`lib/zoho/inventory-service-client.ts`) — four GET functions: list purchase orders, get PO detail, search items, list warehouses. Injectable env/fetchImpl/timeoutMs; 32 tests.
- PO sync service (`lib/zoho/po-sync.ts`) — `syncPurchaseOrdersFromZoho()` upserts `purchase_orders` from Zoho via SELECT-then-INSERT/UPDATE. Terminal-status guard (RECEIVED/CLOSED/CANCELLED rows never downgraded). Duplicate zohoPoId guard. 17 tests.
- Receive-eligible status mapping: Zoho `issued`→`OPEN`, `partially_received`→`RECEIVING`, `received`→`RECEIVED`, `draft`→`DRAFT`, `cancelled`→`CANCELLED`.
- Admin sync action (`syncPurchaseOrdersFromZohoAction`) on the raw-bags receiving page — admin-gated, revalidates PO list on success.
- "Sync POs from Zoho" button in the raw-bags badge strip — shows fetched/upserted counts and errors inline.

## [0.2.1] — 2026-05-21

### Fixed
- PO dropdown in raw bag intake now sorts newest-first (`openedAt` desc) so most recent POs appear at the top.

### Improved
- PO option labels include vendor name and status badge for clarity.
- Badge strip shows count of open/receiving POs and a hint that draft/closed/cancelled POs are hidden.

## [0.2.0] — 2026-05-19

### Fixed
- PO dropdown in raw bag intake now filters out CLOSED and CANCELLED purchase orders.
- Machines & stations page: renamed "Cards / turn" column to "Units / cycle" to be accurate across all machine kinds (blister, bottle, sticker, sealing, packaging).

### Improved
- QR cards management: added status breakdown stat tiles (idle / assigned / retired counts), live search by label or UUID, and status filter tabs.
- Finished lots genealogy section: improved table layout and readability.
- Reports page: material burn section visual improvements including totals row.
- Admin footer: now shows semver version (`v0.2.0`) alongside git SHA and build date.

## [0.1.0] — 2026-05-18

Initial live-testing release.
