# STATION-BEHAVIOR-AUDIT-1 — Floor station behavior audit

**Date:** 2026-05-27  
**Status:** Audit complete — no implementation in this task  
**Base:** `origin/main` @ `a03b5a9` · **v0.4.5** (STATION-NAV-CLEANUP-1 integrated)

---

## 1. Current behavior summary

### Station / machine model

- **Station kinds** (`station_kind` enum in `lib/db/schema.ts`):  
  `BLISTER`, `SEALING`, `PACKAGING`, `BOTTLE_HANDPACK`, `BOTTLE_CAP_SEAL`, `BOTTLE_STICKER`, `COMBINED`, `HANDPACK_BLISTER`.
- **Machine kinds** (`machine_kind` enum): same set **except** no `HANDPACK_BLISTER` (hand-pack stations are intentionally machine-less per `lib/production/first-op-product.ts`).
- Floor auth is the station URL `scan_token`; production state is read from **read models** (`read_station_live`, `read_bag_state`), not folded on the client.
- Primary UI: `app/(floor)/floor/[token]/page.tsx` → `ScanCardForm`, `OperatorSessionPanel`, active bag card, `StageActionButtons`, optional `SealHandpackForm` / `QcPanel`, `SupervisorToolsPanel` (rolls / variety-pack only, gated by `lib/production/floor-station-mobile-nav.ts`).

### Close-out / stage events

All stage completions flow through `StageActionButtons` (`stage-action-buttons.tsx`) → server actions in `actions.ts` → `projectEvent` (`lib/projector/index.ts`).

| UI pattern | Event types | Trigger |
|---|---|---|
| **Rich form** (multi-field) | `BLISTER_COMPLETE`, `SEALING_COMPLETE` | Button opens modal panel; `fireStageEventAction` with counts |
| **Rich form** (packaging) | `PACKAGING_COMPLETE` | Separate packaging panel |
| **Generic one-tap + optional Count** | `HANDPACK_BLISTER_COMPLETE`, `BOTTLE_*_COMPLETE`, COMBINED non-rich stages | `fire(eventType)` immediately |
| **Sealing handpack** | `SEALING_COMPLETE` via `sealHandpackBagAction` | `SealHandpackForm` when bag has `HANDPACK_BLISTER_COMPLETE` in history |

`RICH_FORM_EVENTS` in `stage-action-buttons.tsx` is exactly `{ SEALING_COMPLETE, BLISTER_COMPLETE }`. Only those open close-out panels.

### HANDPACK_BLISTER vs “Blister close-out”

**Approved design** (`docs/superpowers/specs/2026-05-21-handpack-blister-station-design.md`): `HANDPACK_BLISTER_COMPLETE` has **minimal payload** (station, operator, timestamp) — no machine counter, no PVC/foil.

**Actual UI today:**

- Station kind `HANDPACK_BLISTER` shows button **“Hand-pack complete”** → fires `HANDPACK_BLISTER_COMPLETE` via `fire()` — **not** the violet **“Blister close-out”** panel (`BlisterCompleteForm`).
- That panel is **only** opened when `eventType === "BLISTER_COMPLETE"` (machine `BLISTER` or `COMBINED` blister step).

**If operators see “Blister close-out” with Blister count / Packs remaining:**

1. **Most likely:** station row in DB is kind `BLISTER` (or `COMBINED`), not `HANDPACK_BLISTER`, despite the display name “Hand Pack”.
2. **Otherwise:** they may be describing the generic **Count** input (shown for `HANDPACK_BLISTER` because `hasGenericStages` is true) — label says “Count”, not “Blister count”, but it is still wrong for a timed-only station.

**Additional gap:** `HANDPACK_BLISTER` still shows the shared **Count** numeric field (`hasGenericStages === true`). Server accepts optional `count_total` on `HANDPACK_BLISTER_COMPLETE` but design says none.

### Pause

- UI: **Pause bag** → reason `<select>` → `pauseBagAction` → `BAG_PAUSED` with payload `{ reason, operator_code?, notes? }`.
- Reasons are **hardcoded** in `stage-action-buttons.tsx` for **all** station kinds; default selection is `pvc_swap`.
- Server enum in `actions.ts`: `pvc_swap | shift_end | machine_jam | qa_check | other` only.
- Projector (`lib/projector/index.ts`): sets `read_bag_state.is_paused`, `paused_at`; on `BAG_RESUMED`, adds pause interval to `paused_seconds_accum`.
- **Pause does not clear** `read_station_live`; bag stays at station. Stage events are **refused while paused** (`checkStageProgression`).
- Resume: **Resume bag** → `BAG_RESUMED`; UI copy says “Resume to continue the cycle timer.”

### Time display (main station page)

| Location | Source field | Formatting (v0.4.5 main) |
|---|---|---|
| Active bag **“Started …”** | `workflow_bags.started_at` | `new Date(...).toLocaleTimeString()` — **browser locale, no `timeZone`** → on Docker/server often reads as UTC |
| Operator shift **“Opened …”** | `station_operator_sessions.opened_at` | `toLocaleTimeString()` — same issue |
| Active bag operator suffix | `read_bag_state.current_operator_code` | plain text |
| Footer | build metadata | not a production timestamp |
| **No elapsed timer** on main | — | — |

Sub-pages (supervisor tools, not main card): `rolls/page.tsx`, `rolls-forms.tsx`, `bag-allocation/page.tsx`, `variety-pack/page.tsx` use `toLocaleString()` / `toLocaleTimeString()` — same timezone risk.

**Note:** `read_station_live.last_event_at` exists but is **not** shown on the station landing page. `workflow_bags.started_at` is **bag lifecycle start** (first op), not “arrived at this station” — important for elapsed design at SEALING/PACKAGING.

### Operator / “Op # (4 digits)”

- Component: `stage-action-buttons.tsx` — `operatorCode` state, `sessionStorage` key `luma.op.{stationId}`.
- Placeholder on main: **`Op # (4 digits)`** (4-digit numeric filter).
- On generic `fire()`: if `operatorCode` set → `setOperatorAction` → `OPERATOR_CHANGE` on bag, then `fireStageEventAction`.
- Rich forms pass `overrideEmployeeCode` from the same field into `fireStageEventAction`.
- **Separate** from **Operator on shift** (`operator-session-form.tsx` → `station_operator_sessions` → `resolveStationAccountability` precedence: override → active session → null).
- **Mandatory accountability** only for `BLISTER_COMPLETE` and `BOTTLE_HANDPACK_COMPLETE` (`FIRST_OP_COUNT_EVENTS`) — **not** for `HANDPACK_BLISTER_COMPLETE`.

### Materials / supervisor tools

- **Rolls** (`/floor/[token]/rolls`): `BLISTER`, `COMBINED`, `SEALING` only (`FLOOR_ROLL_STATION_KINDS`).
- **Variety pack**: `BLISTER`, `HANDPACK_BLISTER`, `COMBINED`, `BOTTLE_HANDPACK`.
- **Loaded materials panel**: `HANDPACK_BLISTER`, `BOTTLE_HANDPACK`, `BOTTLE_CAP_SEAL` via `STATION_AUTO_MATERIAL_KINDS` (`BLISTER_CARD`, bottle/cap, induction seal).
- **HANDPACK_BLISTER** does not use PVC/foil rolls (design + `auto-load-lots`).

---

## 2. Root causes / bad assumptions

| # | Observation | Root cause |
|---|---|---|
| 1 | Hand-pack station asks for output counts | Design said timed/minimal `HANDPACK_BLISTER_COMPLETE`, but UI reuses **generic stage path** with **Count** input; rich **Blister close-out** is only wired to `BLISTER_COMPLETE`. Wrong form on hand-pack often = **wrong `stations.kind`** in master data. |
| 2 | PVC roll swap on hand-pack | Pause reasons are **one global list** in `stage-action-buttons.tsx`; default `pvc_swap`; no `stationKind` filter. |
| 3 | Started time looks UTC | `toLocaleTimeString()` without `timeZone: 'America/New_York'` on server-rendered HTML; Node in container uses UTC. |
| 4 | No prominent elapsed timer | Not implemented on main; WIP existed locally but was **not** on main at audit time. |
| 5 | Op # confusing | Legacy TabletTracker-style **per-submit override** duplicated alongside **Open shift** session; label “Op #” implies employee ID but is optional on many events. |
| 6 | Busy station UI | Shared `StageActionButtons` shows pause, operator, count, release, finalize gates for all kinds; only partial gating (QC panel, materials, supervisor tools). |

**Structural assumption to fix:** “One `StageActionButtons` fits all station kinds” — works for routing but not for **close-out shape**, **pause vocabulary**, or **timer anchor**.

---

## 3. Station behavior matrix

Legend: **Close-out** = primary stage-complete action at this station.

| Station kind | Time-only close-out (target) | Count / rich close-out (today) | Material consume | Rolls / PVC | Auto-loaded lots | Close-out UI today | Pause: PVC relevant? |
|---|---|---|---|---|---|---|---|
| `BLISTER` | No | Yes — blister count + packs remaining | PVC/foil rolls + BOM | Yes | No | **Blister close-out** form | **Yes** |
| `HANDPACK_BLISTER` | **Yes (design)** | No rich form; **optional Count field (wrong)** | `BLISTER_CARD` at seal, not PVC | No | Yes (`BLISTER_CARD`) | One-tap **Hand-pack complete** | **No** |
| `SEALING` | No | Yes — sealed / packs remaining / reopened | Heat seal film | Yes | No | **Sealing close-out**; handpack bags → `SealHandpackForm` | Sometimes (film) |
| `PACKAGING` | No | Yes — packaging snapshot fields | BOM from specs | No | No | **Packaging close-out** | Rare |
| `BOTTLE_HANDPACK` | No | Generic count + **Hand-pack complete** | Bottle + cap | No | Yes | Generic + count | No |
| `BOTTLE_CAP_SEAL` | No | Generic count | Induction seal | No | Yes | Generic + count | No |
| `BOTTLE_STICKER` | No | Generic count | Labels (implicit) | No | No | Generic + count; **finalizes** | No |
| `COMBINED` | No | Blister + sealing + packaging rich forms | All card path | Yes | No | Multiple rich forms | **Yes** |

**Event → stage** (unchanged): `HANDPACK_BLISTER_COMPLETE` → `BLISTERED` (same as `BLISTER_COMPLETE`) per `lib/projector/index.ts`.

---

## 4. Proposed implementation slices (priority order)

### Slice 1 — `STATION-HANDPACK-1` (recommended first)

**Goal:** `HANDPACK_BLISTER` is timed-only at close-out: one tap, no count fields, payload minimal.

**Changes (conceptual):**

- In `stage-action-buttons.tsx`, treat `HANDPACK_BLISTER_COMPLETE` as **timed-only** (exclude from `hasGenericStages`; no Count input).
- Optional: dedicated **“Finish hand-pack”** copy; confirm `fireStageEventAction` sends empty counts (already optional server-side).
- **Data check:** script or admin note to verify production hand-pack stations use `kind = HANDPACK_BLISTER`, not `BLISTER`.
- Do **not** change `BLISTER_COMPLETE` rich form or projector stage mapping.

**Files likely touched:**

- `app/(floor)/floor/[token]/stage-action-buttons.tsx`
- `app/(floor)/floor/[token]/stage-action-buttons.test.ts` (new structural tests)
- `docs/superpowers/specs/2026-05-21-handpack-blister-station-design.md` (cross-link only if drift note needed)
- Optional: `app/(admin)/machines` validation hint (out of scope unless requested)

**Tests:**

- `HANDPACK_BLISTER` stage list has no Count input in source.
- Click path calls `fire("HANDPACK_BLISTER_COMPLETE")` without opening `BlisterCompleteForm`.
- `BLISTER` still opens blister rich form.

---

### Slice 2 — `STATION-TIME-1`

**Goal:** All operator-facing times on `/floor/[token]` in **Eastern**; prominent **elapsed** on active bag (mobile-first).

**Changes (conceptual):**

- Add `lib/floor-time.ts`: `formatFloorTimeEastern`, `formatElapsedSeconds` using `America/New_York` (align with `company.timezone` default in schema).
- `page.tsx`: Started label uses Eastern helper; render client `ElapsedTimer`.
- **Elapsed anchor:** prefer `read_station_live.last_event_at` when bag pinned at this station, **or** first `BAG_PICKED_UP` / scan assign event at `stationId` — **not** `workflow_bags.started_at` for downstream stations. Document fallback for first-op (bag start ≈ station start).
- Elapsed formula: `(now - anchor) - pausedSecondsAccum - (paused ? now - pausedAt : 0)` — matches projector pause semantics.
- Also fix `operator-session-form.tsx` “Opened …”; consider sub-pages in same slice or `STATION-TIME-1b`.

**Files likely touched:**

- `lib/floor-time.ts`, `lib/floor-time.test.ts`
- `app/(floor)/floor/[token]/elapsed-timer.tsx` (new client component)
- `app/(floor)/floor/[token]/page.tsx`
- `app/(floor)/floor/[token]/page.test.ts`
- `operator-session-form.tsx`
- Possibly `page.tsx` query: join `readStationLive.lastEventAt` for anchor

**Tests:**

- Structural: no bare `toLocaleTimeString()` for `startedAt` on main page.
- Unit: `formatFloorTimeEastern` pins ET (winter/summer spot checks).
- Elapsed: paused bag freezes; resume continues from accum.

---

### Slice 3 — `STATION-PAUSE-1`

**Goal:** Station-specific pause reasons; remove PVC from non-roll stations.

**Changes (conceptual):**

- New pure module e.g. `lib/production/floor-pause-reasons.ts`: `pauseReasonsForStationKind(kind) → { value, label }[]`.
- `HANDPACK_BLISTER`, bottle stations: no `pvc_swap`; default `machine_jam` or `other`.
- `BLISTER`, `COMBINED`, `SEALING`: keep PVC + film-appropriate set.
- Optional follow-up: extend DB enum / legacy synthesizer labels if new reasons needed (migration = separate approval).

**Files likely touched:**

- `lib/production/floor-pause-reasons.ts` + tests
- `app/(floor)/floor/[token]/stage-action-buttons.tsx`
- `app/(admin)/floor-board/_components/breakdown-row.tsx` (labels only if new reason keys)

**Tests:**

- Matrix: `HANDPACK_BLISTER` options exclude `pvc_swap`.
- `BLISTER` includes `pvc_swap`.

---

### Slice 4 — `STATION-OPERATOR-1`

**Goal:** Remove redundant Op # when shift is open; clarify override path.

**Changes (conceptual):**

- If `getActiveStationSession` exists: hide Op # field; show “Submitting as {name}” from session.
- Keep override path for supervisor (collapsed “Different operator” with code).
- Ensure `resolveStationAccountability` still receives override on rich forms.
- Rename any remaining label to **Operator code (override)** not Op #.

**Files likely touched:**

- `stage-action-buttons.tsx`
- `page.tsx` (pass `activeSession` into buttons)
- `lib/production/station-operator-session.ts` (read-only; no schema change)

**Tests:**

- With session prop documented in structure tests; override field only when flag set.

---

## 5. Risk assessment

| Slice | Risk | Mitigation |
|---|---|---|
| HANDPACK-1 | Low — UI-only if station kind correct | Verify station kinds in DB before deploy; keep `BLISTER` form untouched |
| TIME-1 | Medium — wrong elapsed anchor misleads operators | Use station `last_event_at` or pickup event; test SEALING pickup after blister |
| PAUSE-1 | Low — enum already on server | Don’t add new reason strings without migration |
| OPERATOR-1 | Medium — accountability gaps on first-op | Keep override; don’t remove `FIRST_OP_COUNT_EVENTS` guards on BLISTER/BOTTLE_HANDPACK |

**Regression guardrails:** Do not modify `scan-card-form.tsx`, `actions.ts` stage/pause **semantics** unless required — prefer UI + small pure helpers. Full action changes need coordinated tests with `scan-card-form.test.ts` untouched.

---

## 6. Exact tests needed (by slice)

| Slice | Tests |
|---|---|
| HANDPACK-1 | Structural: no `placeholder="Count"` path when `stationKind === "HANDPACK_BLISTER"`; no `BlisterCompleteForm` for handpack button; `HANDPACK_BLISTER` in `STAGE_BY_KIND` fires direct `fire` |
| TIME-1 | `lib/floor-time.test.ts` ET formatting; `page.test.ts` Eastern + `ElapsedTimer` props; optional component test for pause freeze |
| PAUSE-1 | `floor-pause-reasons.test.ts` per-kind matrix |
| OPERATOR-1 | Structural: no `Op #` placeholder when session active (pattern match); session still required for `BLISTER_COMPLETE` per existing action tests |

**Existing suites to keep green:** `scan-card-form.test.ts` (101), `floor-station-mobile-nav.test.ts`, `page.test.ts` (mobile UX), FLOOR-FIRST-RUN-E2E-2 structural tests.

---

## 7. Do not touch (implementation guardrail)

- `app/(floor)/floor/[token]/scan-card-form.tsx` — camera / first-op start flow (v0.4.4 E2E)
- `app/(floor)/floor/[token]/actions.ts` — unless a slice **requires** server enum/helper extraction (prefer new pure modules + minimal action edits)
- Camera scanner, QR lookup, schema, migrations
- Zoho writes, receive edit, audit write behavior
- Projector stage-rank logic (`STAGE_FOR_EVENT`) unless explicitly scoped
- `lib/projector/material-consumption-hook.ts` roll ledger

---

## 8. Recommendation: implement first

**Start with `STATION-HANDPACK-1`.**

- Directly addresses the approved hand-pack design vs current UI (count field + possible wrong station kind).
- Small, reviewable diff in `stage-action-buttons.tsx` only.
- No timezone/client timer complexity.

**Then `STATION-TIME-1`** (Eastern + elapsed) — highest daily operator visibility; requires careful **station dwell anchor** design.

Pause and operator slices can follow without blocking hand-pack correctness.

---

## Appendix A — Code references (audit anchors)

| Topic | Primary files |
|---|---|
| Stage buttons / close-out | `app/(floor)/floor/[token]/stage-action-buttons.tsx` |
| Server events / pause | `app/(floor)/floor/[token]/actions.ts` (`fireStageEventAction`, `pauseBagAction`, `resumeBagAction`, `setOperatorAction`) |
| Stage rules | `lib/production/stage-progression.ts` |
| Projector pause | `lib/projector/index.ts` (~298–321) |
| Station page | `app/(floor)/floor/[token]/page.tsx` |
| Operator shift | `app/(floor)/floor/[token]/operator-session-form.tsx`, `lib/production/station-operator-session.ts` |
| Supervisor gating | `lib/production/floor-station-mobile-nav.ts` |
| Hand-pack design | `docs/superpowers/specs/2026-05-21-handpack-blister-station-design.md` |

---

## Appendix B — Elapsed timer design (for STATION-TIME-1)

**Display:** Client component, 1s tick, format `12m 34s` / `1h 02m 03s`, placed **inside active bag card** below “Started …”, full width, large tabular nums (mobile thumb zone).

**Computation:**

```
activeMs = now - anchorMs - (pausedSecondsAccum * 1000) - (isPaused ? now - pausedAtMs : 0)
```

**Pause:** Use **active working time** (exclude paused intervals) — data already in `read_bag_state.paused_seconds_accum` + `paused_at`. UI label: **Elapsed** / **Paused at** (frozen value).

**anchorMs priority:**

1. `read_station_live.last_event_at` for `(stationId, currentWorkflowBagId)` when bag at station (approximates last activity; may need **first** pin event if complete events advance `last_event_at` — verify in implementation).
2. Better: query latest `workflow_events` where `station_id = X` and `workflow_bag_id = Y` and type in (`CARD_ASSIGNED`, `BAG_PICKED_UP`, `BAG_CLAIMED`) — smallest `occurred_at`.
3. First-op only fallback: `workflow_bags.started_at`.

**Server:** Pass `anchorIso`, `pausedSecondsAccum`, `isPaused`, `pausedAtIso` from RSC; no per-second server round-trips.

---

## Appendix C — Recommended next implementation prompt

```
Implement STATION-HANDPACK-1 on main (v0.4.5+).

Make HANDPACK_BLISTER timed-only at close-out:
- One-tap "Finish hand-pack" (or keep "Hand-pack complete") with NO Count input and NO Blister close-out form.
- Do not change BLISTER, SEALING, PACKAGING, or scan/start flows.
- Add structural tests in stage-action-buttons.test.ts.
- Verify in CHANGELOG under v0.4.6.

Hard stops: do not touch scan-card-form.tsx, actions.ts (unless unavoidable), camera, schema, migrations.

After merge, run typecheck, vitest, build.
```

---

*Audit performed read-only. No commits pushed.*
