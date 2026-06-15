# Controlled production-output commit window

Use this checklist for **PM-approved pilot commits only**. Normal admin UI commits rely on env gates already set on the host.

## Luma gates (in-process)

Pilot TypeScript scripts should wrap commit logic:

```typescript
import { withProductionOutputCommitWindow } from "@/lib/zoho/controlled-production-output-window";

await withProductionOutputCommitWindow(process.env, async () => {
  // queue + processConsolidatedProductionOutputCommit
});
```

This always sets `ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED=false` in `finally`, even when commit throws or exits non-zero.

## Zoho gates (host — required)

Luma cannot close Zoho Integration gates from application code. Use a shell `trap` on the operator host:

```bash
cleanup_gates() {
  pct exec 9503 -- sed -i 's/^ENABLE_LIVE_INVENTORY_WRITES=.*/ENABLE_LIVE_INVENTORY_WRITES=false/' /opt/zoho-integration-service/.env
  pct exec 9503 -- systemctl restart zoho-integration.service
  pct exec 122 -- sed -i 's/^ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED=.*/ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED=false/' /etc/luma/.env
  pct exec 122 -- sed -i 's/^ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED=.*/ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED=false/' /etc/luma/.env
}
trap cleanup_gates EXIT
# open window, run one commit, trap fires on any exit code
```

## Rules

- Open only long enough for one commit attempt.
- Never leave `ENABLE_LIVE_INVENTORY_WRITES=true` after the window.
- Never leave `luma.production_output.commit` granted after the window.
- Do not refresh preview immediately before commit unless using a **preview-only** idempotency key (`luma-production-output-preview:{lot}:{hash}`).
