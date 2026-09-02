# Luma simplify

What to change to make Luma simpler, smoother, and more efficient.
Source: live closeout of **PO-00206** (CamDex LLC) at `/po-closeout/d403f04a-fe34-4417-be5f-e6c172b1e7b7` on 2026-09-01.
Focus: extra clicks for small tasks, steps that should be automated, and flows that are too complicated.

Session outcome (for context, not a product change):
- PO-00206 (CamDex LLC): 55 bags, 40 with production, 37 lots issued. Did not push Zoho.
- Advanced this session to pre-Zoho: 352298, 352305, 352309, 6337-26, 6337-35, 352311 (QC-released with system over-consumption numbers), 352284 (lot issued from packaging counts 9c/21d/1 loose).
- 15 no-production bags left untouched. 32 bags already at Zoho-not-ready left. 3 failed-Zoho (352283, 352289, 6337-38) left. 1890-29 already Zoho committed.
- Cannot finish without operator/floor or inventing data: **6337-46** (packaging counts exist, remaining off by 128, lot issue blocked because derived starting balance is 0 — `finished_lot.auto_create_blocked`); **352286** and **6337-41** (on floor, sealing counts only, no packaging output; "Finalize workflow" is not a real link).
- Other active POs (12 total; 9 have 0 bags):
  - **PO-00258** TOPC, 4 bags — all on floor (sealing counts only). Closed allocation on 352053 via Use calculated remaining. No lots issued.
  - **PO-00252** TOPC — 352267 released to Zoho-ready (not queued; over-consumed 9384 rcv / 10516 prod). 352266 blocked: product missing tablets-per-unit, shelf life, packaging structure (`finished_lot.auto_create_blocked`). 352265 zero production, left.
  - **PO-00238** TOPC, 24 bags — 352176 QC-released to Zoho-ready. 3 zero-tablet left (352181, 352186, 352189). 20 already at Zoho gate (11 mapping-not-ready, 8 ready-to-queue, 1 committed).

---

## Too many clicks

- **Close a PO is not one action.** 55 bag/receipt rows, each with its own checklist. Operator walks bags one by one instead of "close this PO."
- **Primary CTA is a 54-step guided wizard** ("Close this PO (54 steps)") that is the same "Zoho not ready" state 51 times. That should be one bulk action, not 51 screens.
- **After the floor is done, two more Luma gates remain** before Zoho even enters the picture: Issue finished lot → Released/held. Bags were already 99% complete with "balances derivable from production output."
- **Login is 3+ screens** before any work: Luma login card → Authentik identifier → Authentik password (and possibly MFA).
- **SSO is an extra click plus a full page load** onto a second branded site. If SSO is the real path, it should be the only button (or auto-start).
- **Seeing remaining work takes extra tab clicks.** Default Ready-actions (often 0) hides 51 review + 3 blocked. Operator has to click Needs review to see almost all of the PO.
- **Disabled "Queue for Zoho" has no inline why.** Reason ("needs mapping") is only visible after expanding the row — extra click for an explanation, not an action.
- **Checklist is 4 green ticks + 1 red X with no single "fix this" button.** The fix deep-links out to `/zoho-production-operations` and drops closeout context, so getting back is more clicks.
- **Expanding a row is ~4 interactions for one action.** First click often registers nothing, second expands, then "Loading live bag detail…" for several seconds, then the action button appears. Two auto-issue bags took ~15 clicks. Put a single inline "Issue lot" on the row.
- **Idle auto-redirect to `/floor-board` after ~30–60s** kills in-progress closeout and stale-s every control. Do not steal a working screen.
- **"Issue finished lot" and "Finalize workflow (on floor)" look like links but are inert `<span>`s** (no href, no click). Operator has to manually open `/finished-lots/new` or Workflows and re-find the bag. Biggest single time sink on 206.
- **"Open workflows" dumps an unfiltered 85-row list**; search for bag 352286 still returned all 85 rows. Deep-link to the bag, or filter the list.
- **9 of 12 "Active POs" have 0 bags.** Each still needs a click to learn they're empty. Hide/collapse zero-bag POs or show "nothing to do" inline.
- **QC hold → release is two buttons** on the lot page (Clear hold, then Approve & release) with a reload between them. One "Release lot" (reason optional) would halve the clicks.

## Automate

- **Honor post-login `next=`.** Signing in from a closeout URL currently dumps the operator on `/dashboard`. Return them to the PO.
- **Skip / hide 0-tablet bags by default.** Bags with no production should not sit in the closeout worklist as if they need action. (This session had to be told to leave them.)
- **Auto-issue is fully deterministic** (uses packaging counts already in the system, no input). Fire on BAG_FINALIZED, or at minimum offer "Issue all finalized lots." Two bags should not take ~15 clicks.
- **Guided wizard must pre-filter empty/floor-blocked bags.** It currently walks 0-production bags one at a time (11+ skips). "Skip for now" sometimes exits the whole wizard; `?guided=1&step=N` redirects back to the list.
- **Auto-release/hold when lot issue succeeded** unless there is a real QC exception. Don't make "Released/held" a separate tap on a clean 99% bag.
- **Bulk-handle identical states.** 51 bags in the exact same "Released — Zoho op needs setup/review before queueing" state should be one PO-level action (or one mapping), not 51 reviews.
- **Don't offer Queue for Zoho until mapping exists.** Showing a disabled queue button 51 times is noise; show "map this SKU once" at PO or product level.
- **Auto-clear starting-balance / consumption review** when received, produced, and remaining are all present and consistent.
- **"Use calculated remaining" is purely derived** and should be bulk-applied per PO, not one bag at a time (PO-00258).
- **Suggested QC reasons** for over-consumption / release-lot (overpack, recount, waste, etc.) so a tablet operator is not writing a novel. Free-text with no defaults blocked 352311 until we reused the system's own numbers.
- **Repair-allocation form pre-fills packaging output correctly then refuses to submit** because a derived read-only Starting balance is 0. Error is a generic "Number must be greater than 0" next to the button with no field named (6337-46). The repair exists because the ledger is missing — allow submit, or name the field.

## Too complicated

- **Two login methods on one card** (SSO vs email/password) with no tablet-operator default. Pick one path for the floor.
- **Password placeholder of dots (`••••••••`)** looks like a saved password is already entered.
- **Authentik screen does not look like Luma** (orange, stock mountain photo vs teal Production Command). Operators will think they left the app.
- **Guided closeout URL (`?guided=1&step=0`) renders a blank white page** and times out. The wizard is unusable, but it is the primary CTA and **auto-reopens over the list view**, requiring repeated X-out. If guided mode is broken, don't deep-link into it and don't auto-reopen it.
- **"Ready actions (0)" while 51 items still need a human** is misleading naming. Ready should mean "what still needs a person on this PO," or the default tab should be Needs review.
- **Six blocker types stacked in one banner** (Zoho setup, unprocessed receipts, in-progress runs, failed Zoho ops, starting-balance review, open allocation session) with no single next tap. Collapse to one recommended action.
- **Per-bag checklist mixes floor state, lot issuance, hold/release, and Zoho** on one row. Split "finish production" from "push to Zoho" so closeout can stop before Zoho without hunting.
- **Failed Zoho ops sit in Blocked** mixed with real floor blockers (open allocation, over-consumption). Zoho retry is a different job than "this bag isn't done."
- **Over-consumed bags** (352311: 20,300 vs 20,000; 352284: 19,684 vs 16,783) require free-text QC / receipt review with no suggested defaults that use the numbers already on screen.
- **Wizard step 1 offers 6 competing actions** (Use calculated / Correct remaining / Mark depleted / Use calculated remaining / Open full workbench / Admin correction) on bags whose banner says "nothing for an admin to fix here." Blank/no-op steps should not show an action panel.
- **Issuing a lot moves a bag from Ready → Needs review** (because Zoho mapping is next), so tab counts make progress look like regression (49→51). Put Zoho-only items in a "Waiting on Zoho" bucket, not Needs review.
- **~43 of ~51 review rows are the identical reason** "Released — Zoho op needs setup/review before queueing." One bulk "fix Zoho mapping" replaces ~43 visits.
- **Too many axes on one screen:** 5 checklist gates + 3 blocker types + 8 `show=` filters + 5 tabs + 4 sorts + 5 flavor chips. Most rows only ever need one of two actions.
- **Blocked tab is misleading:** all 3 are Zoho retries an operator cannot clear here, yet the PO header shows a red Blocked badge as if floor work is stuck.

- Closeout still mixes **on-floor unfinished runs** (352286: 13,920 produced / 70%, "Finalize on floor") with **finalized-but-not-lotted** bags (352284) in the same Needs review list. Operator cannot tell "do this here" from "leave the floor and come back" without opening each row.
- **Over-consumed 352284** (received 16,783 vs produced 19,684, 117%) still asks "Review starting balance / consumption" + "Open receive" even though packaging counts are already on the row (9 cases · 21 displays · 1 loose). Extra trip to receiving for numbers the closeout row already shows.
- **On-floor bags with real output cannot be finished from closeout.** 352286 only offers "Open workflows" — another app area, more clicks, then return. Closeout should either finish the bag here or hide in-progress floor bags from the PO-close list until they are finalized.

## Highest-leverage changes (do these first)

1. Kill or fix the guided wizard. Blank page + auto-reopen is worse than no wizard. Until it works, don't make it the primary CTA.
2. One PO-level closeout for all bags that share a state (especially "Zoho needs mapping" × 51).
3. Auto-issue lot + auto-release on finalized bags with derivable balances; hide 0-tablet bags.
4. Keep Zoho off the closeout checklist until mapping is done once per SKU, then offer a single PO-level queue.
5. Floor login: one method, persistent device session, return to the deep link.
6. Stop auto-redirecting closeout to `/floor-board` after idle.
7. One inline "Issue lot" per row (or bulk issue all finalized); stop making expand+load a 15-click job.
8. Make "Issue finished lot" / "Finalize workflow" real buttons that go to the bag, not inert text. Fix workflow search.
9. Allow allocation-repair submit when packaging counts exist even if recorded starting balance is 0 (or name the failing field).
10. Hide zero-bag POs from the active list; one-click QC release; show product-setup blockers on the row, not only after expand.
