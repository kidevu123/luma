# Floor UI polish requirements

> **Status:** future-phase brief. The current floor screens (`/floor/[token]`,
> `/floor/[token]/rolls`, `/floor/[token]/bag-allocation`,
> `/floor/[token]/variety-pack`) are **validation tools** — they exist to
> exercise the event log, projector, and read models so the auditor
> snapshot can confirm the math. They are NOT the production employee
> experience. Do not ship them as-is to operators on the floor.
>
> **Do not implement this polish yet.** This document is the contract the
> polish phase must satisfy when it lands. Owner-approved.

## The product rule (non-negotiable)

The final employee floor UI must be **extremely simple**:

- one station screen
- one obvious next action
- scan-first
- large buttons
- minimal typing
- no admin-style tables
- no long scrolling
- no confusing navigation between multiple pages
- no employee math
- no hidden workflow state
- clear success / failure feedback
- clear *"what do I do next?"* messaging

Admin and supervisor dashboards can be as detailed as needed. **Employee
station screens must be simple.**

## Desired final workflow

1. Employee scans the station QR.
2. System knows the station.
3. Screen shows **only the next valid action**.
4. Employee enters the required number (one field, large keypad).
5. Employee taps one button.
6. System moves the bag / roll / material to the next state.
7. Employee sees a **clear success message** (or a clear failure with
   what to do next).

That's the whole loop. Anything that requires the employee to think
about *which page to go to*, *what stage the bag is at*, *which roll is
which*, or *what the math means* has failed the rule.

## Concrete behaviors required

### Single station screen
- After scanning the station QR, the employee sees one screen for that
  station kind. No tabbed UI, no separate "rolls" / "bags" / "variety"
  sub-pages that the employee has to navigate to during normal flow.
- Roll-related actions (mount, unmount, weigh, change-roll mid-bag)
  must be reachable from the active bag screen — not as a separate
  destination the employee has to remember to visit.

### Stage-aware action visibility
- If the bag at this station has not been blistered yet, show
  **Blister complete**.
- If the bag is already blistered at this station, hide the
  Blister-complete button entirely. Do not leave it visible-but-
  ineffective.
- The next valid action becomes the primary button:
  - At Blister: Release to sealing queue (after blister complete).
  - At Sealing: Release to packaging queue (after sealing complete).
  - At Packaging: Finalize bag (after packaging complete).
- "Roll ran out mid-bag" must be a reachable action from the active
  bag screen — not buried inside a separate roll-management page.

### Scan-first, type-last
- Card pickup at downstream stations is scan, not picker. The dropdown
  of IDLE cards is fine for staging QA but not for the production
  experience — the operator scans the physical QR.
- Numeric inputs must be a large numeric keypad with the field
  pre-focused. No tiny mobile-Safari spinners.
- No UUIDs, no scan_tokens, no internal IDs visible to operators.
  Card labels (e.g. "Bag 47") and product names only.

### Honest feedback
- Every server-action submit must surface its result inline:
  - **Success:** green banner with one short sentence.
  - **Failure:** red banner with the actionable reason (translate
    raw PG errors before showing them — the v2F translation rule
    stays).
- Submit buttons disable while pending. No double-tap duplicates.
- Optimistic state is fine but must reconcile to truth on success.

### No employee-facing math
Operators must never need to understand:
- Stages (`STARTED → BLISTERED → SEALED → PACKAGED → FINALIZED`)
- Confidence ladders (`HIGH / MEDIUM / LOW / MISSING`)
- Counter segments, segment groups, or bag-segment sequences
- Grams per blister, expected vs actual variance, projected runout
- Read models or rebuild pipelines

If a confidence/standard/projection number must surface to the
employee, translate it to a single sentence ("This roll has about 30
minutes left at current pace") — never the raw `0.04218` or `MEDIUM`.

### Workflow state must be visible, not hidden
- The employee must always be able to see: which bag is active here,
  which rolls are mounted, what the next step is.
- They must never have to guess whether the previous tap "took" or
  whether the page is stale.

## What this brief does NOT mean

- It is not a rewrite of the workflow logic. The server actions, the
  event log, the projector, and the read models stay as-is. Only the
  presentation layer changes.
- It is not a brand / colors / typography pass. That can ride along
  with the simplification work but is not the goal.
- Admin pages (`/floor-board`, `/active-rolls`, `/roll-variance`,
  `/material-alerts`, `/po-reconciliation`, `/genealogy`,
  `/operator-productivity`, `/packaging-output`, etc.) are out of
  scope — they are intentionally detailed and stay as-is.

## Acceptance criteria for the polish phase

When the polish phase ships, every employee floor flow listed below
must pass a "thirty-second smoke" — an operator who has never seen the
app must complete the action without help:

1. Start a new bag at the Blister station.
2. Fire Blister complete with a count.
3. Change a roll mid-bag when one runs out.
4. Release a bag forward to the next station.
5. Receive a bag at the Sealing station by scanning the same QR.
6. Fire Sealing complete with a count.
7. Receive a bag at the Packaging station.
8. Close out packaging with master cases / damaged / etc.
9. Finalize a bag at packaging.

Each flow ends in either a clear green confirmation or a clear red
"call supervisor" banner. No silent refresh. No raw PG errors. No
five-page navigation chains.

## Non-negotiable

This document is the requirements contract for the future visual / UI
polish phase. It cannot be relaxed without owner approval. Validation
tools may be ugly; production employee screens may not be confusing.
