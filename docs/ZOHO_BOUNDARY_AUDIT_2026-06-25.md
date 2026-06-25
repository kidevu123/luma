# Zoho boundary audit — Phase Z-1 (2026-06-25)

**Status:** Audit / boundary mapping **complete**. **Stop line** — do not migrate or delete active Zoho behavior without a separate brief.

**Latest code commit at audit:** `10a23d9` (`v1.5.23`)  
**Related closeouts:** `docs/DUPLICATION_REDUCTION_CLOSEOUT_2026-06-25.md`, `docs/CLEANUP_CLOSEOUT_2026-06-25.md`  
**Policy:** Docs-only for this phase; no version bump.

---

## Rule for future Zoho work

**Do not merge behavior-sensitive Zoho paths unless equivalence is contract-proven first.**

Before moving logic to the integration service (or deleting Luma-owned logic):

1. Map call sites and runtime paths (admin preview vs consolidated cron vs manual commit).
2. Classify what is UI/local state vs payload construction vs business mapping vs network I/O.
3. Pin current behavior with contract tests where payloads or gates differ.
4. Only migrate when the service endpoint owns the same contract (idempotency, frozen replay, audit notes).

---

## 1. Current Zoho architecture inside Luma

Luma is **mostly** aligned with the integration-service boundary for live reads/writes, but still owns substantial **payload construction**, **BOM/source-allocation mapping**, **staging-buffer commit orchestration**, and **local operation state**.

```text
┌─────────────────────────────────────────────────────────────────┐
│  Admin UI / floor panels (status, forms, queue cards)           │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│  Luma orchestration (should stay transitional)                   │
│  • auto-commit-sweep, po-sync-sweep, enqueue-after-lot-create    │
│  • shared-*-commit (claim → frozen payload → gateway call)       │
│  • freeze-raw-bag-receive-payload, zoho-commit-notes             │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│  Luma payload / mapping (candidate to move to service)           │
│  • production-output-preview, luma-production-output-payload     │
│  • production-output-source-allocations, derive-normalized-bom   │
│  • v1206 pilot contracts, BOM dispatchers, bag-finish payloads   │
│  • operation-payloads (legacy assembly dry-run)                  │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│  Service clients (correct boundary layer)                        │
│  • assembly / inventory / bag-receive / production-output clients│
│  • brand-capabilities, component-batch-resolution                │
│  • lib/integrations/zoho/gateway (health/status + dry-run lists) │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTPS
┌────────────────────────────▼────────────────────────────────────┐
│  Zoho integration service (LXC 9503) → Zoho APIs                 │
└─────────────────────────────────────────────────────────────────┘

Exception (legacy): lib/zoho/client.ts → direct Zoho OAuth + zohoapis.com
```

**Scale:** ~129 files under `lib/zoho/**`, ~45 admin/app routes with Zoho in the path/name, ~11 under `lib/integrations/zoho/**`, plus cron routes, scripts, and extensive contract tests.

---

## 2. Zoho surface map (by layer)

| Area | Key paths | Classification |
|------|-----------|----------------|
| **Service HTTP clients** | `assembly-service-client.ts`, `inventory-service-client.ts`, `bag-finish-receive-client.ts`, `production-output-service-client.ts`, `production-output-preview.ts` (`callProductionOutputPreview`), `brand-capabilities-client.ts`, `component-batch-resolution.ts`, `lib/integrations/zoho/gateway.ts`, `items.ts`, `customers.ts`, `invoices.ts`, `manufacturing.ts` | Service client / gateway boundary |
| **Payload construction** | `luma-production-output-payload.ts`, `production-output-service-payload.ts`, `production-output-preview.ts` (build), `bag-finish-receive.ts` (`buildBagFinishReceivePayload`), `operation-payloads.ts`, `source-receipt-contract.ts`, `luma-operation-snapshot.ts` | Payload construction (Luma-owned today) |
| **Business rules / mapping** | `derive-normalized-bom-quantities.ts`, `v1206-*-pilot-contract.ts`, BOM dispatchers (consolidated + admin preview), `production-output-source-allocations.ts`, `product-family.ts`, `warehouse-resolution.ts`, `warehouse-decision.ts`, `source-receipt-evidence.ts`, `production-output-v1206-readiness.ts`, `assembly-planner.ts` | Business rule / brand-SKU mapping |
| **Commit orchestration** | `shared-raw-bag-receive-commit.ts`, `shared-production-output-commit.ts`, `auto-commit-sweep.ts`, `freeze-raw-bag-receive-payload.ts`, `zoho-commit-notes.ts`, `overs-resolution.ts` | Cron/queue orchestration + frozen-payload/audit safety |
| **Local DB workflow** | `lib/db/queries/zoho-production-output*.ts`, `zoho-production-output-consolidated.ts`, `raw-bag-intake-receive.ts`, schema tables (`zoho_*`) | Local DB workflow/audit state |
| **PO sync (read via service)** | `po-sync.ts`, `po-sync-sweep.ts`, cron `zoho-po-sync` | Cron orchestration; Zoho read via service |
| **UI / status only** | `zoho-operations/*`, `zoho-production-operations/*`, `zoho-queue-card.tsx`, `zoho-production-output-preview-card.tsx`, `raw-bag-zoho-receive-panel.tsx`, settings integration pages | UI/status only |
| **Legacy direct API** | `lib/zoho/client.ts` | **Direct Zoho API call** (OAuth refresh + `/organizations`) |
| **Gates / config** | `production-output-config.ts`, `auto-commit-write-gates.ts`, `controlled-production-output-window.ts`, `cron-auth.ts` | Env-gated safety (stay in Luma) |
| **Eligibility (unwired)** | `zoho-live-commit-eligibility.ts` | Business rule; guarded unwired |
| **Scripts / smoke** | `scripts/zoho-production-output-smoke*.ts`, archived pilots | Test-only / ops (not runtime app) |
| **Contract tests** | `phase-h-acceptance.test.ts`, `bom-dispatcher-behavior.contract.test.ts`, `dynamic-bom-dispatcher.contract.test.ts`, `*-contract.test.ts`, client `*.test.ts` | Tests pinning behavior |

---

## 3. Boundary call table (network I/O)

Base URL env vars:

| Env var | Role |
|---------|------|
| `ZOHO_INTEGRATION_URL` / `ZOHO_SERVICE_BASE_URL` | Integration service base URL |
| `ZOHO_INTEGRATION_SECRET` | `X-Internal-Token` (legacy gateway protocol) |
| `ZOHO_SERVICE_BEARER_SECRET` | `Authorization: Bearer` (Luma operation endpoints) |
| `ZOHO_BRAND` | `X-Brand` selector |
| `ZOHO_DRY_RUN_WRITES_ENABLED` | Blocks assembly/bag writes when not `true` |
| `ZOHO_*_COMMIT_ENABLED`, `ZOHO_AUTO_COMMIT_*` | Live-write and cron gates |

### Integration-service calls (all via `fetch`)

| File / function | Method | Path | Auth | Read/Write | Gated | Frozen payload | Tests |
|-----------------|--------|------|------|------------|-------|----------------|-------|
| `gateway.ts` `probeZohoGatewayHealth` | GET | `/health` | none | read | n/a | no | `gateway.test.ts` |
| `gateway.ts` `fetchZohoBrandStatus` | GET | `/status`, `/api/status` | `X-Internal-Token` | read | n/a | no | `gateway.test.ts` |
| `items.ts` `fetchZohoItemsDryRun` | GET | `/zoho/items/list` | `X-Internal-Token` | read | dry-run sync | no | `items.test.ts`, `sync-dry-run.test.ts` |
| `customers.ts` | GET | `/zoho/contacts_inv/list` | `X-Internal-Token` | read | dry-run sync | no | `customers.test.ts` |
| `invoices.ts` | GET | `/zoho/invoices/list` (etc.) | `X-Internal-Token` | read | dry-run sync | no | `invoices.test.ts` |
| `inventory-service-client.ts` | GET | `/zoho/purchaseorders_inv/list`, `/get/:id`, `/zoho/items/search`, `/zoho/warehouses/list`, `/zoho/purchase_receives/get/:id` | Bearer | read | PO sync flag | no | `inventory-service-client.test.ts` |
| `assembly-service-client.ts` `callZohoAssemblyService` | POST | `/zoho/purchase_receives/create`, `/zoho/assemblies/create` | Bearer | write | `ZOHO_DRY_RUN_WRITES_ENABLED` | no (dry-run assembly ops) | `assembly-service-client.test.ts`, `dry-run-client.test.ts` |
| `bag-finish-receive-client.ts` | POST | `/zoho/luma/bag-receive/preview`, `/commit` | Bearer | preview/write | dry-run + `ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED` for commit | **yes** on commit path | `bag-finish-receive.test.ts`, `shared-raw-bag-receive-commit.test.ts` |
| `production-output-preview.ts` `callProductionOutputPreview` | POST | `/zoho/luma/production-output/preview` | Bearer | preview | preview enabled config | partial (snapshot in payload) | `production-output-preview.test.ts`, preview wiring tests |
| `production-output-service-client.ts` `callProductionOutputCommit` | POST | `/zoho/luma/production-output/commit` | Bearer | write | `ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED` | **yes** (request from op row) | `production-output-config.test.ts`, `phase-h-acceptance.test.ts` |
| `brand-capabilities-client.ts` | GET | `/zoho/brand-capabilities/warehouse` | Bearer | read | n/a | no | `brand-capabilities-client.test.ts`, warehouse contract tests |
| `component-batch-resolution.ts` | POST | `/zoho/items/batches/resolve` | Bearer | read | batch resolve env | no | `production-output-v1206.test.ts` |
| `manufacturing.ts` `createManufactureOrder` | POST | `/zoho/manufacturing_orders/create` | `X-Internal-Token` | write (dry_run body) | gateway configured | no | (limited) |

### Direct Zoho API calls (inside Luma — **flagged**)

| File / function | Method | URL | Read/Write | Gated | Tests | Notes |
|-----------------|--------|-----|------------|-------|-------|-------|
| `lib/zoho/client.ts` `refreshAccessToken` | POST | `accounts.zoho.*/oauth/v2/token` | read (token) | requires `zoho_credentials` row | none dedicated | Uses DB-stored OAuth refresh token |
| `lib/zoho/client.ts` `testConnection` | GET | `www.zohoapis.*/inventory/v1/organizations/:id` | read | active credentials | via settings action | **Only production caller:** `app/(admin)/settings/zoho/actions.ts` |
| `lib/zoho/client.ts` `createPurchaseReceive` | — | — | — | — | — | **Stub** — throws not wired |

**Verdict:** One active direct-API path remains (`testConnection`). All other runtime Zoho I/O goes through the integration service.

---

## 4. Direct Zoho vs integration-service summary

| Category | Count (runtime) | Priority |
|----------|-----------------|----------|
| Integration-service `fetch` | ~15 endpoint families | Correct boundary — keep clients thin |
| Direct Zoho OAuth/API | 1 active (`testConnection`) | **Highest migration candidate** |
| Direct Zoho stub | 1 (`createPurchaseReceive`) | Safe to deprecate/guard (already throws) |
| Payload built in Luma, sent to service | 3 major flows (bag receive, prod output preview/commit, legacy assembly dry-run) | Transitional — move validation/assembly to service incrementally |
| No network (local only) | BOM dispatchers, eligibility, UI state, DB ops | Stay in Luma until service owns equivalent contracts |

**Auth split note:** Luma uses **two** service auth models today (`X-Internal-Token` for older gateway list/manufacturing routes; `Bearer` + `Idempotency-Key` for Luma operation endpoints). Consolidating auth at the service client layer is a future hygiene item, not a Z-1 migration.

---

## 5. What belongs in Luma vs the Zoho service

| Concern | Target owner | Rationale |
|---------|--------------|-----------|
| Queue cards, status chips, admin forms | **Luma** | UI only |
| `zoho_*` tables, op status lifecycle, audit_log | **Luma** | Local workflow state |
| Cron routes (`zoho-auto-commit`, `zoho-po-sync`) | **Luma** (orchestrator) | Schedules + gates; service executes writes |
| Env live-write gates | **Luma** | Deployment safety |
| Frozen payload storage + replay on commit | **Luma** (transitional) | Until service stores/replays equivalent audit/idempotency |
| Commit notes formatting | **Shared contract** → eventually **service** | Same bytes manual/auto; low risk to centralize later |
| Production-output / bag-receive **payload JSON** | **Service** (target) | Zoho field rules belong at boundary |
| BOM normalization, pilot fallbacks, source allocations | **Service** (target) | Brand/SKU mapping should not live in Luma long-term |
| Batch resolve, warehouse capability, PO/item reads | **Service** (already) | Luma clients are thin — keep |
| OAuth token refresh | **Service only** | `lib/zoho/client.ts` violates architecture |

---

## 6. Migration candidate table

| Luma module / file | Current responsibility | Stay in Luma? | Target owner | Risk | Blocker before deletion | Suggested phase |
|--------------------|------------------------|---------------|--------------|------|-------------------------|-----------------|
| `lib/zoho/client.ts` | Direct OAuth test + stub receive | **No** | Service `/status` + receive endpoints | **Low** (read-only test) | Settings UI switched to gateway readiness | **Z-2** |
| `operation-payloads.ts` + `dry-run-client.ts` | Legacy assembly op payload + dry-run POST | Transitional | Service validates assembly payloads | Medium | Parity for `zoho_assembly_ops` dry-run | Z-3+ |
| `luma-production-output-payload.ts`, `production-output-preview.ts` (build*) | Full production-output request body | Transitional | Service | **High** | Frozen payload + snapshot + source_receipts contract tests | Z-4+ |
| `bag-finish-receive.ts` (build*) | Raw bag receive request body | Transitional | Service | **High** | Frozen commit replay tests | Z-4+ |
| `derive-normalized-bom-quantities.ts`, pilot contracts, BOM dispatchers | SKU/BOM mapping | **No** (eventually) | Service | **High** | D-3 proved dispatcher divergence; service must own both paths | Z-5+ |
| `production-output-source-allocations.ts` | Luma allocation rows → component_batches | Transitional | Service | High | Assembly-level scoping contracts | Z-5+ |
| `shared-*-commit.ts`, `freeze-*`, `auto-commit-sweep.ts` | Claim, gate, call service, persist | **Yes** (orchestrator) | Luma | High if moved blindly | Service idempotency + replay semantics | Keep; thin over time |
| `po-sync.ts` | Map service PO reads → local PO tables | **Yes** | Luma | Low | None for reads | Keep |
| `inventory-service-client.ts` etc. | HTTP to service | **Yes** (thin clients) | Shared contract | Low | None | Keep; avoid duplicating response parsing in many places |
| `zoho-live-commit-eligibility.ts` | Pre-commit UI eligibility | **Yes** until wired | Luma | Medium | UI wiring + guard removal | Z-6 |
| `assembly-planner.ts` / `assembly-enqueue.ts` | Legacy assembly queue | Transitional | Review | Medium | Usage audit vs consolidated path | Audit Z-3 |
| Admin UI (`zoho-operations`, preview cards) | Display / actions | **Yes** | Luma | Low | n/a | Keep |

---

## 7. Safe deletion / deprecation vs blockers

| Module | Classification | Notes |
|--------|----------------|-------|
| `lib/zoho/client.ts` `createPurchaseReceive` | **Safe to deprecate/guard** | Already throws; no callers |
| `lib/zoho/client.ts` `testConnection` | **Must remain until service substitute** | Settings page still uses it; replace with gateway `/status` in Z-2 |
| Pilot contracts (`v1206-*`) | **Must remain** | Transition fallback until all SKUs on Luma product data |
| Frozen payload modules | **Must remain (frozen/audit replay)** | `phase-h-acceptance.test.ts`, overs-resolution contracts |
| Shared commit modules | **Must remain** | Single entry for manual + cron commits |
| BOM dispatchers | **Must remain** | D-3 contracts forbid naive merge |
| `loadRawBagReceiveContext` overlap | **Do not touch** | High-risk loader semantics |
| Legacy assembly dry-run | **Unclear / needs domain decision** | May overlap consolidated production-output path |
| Direct API code in `client.ts` | **Safe to delete after Z-2** | Once settings uses gateway only |

---

## 8. High-risk items — do not touch in casual refactors

1. **Frozen payload commit paths** — `shared-raw-bag-receive-commit.ts`, `shared-production-output-commit.ts`, `freeze-raw-bag-receive-payload.ts`
2. **Production-output payload shape** — `ProductionOutputPreviewPayload`, snapshot attach, `source_receipts`
3. **BOM dispatchers** — consolidated vs admin intentional divergence (`bom-dispatcher-behavior.contract.test.ts`)
4. **Auto-commit sweep + write gates** — `auto-commit-sweep.ts`, `auto-commit-write-gates.ts`
5. **Idempotency keys** — `luma-production-output-payload.ts`, `source-receipt-evidence.ts`, bag receive keys
6. **PO sync status mapping** — terminal status downgrade rules in `po-sync.ts`

---

## 9. Recommended Phase Z-2 (one narrow step)

**Replace legacy direct Zoho OAuth `testConnection` with integration-service readiness.**

Scope:

1. Update `/admin/settings/zoho` to use existing `lib/integrations/zoho/gateway.ts` (`deriveZohoReadiness` / brand status) instead of `lib/zoho/client.ts` `testConnection`.
2. Add a guard test: no `zohoapis.com` / `Zoho-oauthtoken` fetch in app runtime paths except deprecated module (or delete `client.ts` after migration).
3. Do **not** change bag receive, production output, PO sync, or commit behavior.

Why this first: it is the **only remaining direct Zoho API call** in runtime code, read-only, settings-scoped, and does not touch frozen payloads or live writes.

Alternative Z-2 (if product prefers payload work): add a **contract test suite** asserting the integration service validates bag-receive payloads identically to Luma's builder — prerequisite before moving `buildBagFinishReceivePayload` behind the service.

---

## 10. Gate snapshot at audit

- Duplication phase closed at `fa15baf`; latest feature commit `10a23d9` (`v1.5.23`)
- vitest **4631** at last full gate run
- This document: **docs-only**, no runtime changes

---

## Appendix — key env vars (`ZOHO_*`)

| Variable | Purpose |
|----------|---------|
| `ZOHO_INTEGRATION_URL` / `ZOHO_SERVICE_BASE_URL` | Service base URL |
| `ZOHO_INTEGRATION_SECRET` | Gateway internal token |
| `ZOHO_SERVICE_BEARER_SECRET` | Bearer auth for Luma operation endpoints |
| `ZOHO_BRAND` | Brand selector |
| `ZOHO_DRY_RUN_WRITES_ENABLED` | Assembly/bag write dry-run gate |
| `ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED` | Live bag receive commit |
| `ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED` | Live production-output commit |
| `ZOHO_PRODUCTION_OUTPUT_*` | Preview/persist/auto-queue flags |
| `ZOHO_AUTO_COMMIT_ENABLED` | Cron auto-commit master switch |
| `ZOHO_PO_SYNC_ENABLED` | Daily PO sync cron |
| `ZOHO_WAREHOUSE_ID` | Default warehouse fallback |
| `ZOHO_PRODUCTION_OUTPUT_BATCH_RESOLVE` | Batch resolution opt-in |
| `ZOHO_ALLOW_SCRIPT_COMMIT_BYPASS` | Controlled window scripts only |

(Legacy OAuth credential fields live in **`zoho_credentials`** DB table for warehouse defaults and the `/settings/zoho` form. **Z-2 (2026-06-25, `v1.5.24`):** removed `lib/zoho/client.ts`; Test connection on that page now uses gateway readiness only — no direct Zoho API calls remain in Luma runtime code.)

---

## 11. Phase Z-2 closeout (2026-06-25)

**Commit:** `v1.5.24` — settings Test connection routed through `lib/integrations/zoho/gateway.ts`.

| Before | After |
|--------|-------|
| `testZohoConnectionAction` → `lib/zoho/client.ts` `testConnection` → OAuth refresh + `GET zohoapis.com/.../organizations/:id` | `testZohoConnectionAction` → `checkZohoGatewayHealth` + `fetchZohoBrandStatus` + `deriveZohoReadiness` |
| `lib/zoho/client.ts` present (direct OAuth) | **Deleted** — zero runtime importers |
| No guard against direct API reintroduction | `lib/zoho/zoho-direct-api-boundary-guard.test.ts` |

**Unchanged:** bag receive, production output, PO sync, commits, frozen payloads, env gates, `zoho_credentials` schema.

**Next (Z-3+):** payload-builder / BOM mapping migration behind service contracts — not started.

---

## 12. Phase Z-3 closeout (2026-06-25)

**Scope:** Bag receive payload contract proof only. Tests + docs; no runtime migration.

| Deliverable | Path |
|-------------|------|
| Contract tests | `lib/zoho/bag-receive-service-boundary.contract.test.ts` |
| Prep note | `docs/ZOHO_BAG_RECEIVE_CONTRACT_PREP_2026-06-25.md` |

**Pinned:** payload path map, mapping blockers before build, frozen payload + `rbg-*` idempotency, shared commit frozen-first replay, proposed `ProposedBagReceiveDomainRequest` derivation.

**Recommended Z-4:** read-only service build endpoint + Luma dual-run equivalence against freeze output (see prep doc §8).
