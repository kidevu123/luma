# Luma → Zoho Push to Zoho — go-live doc index

**Status:** Active as of Luma `ca2b9a2` / v1.0.1 and Zoho Integration v1.21.3.

Use these documents on the Luma deploy host (`/opt/luma/docs/`). Zoho Integration Service (CT 9503) does not mirror this tree; operators run commit windows from Luma admin + Proxmox shell per runbook.

## Operator runbooks

| Document | Purpose |
|----------|---------|
| [ZOHO_SKU_ROLLOUT_READINESS_CHECKLIST.md](./ZOHO_SKU_ROLLOUT_READINESS_CHECKLIST.md) | Pre-commit checklist (sections A–E) + PM sign-off template |
| [LUMA_ZOHO_BAG_RECEIVE_AND_PRODUCTION_OUTPUT_RUNBOOK.md](./LUMA_ZOHO_BAG_RECEIVE_AND_PRODUCTION_OUTPUT_RUNBOOK.md) | Two-phase bag receive + production-output workflow |
| [CONTROLLED_PRODUCTION_OUTPUT_COMMIT_WINDOW.md](./CONTROLLED_PRODUCTION_OUTPUT_COMMIT_WINDOW.md) | Gate open/close, shell `trap`, pilot script pattern |
| [ZOHO_SHARED_SERVICE_PRODUCTION_OUTPUT_CONTRACT.md](./ZOHO_SHARED_SERVICE_PRODUCTION_OUTPUT_CONTRACT.md) | Zoho Integration service contract |
| [FIX_RELAX_PILOT_CLOSEOUT.md](./FIX_RELAX_PILOT_CLOSEOUT.md) | FIX Relax end-to-end proof reference |

## Day-1 live-commit allowlist (PM procedural)

1. **FIX Relax 1ct** — product `95c61efe-a36a-44df-8fee-8e66d659ed80`
2. **Hyroxi MIT B - Sweet Trip** — product `510ab906-32b9-4082-b678-5d35ced9c4b8`

All other SKUs: **preview-only** until PM checklist sign-off.

## Hard exclusions

Choco Drift, receipt 352176, Bag B, XL 7OH pending/unconfirmed bags, unapproved SKUs, `WAREHOUSE_REQUIRED` blockers, ambiguous receive rows without PM review.

## Launch control

See [LAUNCH_CONTROL.md](./LAUNCH_CONTROL.md) for current deployed SHA, gate defaults, and Zoho push posture.
