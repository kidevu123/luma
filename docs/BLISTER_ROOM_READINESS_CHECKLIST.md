# Blister Room Readiness Checklist

**Scope:** Blister Room + Blister Hand Pack Station only. Use before first scan each shift and as a floor reference.

**Live app baseline:** v0.4.79 — verify on shift day via `curl http://192.168.1.134:3000/api/health` (see §1).

**Companion:** `docs/LAUNCH_CONTROL.md` for shipped vs not-shipped features and PM task board. Counter snapshot detail: `docs/PAUSE_ENDSHIFT_COUNTER_PROCEDURE.md`.

---

## 1. Pre-shift admin checks (Sahil or designated admin)

Complete **before** operators scan anything.

- [ ] **App version / health** — `curl http://192.168.1.134:3000/api/health` → `status: ok`, `checks.app` + `checks.db` ok
- [ ] **SHA matches main** — health `sha` equals expected release SHA (check `package.json` version + health `sha`)
- [ ] **Deploy verify** — from dev machine: `npm run verify:deploy` → exit 0
- [ ] **Auth smoke** — on LXC: `FAIL=0`, `/workflow-submissions` PASS
- [ ] **Active stations correct** — Admin → Machines: **Blister Room** and **Blister Hand Pack Station** active
- [ ] **Inactive stations intentional** — e.g. `Hand Pack Blister Smoke` stays inactive; no production station accidentally deactivated
- [ ] **Active PVC/FOIL rolls mounted correctly** — Admin/material view matches **physical** rolls on machine (staging example: PVC-3 + Legacy FOIL-01 — verify live each shift)
- [ ] **Receiving / data entry complete** — PO received, inventory bags created, tablet type assigned **before** floor starts blister on those bags
- [ ] **QR cards linked to received bags** — Bag cards assigned to workflow bags with `inventory_bag_id` populated
- [ ] **Tablet lineage present** — For each bag expected on floor today: `inventory_bags` → `tablet_types` resolves (hand-pack will block if missing)

**If any pre-shift item fails:** do not start blister production; fix or call Sahil.

---

## 2. Operator start flow (each new bag / station session)

### Blister Room (machine blister)

1. [ ] **Scan station** — Blister Room token; station shows active, not "inactive" block
2. [ ] **Scan bag card** — Card status ASSIGNED to this bag's workflow
3. [ ] **Confirm tablet/product context** — UI shows expected tablet/product for this receipt (from linked inventory bag)
4. [ ] **Confirm active material rolls** — PVC and foil shown match what's physically on the machine
5. [ ] **Begin production** — only after context matches physical setup

### Blister Hand Pack Station

1. [ ] **Scan station** — Blister Hand Pack Station (not inactive smoke station)
2. [ ] **Scan bag card**
3. [ ] **Tablet shown automatically** — from bag lineage (`MIT B Strawberry Pink` style); **no manual tablet picker** for linked bags
4. [ ] **Finished product** — deferred to sealing; do not expect product picker here
5. [ ] **If blocked for missing lineage** — stop; do not override — call Sahil

### When to stop and call Sahil (start phase)

- App asks operator to **select tablet manually** for a bag that should be received/linked
- Receipt or bag identity missing / shows `Legacy bag …` for a bag you know was received today
- Active roll in UI ≠ physical roll on machine
- Station shows inactive block on a station that should be live
- Any health/db error on the iPad

---

## 3. During-shift flow

### Normal blister complete (Blister Room)

- [ ] Complete blister stage per station prompts
- [ ] Bag stage advances to BLISTERED in admin/workflow views when done
- [ ] Release or hand off card per current procedure (card stays ASSIGNED until next station picks up)

### Hand-pack blister complete

- [ ] Tablet context read-only and matches physical tablets in bag
- [ ] Complete only when lineage resolved; block message means admin repair needed first

### Partial roll swap (material remaining on old roll)

- [ ] Operator chooses **"Removed with material remaining"** (not depleted)
- [ ] Counter segment recorded for bag + old roll
- [ ] Old roll returns to **AVAILABLE**; replacement roll mounts **without** inheriting prior count
- [ ] Confirm UI shows new active roll after swap

### Depleted roll swap

- [ ] Operator chooses **depleted/finished** path for old roll
- [ ] Old roll marked depleted; replacement roll mounted clean

### Pause / end-shift counter snapshot

Full procedure: **`docs/PAUSE_ENDSHIFT_COUNTER_PROCEDURE.md`**

- [ ] On machine jam or shift end: enter **good blisters since last reset** (segment count, not lifetime machine total)
- [ ] Positive count records roll counter segment for active PVC/foil
- [ ] Zero is allowed as an explicit snapshot (no segment emitted)
- [ ] **After snapshot:** reset physical machine counter before resuming (trained procedure)
- [ ] End shift with active bag: use operator panel **End shift** flow (captures counter + closes session)

### During-shift — call Sahil if

- Counter snapshot value doesn't match what machine shows
- Roll swap UI doesn't match what you physically did
- Bag appears at wrong station or "stuck" after release
- Duplicate or impossible segment implied by UI

---

## 4. End-shift flow

- [ ] **Pause / end-shift count snapshot** — capture machine counter when prompted (same rules as §3)
- [ ] **Confirm bag state** — active bags paused or released intentionally; no ambiguous in-progress bag left untended
- [ ] **Confirm material state** — active rolls in UI match what's left on machine (or properly swapped/depleted)
- [ ] **Do not leave ambiguous active bag/session** — use end-shift / close session so next shift starts clean
- [ ] **Physical machine counter** — reset per trained procedure after snapshot if applicable

---

## 5. Red flags (investigate before continuing)

| Signal | Likely cause | Action |
|--------|--------------|--------|
| Manual tablet selection for linked bag | Missing or broken inventory lineage | Stop hand-pack; admin repair |
| Receipt/bag identity missing unexpectedly | Unlinked workflow bag or legacy row | Stop; verify receive + QR assignment |
| Active roll ≠ physical roll | Wrong mount or missed swap event | Stop; reconcile with Sahil before more production |
| Counter snapshot confusion | Operator/process drift | Pause; do not guess counts |
| Bag stuck at wrong station | Missed release/pickup event | Stop; Sahil checks workflow events |
| `Legacy bag …` on expected received bag | Data entry or link gap | Stop floor for that bag |
| `verify:deploy` mismatch | Deploy drift | No floor start until redeploy verified |
| Health/db not ok | Infrastructure | Stop all floor actions |

---

## 6. Stop the floor and call Sahil — hard thresholds

**Stop all blister/hand-pack production immediately** if any of:

1. **Wrong tablet or product shown** for a linked received bag
2. **Wrong roll mounted in UI** vs physical machine
3. **Missing lineage** for a bag currently in live production
4. **Duplicate or impossible counter segment** (numbers don't reconcile)
5. **App health or database error** (500s, health not ok)
6. **Any finalized or finished-lot correction needed**
7. **Any urge to manually edit the database** — that means the app doesn't support the fix yet

**While waiting:** do not improvise overrides, do not run repair scripts, do not force-complete stages.

---

## 7. Broader rollout — sealing expansion red flags

This checklist is **blister-room-only**. Before expanding dual-run to sealing stations:

- [ ] **Finished product must survive refresh** — today the sealing product dropdown is browser-only state; a reload clears the selection. Do not treat sealing close-out as lineage-safe until **SEALING-PRODUCT-PERSIST-1** ships (see `docs/LAUNCH_CONTROL.md`).
- [ ] If product selection disappears after refresh, stop sealing work and call Sahil — do not re-select casually and proceed.

---

## 8. Quick reference — what the app will NOT do (v0.4.73)

- Apply material-change recovery (plan only in code/tests)
- Auto-repair legacy/unlinked bags
- Write live Zoho production output
- Let operators pick tablet type on linked hand-pack bags
- Guess missing receipt/PO/tablet (shows block or `Legacy bag …` instead)

---

## 9. Verification record (fill per shift)

| Field | Value |
|-------|-------|
| Date | |
| Shift | |
| Verified by | |
| Health SHA | |
| verify:deploy | pass / fail |
| Auth smoke FAIL | |
| Active PVC roll | |
| Active foil roll | |
| Bags planned | |
| Issues / escalations | |

---

## Change log

| Date | Change |
|------|--------|
| 2026-05-27 | Added sealing expansion red-flag note (SEALING-PRODUCT-PERSIST-1) |
| 2026-05-27 | Initial blister-room checklist at v0.4.73 launch-control reset |
