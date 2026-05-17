# Claude Code local skills

This file inventories the **repo-local** Claude Code skills installed
under `.claude/skills/`. These skills are loaded automatically by
Claude Code when working in this repo. They exist to make future
Luma work consistent, safer, and focused on the actual product.

## Security rule (read first)

- **Repo-local only.** No third-party / marketplace skills are
  installed.
- **No MCP servers added.** No additional integration installs.
- **Owner approval required** before installing any skill not in
  this list. Random skills from elsewhere can drift the project off
  course.

## What's installed

| Skill | Purpose | When to use |
|-------|---------|-------------|
| `luma-finish-mode` | Keep Claude focused on finishing the product; refuse side quests | Every Luma task — global discipline |
| `luma-workflow-ux` | Use floor language, not schema language; keep operator flows simple | Any admin page / sidebar / server action / copy change |
| `luma-drizzle-migration` | Safe additive migrations; split enum ALTER; mirror to schema.ts; verify | Any `drizzle/*.sql` or `lib/db/schema.ts` change |
| `luma-test-build-deploy` | Canonical closeout: tsc + vitest + next build + auth smoke + staging verify | Every code phase, at close-out |
| `luma-zoho-gateway` | Use the gateway not direct OAuth; honor readiness; never log secrets | Any `lib/integrations/zoho/*` or `/settings/integrations/zoho` work |
| `luma-packtrack-contract` | Keep PackTrack ↔ Luma boundaries clean (packaging vs production) | Any PackTrack-facing route, packaging receiving, or shortage-recommendation work |
| `luma-nexus-commercial-trace` | Three read-only endpoints, confirmed allocations only, customer-scope visibility | Any `app/api/nexus/*`, allocation engine, or `lib/integrations/nexus/*` work |
| `luma-data-honesty` | Never imply missing=zero, suggested=confirmed, manual=verified, damage=scrap, etc. | Every UI copy / label / error message / response body |

## Why these eight

These eight skills cover the four chronic failure modes seen across
prior Luma phases:

1. **Scope creep** — `luma-finish-mode` + `luma-workflow-ux` keep
   the work focused on real workflows, not speculative builds.
2. **Schema accidents** — `luma-drizzle-migration` codifies the
   enum-rollback gotcha and the journal-timestamp trap.
3. **Quiet failures** — `luma-test-build-deploy` makes every
   close-out exercise the same five commands and the same staging
   checks.
4. **Integration drift** — `luma-zoho-gateway`,
   `luma-packtrack-contract`, and `luma-nexus-commercial-trace`
   pin the boundaries between the four systems on the PackTrack →
   Luma → Zoho → Nexus spine.

`luma-data-honesty` is the cross-cutting discipline that prevents
misleading copy, audit messages, and labels from sneaking into any
of the above.

## Why NOT third-party / marketplace skills

The Luma codebase has specific contracts (gateway vs direct OAuth;
confirmed-only Nexus exposure; receipt # vs trace code distinction;
the QC subsystem's reason-code vocabulary). A generic skill from
elsewhere would not know these and would drift the work. Anything
generic enough to apply broadly is also generic enough to lose the
project's specific guardrails.

If the owner wants to install a marketplace skill, they'll name it
explicitly in a phase brief. Until then, repo-local only.

## How Claude loads these

Claude Code reads `SKILL.md` files under `.claude/skills/` on session
start. Each skill has a `name` + `description` frontmatter plus
markdown body. The `description` is what Claude sees in the skill
list; Claude invokes the skill when the description matches the
task. Skills don't run code — they shape the next turn's behavior.

## Maintenance

- Skills evolve with the codebase. When a phase changes the
  contract a skill describes, update the skill in the same commit.
- Don't add new skills outside this list without a phase brief
  saying so.
- If a skill becomes wrong, fix it. A stale skill is worse than no
  skill — it lies to future Claude.
