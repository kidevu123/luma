# QA — Auto lot issue and raw-bag allocation

Manual verification packet for production-output auto-issue, allocation sessions, and
legacy repair flows. Run on staging before promoting allocation changes.

## 1. Fresh Pink Rozay run

1. Scan/start a raw bag for Pink Rozay (or equivalent product with `tabletsPerUnit = 1`).
2. **Expect:** No yellow “Source bag allocation missing” banner on the floor station.
3. **Expect:** Allocation panel shows source receipt, OPEN session, and starting balance.
4. Complete blister/sealing/packaging with known counts (e.g. 9 cases / 20 displays / 2 loose).
5. Submit packaging complete on a PACKAGING station (not partial).
6. **Expect:** Finished lot auto-created and RELEASED.
7. **Expect:** Allocation session CLOSED/DEPLETED with `consumed = units × tabletsPerUnit`.
8. **Expect:** Production Output (`/packaging-output`) does not list the bag in the backlog.

## 2. Sealing-first product-mapped-later run

1. Start production at blister/handpack **before** choosing a product (when station allows).
2. **Expect:** Allocation session opens anyway (OPEN, linked to inventory bag).
3. Choose product at sealing (`saveSealingProductAction`).
4. **Expect:** Session remains valid or product linkage is joinable; no missing-allocation banner.
5. Complete packaging and submit counts.
6. **Expect:** Auto lot issue succeeds without manual tablet math.

## 3. Legacy backlog row (e.g. receipt `352315`)

1. Open **Production Output** → finalized backlog table.
2. **Expect:** Blocker = “Missing allocation session”, next step = “Repair allocation”.
3. Click **Repair allocation** (or open Issue Finished Lot with `?bagId=`).
4. **Expect:** Consumed prefills to `4002` when `unitsYielded = 4002` and `tabletsPerUnit = 1`.
5. **Expect:** Cannot save with consumed `0`.
6. If starting balance unknown, **expect:** form requires physical bag count + repair notes.
7. Save repair issue.
8. **Expect:** Allocation session created and closed; finished lot issued; audit events written.

## 4. Missing product setup

1. Use a product with missing `tabletsPerUnit` (test SKU only).
2. Finalize a bag without auto-lot.
3. **Expect:** Production Output blocker = “Missing tablets per unit”.
4. **Expect:** Action = “Fix product setup” linking to `/products/[id]`.
5. **Expect:** No path to save consumed `0` for a real production bag.

## 5. Negative ending balance

1. Use a bag where inferred starting balance &lt; expected consumed (test data).
2. **Expect:** Blocker = “Negative ending balance”.
3. **Expect:** Auto-issue blocked; UI explains review starting balance / consumption.
4. **Expect:** No silent clamp to zero ending balance.

## 6. Multiple source bags / ambiguous genealogy

1. Configure or simulate a workflow bag without a single deterministic `inventoryBagId`.
2. **Expect:** Blocker = “Multiple source bags need review” or “Missing source inventory bag”.
3. **Expect:** Only “Review manually” — no auto-issue or silent repair.

## 7. Zoho output already committed

1. Use a bag with a committed `zoho_production_output_ops` row.
2. **Expect:** Blocker = “Zoho output already committed”.
3. **Expect:** Auto-issue and repair mutations blocked.

## Automated regression

```bash
npx tsc --noEmit
npx vitest run lib/production/auto-lot-backlog-eligibility.test.ts \
  lib/production/expected-tablet-consumption.test.ts \
  lib/production/issue-lot-with-allocation-closeout.test.ts \
  lib/db/queries/finished-lots-auto.test.ts \
  app/(admin)/packaging-output/page.test.ts
npx next build
```

**Note:** Full `npx vitest run` may still fail on unrelated Zoho preview env gate tests
(`ZOHO_PRODUCTION_OUTPUT_PREVIEW_ENABLED`). Those failures are environmental, not allocation regressions.
