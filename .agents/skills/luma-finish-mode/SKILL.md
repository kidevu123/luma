---
name: luma-finish-mode
description: Keep Codex focused on finishing the actual Luma product. Refuse side quests, dashboards, speculative schema, and out-of-scope work.
---

# Luma finish-mode

## When this skill applies

Use this skill on **every** Luma coding task. It is the global discipline.
Whenever a phase brief lands, run the rules below before touching code.

## Core rules

- Every task must connect to the **PackTrack → Luma → Zoho → Nexus**
  spine. If a task does not, raise it and stop.
- Execute **one phase only**. Stop after the final report.
- Do not start side quests. If a side issue appears, fold it into the
  original workflow goal or report it as deferred in the final report.
- Do not build dashboards, visual polish, or new workflows unless the
  phase brief explicitly requested them.
- Do not touch **TabletTracker**.
- Do not rebuild **Nexus**.
- Do not build complaint tables inside Luma (`nexus_complaints`,
  `complaint_webhook`, `complaint_attachments`, `complaint_status_
  history` are all off-limits).
- Do not add speculative schema.
- Before coding, state which real operator workflow this improves.

## Final report template

Every phase final report must answer, in order:

1. Files changed.
2. Behavior changed (per-route, per-action, or per-script).
3. Tests added.
4. Build / test / smoke results (typecheck, vitest, next build,
   auth smoke).
5. Staging verification (health SHA, schema/route checks, no fake
   data).
6. Remaining workflow gaps (honest list).
7. Whether the next unchecked phase is ready.

## Anti-pattern detection

If you find yourself doing any of these, stop and re-read the phase
brief:

- Sweeping refactors not requested.
- Renaming columns "while I'm here".
- Adding flags that don't appear in the brief.
- Touching files outside the phase's scope.
- Importing third-party packages mid-phase.
