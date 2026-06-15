# Versioning

Luma uses [Semantic Versioning](https://semver.org/) — `MAJOR.MINOR.PATCH`.

Luma is **post-launch**. The current line is `1.x.y`. There will never be another `0.x.y` release; the launch milestone is recorded as `1.0.0`.

## When to bump

Classify every change by what an operator (or admin, or downstream consumer of the Luma surface) actually experiences.

### PATCH — `1.0.0` → `1.0.1`

Backward-compatible fixes and small polish. The thing the user already does still works the same way; it just works better, more accurately, or doesn't crash.

Examples from this codebase:
- Fixing a chip that showed the wrong blocker after a save
- Tightening a Drizzle predicate so the count matches the list
- Copy tweaks ("Auto-issue ready" wording)
- A build-system fix that splits a client component to satisfy `next build`
- Performance tweak on a read model
- Type-only refactors with no behavior change

### MINOR — `1.0.0` → `1.1.0`

Backward-compatible new functionality. New surface, new capability, or a meaningful UX shift. Existing routes/scripts/integrations still work; users gain something.

Examples from this codebase:
- A new admin page (e.g., Production capacity, Roll variance)
- A sidebar restructure (e.g., the four phased groups)
- A new auto-issue blocker code or a new field-specific status chip
- A persistent tab row added across an area
- A new server action exposed for an admin form
- A new Zoho readiness facet surfaced in the UI

### MAJOR — `1.0.0` → `2.0.0`

Breaking changes. Coordinate with the operator/admin team before merging.

Examples that would qualify:
- Removing a route operators currently bookmark (`/po-reconciliation` going away, say)
- Removing a sidebar entry that integrations link to
- A Drizzle migration that requires a coordinated deploy window
- Changing the floor station scan-token format
- Renaming or removing a Zoho gateway endpoint Luma depends on
- A `workflow_events` event-type rename (event log is the source of truth — schema for it is a public contract)
- Removing or renaming a public API surface (anything under `/api/*`)
- Changing the auth contract (Authentik claim mapping, role names, etc.)

If you're unsure whether a change is breaking: ask "could this break a bookmark, a script, a webhook, a saved query, or an integration?" If yes, treat it as MAJOR.

## How to bump

1. Edit `package.json` `version` to the next number per the rules above.
2. Reference the new version in the commit subject: `feat(admin): … (v1.1.0)` or `fix(admin): … (v1.0.4)`.
3. Push to `main`. The LXC deploy reads `package.json` for the running version label; no other file needs touching.

## What doesn't get a bump

- WIP commits on a feature branch (bump once at merge, not per commit)
- Documentation-only changes to this file or to `CLAUDE.md` (still commit them, just no version bump)
- Tooling changes that don't ship code (`.claude/`, dev scripts under `scripts/_pilot-*`)

## History note

Pre-launch (`0.4.x`) the project bumped patch for everything regardless of scope. Real features (`0.4.111`), trivial UI splits (`0.4.113`), and major nav refactors (`0.4.116`) all looked identical from the version number, which made it hard to read impact from the changelog. The cutover to `1.0.0` (from `0.4.117`) marks both the launch milestone and the policy shift.
