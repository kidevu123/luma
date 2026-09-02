# Luma simplify — design spec

Date: 2026-09-02
Source: `docs/luma-simplify.md` (live closeout audit of PO-00206, 2026-09-01).
Goal: eliminate clicks and manual steps in PO closeout, lot issuance,
Zoho gating, the guided wizard, and login.

## Decisions (settled with user)

1. **Scope:** all ~40 doc items, one spec, five phases A–E executed in
   order, plan per phase, SDD execution, suite-gated push.
2. **Wizard:** fix, do not kill. User likes guided mode; kill/keep
   decision deferred until usage data after phases A–C land.
3. **QC policy:** auto-release clean lots (consistent counts, no
   over-consumption, no hold). Over-consumed or held lots stop at
   `PENDING_QC` for a human, who gets one-click release with suggested
   reasons.
4. **Login:** SSO primary with password collapsed behind a link.
   `next=` honored end-to-end.
5. **Closeout tabs:** action-oriented buckets — Do here / On floor /
   Waiting on Zoho / Done, with empty (0-tablet) bags hidden behind a
   toggle.

## Corrections to the source doc (found in code exploration)

- **No idle redirect to `/floor-board` exists.** The observed behavior
  is `components/admin/auto-refresh-on-focus.tsx` firing
  `router.refresh()` on focus/visibility and a 60s interval, which
  re-derives the page under the operator (wipes drawer state, wizard
  queue, scroll). Fix is refresh suppression, not redirect removal.
- **Auto-issue + auto-release already exists** at
  `lib/production/engine/record-packaging-complete.ts:302-346`
  (`autoCreateAndReleaseFinishedLotForWorkflowBag`, in-transaction on
  bag finalize). Failures write a `finished_lot.auto_create_blocked`
  audit silently; the reason is never surfaced. Phase B surfaces and
  retries the blocked path rather than building auto-issue from
  scratch.
- **`next=` plumbing exists but is dead.** `app/api/auth/sso/route.ts`
  and the OIDC callback fully support it; nothing ever sets it. The
  callback also passes `next` to `new URL()` unvalidated (open
  redirect) — closed in Phase E.
- **Wizard bugs confirmed in code:** positional step index over a
  live-re-derived queue (silent bag skip after safe-batch runs), batch
  results wiped by `router.refresh()`, a reachable blank-render path,
  and auto-refresh re-deriving the queue mid-use.

---

## Phase A — Closeout core

### Bucket model

The verdict engine (`lib/production/po-closeout.ts`, pure functions)
gains a `bucket` field derived from existing status + action:

| Bucket | Meaning | Default tab behavior |
|---|---|---|
| `DO_HERE` | Lot issue, release, balance review — actionable on this page | Default tab |
| `ON_FLOOR` | Unfinished production runs; row says "finish on floor first", no action panel | Own tab |
| `WAITING_ZOHO` | Mapping / queue / retry — Zoho-side work | Own tab |
| `DONE` | Committed / closed | Own tab |
| `EMPTY` | 0-tablet bags | Hidden behind "show empty bags" toggle |

Tabs render from buckets. Old Ready/Needs-review/Blocked semantics are
removed. The 8 `show=` filters and flavor chips collapse to what the
buckets do not already express; sort stays.

### Inline primary action

Each row renders its single primary action button directly (e.g.
"Issue lot", "Release lot") without expand-and-wait, calling the same
existing server actions the drawer panels use. Convention preserved:
no new mutation endpoints under `_drawer/`. Chevron/expand stays for
detail and secondary actions.

### Real links

- "Issue finished lot" → `/finished-lots/new?bagId=X` (param already
  supported).
- "Finalize workflow" → `/workflow-submissions?bag=<id>`; that page
  gains `?bag=` support: pre-filtered to the bag, row auto-expanded.
  (Row expansion is currently local `useState` with no URL param.)

### Inline "why"

Disabled Zoho queue reasons and product-setup blockers render on the
row itself (data already loaded), not only after expand.

### One-click QC release

Single "Release lot" action clears hold and releases in one server
action (optional reason). Closeout drawer and lot page
(`finished-lots/[id]/status-actions.tsx`) share the same wording;
today they diverge.

### Refresh suppression

`AutoRefreshOnFocus` is suppressed while a drawer is expanded, a form
element has focus, or the guided overlay is open. Shipped here as a
shared mechanism; Phase D wires the wizard into it.

### One recommended action, not a blocker stack

The top-blockers banner (today up to six blocker types stacked)
collapses to a single recommended next action derived from bucket
counts (e.g. "7 bags ready to issue — Issue all"), with the rest
behind a "details" expand.

### Zero-bag POs

The closeout index collapses POs with 0 bags into one "N POs with
nothing to do" section instead of individual clickable rows.

### Phase A testing

Vitest on bucket derivation (pure), `?bag=` filter behavior, combined
release transition. Full suite stays green.

---

## Phase B — Automation

### Surface the blocked reason

Closeout row + drawer show the latest
`finished_lot.auto_create_blocked` audit reason for the bag, e.g.
"Auto-issue blocked: product missing tablets-per-unit". Product-setup
gaps (tablets-per-unit, shelf life, packaging structure) link directly
to the product edit page.

### PO-level "Issue all finalized lots"

New bulk action following the established template
(`po-closeout/actions.ts` + `PoBatchButtons`): derive eligible set
from the read-only evaluator, loop the existing per-bag service (each
re-checks eligibility in its own transaction), cap 100, one PO-scoped
audit, `revalidatePath`. Doubles as the retry path for previously
blocked auto-issues once the product gap is fixed.

### Auto-release clean lots

Any lot issued (manually, via repair, or via bulk) with consistent
counts — no over-consumption, no hold, no open allocation — is set
`RELEASED` in the same transaction, matching the packaging-complete
path. Otherwise the lot stops at `PENDING_QC`.

### Suggested QC reasons

Preset reason chips (overpack, recount, waste, damaged, other) for
over-consumption review and lot release, pre-filled with the system's
own numbers (e.g. "Recount: produced 20,300 vs received 20,000").
Free text remains available, never required from scratch.

### Bulk "Use calculated remaining"

PO-level bulk action applying derived remaining to every bag where it
is purely derivable. Same batch template.

### Auto-clear balance review

When received, produced, and remaining are all present and consistent,
the starting-balance/consumption checklist item auto-clears.

### Allocation-repair fix

- `repairStartingBalanceQty` schema: `.positive()` →
  `.nonnegative()`; repair service accepts derived starting balance of
  0 when packaging counts exist.
- All Zod errors from the issue/repair form map to field-labeled
  messages (no anonymous "Number must be greater than 0").
- Same raw-Zod-message fix applied to `loginAction`.

### Phase B testing

Vitest on release eligibility (clean / over-consumed / held),
repair-with-zero-balance, bulk eligibility derivation, reason-prefill
formatting.

---

## Phase C — Zoho gating

### Mapping before queue

Rows needing Zoho mapping/setup no longer render a disabled "Queue for
Zoho" button. The Waiting-on-Zoho tab shows one PO-level banner: "N
SKUs need Zoho mapping — Fix mapping" (dozens of identical rows trace
to a handful of product mappings). Rows show a state chip only.

### Filtered deep-link, round trip back

`/zoho-production-operations` gains `searchParams` (`?po=`, `?op=`) so
"Fix mapping" lands on the relevant ops, plus a "Back to closeout"
link when arrived with `?po=`.

### PO-level "Queue all ready"

Bulk action queuing every `READY_TO_QUEUE` bag on the PO. Same batch
template, per-op re-validation in each transaction, existing
push-blocker checks honored. All Zoho calls stay on
`zoho-integration-service` (gateway-only rule).

### Retries live in Waiting-on-Zoho

`FAILED` Zoho ops appear in Waiting-on-Zoho with a retry action, never
in a floor-blocked state. The PO header badge stops going red for
Zoho-only issues.

### Progress reads as progress

Issued-but-unmapped lots land in Waiting-on-Zoho, so issuing a lot
shrinks Do-here and grows Waiting-on-Zoho instead of inflating "Needs
review".

### Phase C testing

Vitest on mapping-rollup derivation (rows → distinct SKUs), queue-all
eligibility, badge logic (floor-blocked vs Zoho-only). Zoho pushes
exercised dry-run only.

---

## Phase D — Fix the guided wizard

### Address by bag, not by index

URL becomes `?guided=1&bag=<workflowBagId>` (safe-batch step uses
sentinel `bag=batch`). Next/prev computed from the bag's position in
the current queue, so out-of-band resolution shortens the queue
instead of skipping a neighbor. A bag no longer in the queue renders
"this bag is done" + Next — never a blank panel.

### Batch results persist

Safe-batch "N applied · M skipped" panel stays visible until the
operator clicks Continue; not wiped by post-run refresh.

### Pre-filtered queue

Queue derivation excludes `EMPTY` and `ON_FLOOR` bags. A one-line note
reports exclusions ("3 bags on floor, 15 empty — not shown").

### No auto-reopen, no refresh-under-you

Overlay opens only from an explicit click; Exit uses `router.replace`
so browser-back does not resurrect it. `AutoRefreshOnFocus` fully
suppressed while the overlay is open (mechanism from Phase A).

### One action per step

Each step renders only the primary action panel for the bag's derived
action. Bags with nothing to fix show state + Next, no panel. "Skip
for now" always advances, never exits.

### Blank-page bug

Structurally eliminated by bag-addressed steps + done-bag fallback.
Verify during implementation that the observed timeout was not a
separate data-loading hang.

### Phase D testing

Vitest on queue derivation (exclusions, bag-addressed lookup, done-bag
fallback) and a navigation-sequence test simulating out-of-band
resolution mid-wizard.

---

## Phase E — Login

### Honor `next=` end-to-end

- `lib/auth-guards.ts` redirects to `/login?next=<current path>`.
- Login page threads `next` into the SSO href
  (`/api/auth/sso?next=…`) and into `loginAction`, which redirects
  there instead of hardcoded `/dashboard`.
- Callback validates `next`: relative path only (starts with `/`, not
  `//`). Closes the existing unvalidated-`new URL()` open redirect.

### SSO primary, password tucked away

When Authentik is configured: one primary "Sign in" button (straight
to SSO); email/password collapses behind "Sign in with password
instead". Password field gets a normal empty placeholder (no `••••••••`
dots).

### Session longevity

Review session cookie maxAge; extend so a floor tablet does not
re-authenticate mid-shift (single-tenant, physically controlled
devices). No remember-me UI.

### Out of repo (ops task, not code)

Authentik theming (orange/mountain → Luma colors/logo) lives in
Authentik config on LXC 111. Tracked as an ops task; no code here.

### Phase E testing

Vitest on the `next` validation helper; standard auth smoke
(`luma-test-build-deploy`) covers both login paths.

---

## Cross-cutting constraints

- `workflow_events` remains source of truth; UI reads read models.
- Every mutation writes `audit_log`; bulk actions write one PO-scoped
  audit with affected/skipped detail.
- Soft-delete only; no floats; timestamptz; no emoji in UI.
- Never bypass `zoho-integration-service`.
- Each phase closes with typecheck + vitest + build + auth smoke and
  the canonical report shape before push.

## Doc-item → phase map

| Doc theme | Phase |
|---|---|
| Inert links, 15-click expand, hidden "why", tab semantics, zero-bag POs, refresh-under-you, two-button QC release | A |
| Auto-issue surfacing/bulk, auto-release, calculated remaining, balance review auto-clear, QC reason presets, repair submit fix | B |
| Mapping-first, PO-level queue, retry bucket, deep-link filters, progress counts | C |
| Wizard blank page, auto-reopen, skips, 6-action buffet, step drift | D |
| next=, SSO path, placeholder, session, Authentik theming (ops) | E |
