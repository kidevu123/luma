# Archived staging pilot scripts

Historical one-shot scripts used during controlled Sweet Trip / FIX Relax
staging QA. They are **not** part of normal deploy, cron, or app runtime.

- Require explicit operator approval before running.
- Require `ALLOW_STAGING_QA_DATA=true` and other env gates documented in each file.
- Do not run against production without a PM-approved commit window.

New ad-hoc pilots belong in `scripts/_pilot-*.ts` at the repo root (gitignored
until reviewed). Promote finished one-shots here instead of leaving debris at
the root.
