# Zoho bag receive service-boundary prep (Phase Z-3)

**Date:** 2026-06-25  
**Baseline:** `a15fabb` (v1.5.24, Z-2 complete)  
**Scope:** Contract/equivalence tests + boundary classification only. **No runtime migration.**

---

## 1. Current bag receive payload ownership

Luma owns the full `BagFinishReceiveRequest` JSON today. The integration service receives it on existing endpoints and performs Zoho writes. Luma also owns freeze/replay, idempotency namespaces, commit state machine, and audit rows.

| Stage | Module | Runtime path |
|-------|--------|--------------|
| **Build (preview/legacy commit)** | `lib/zoho/bag-finish-receive.ts` → `buildBagFinishReceivePayload` | `previewBagFinishReceive`, `commitBagFinishReceive`, panel preview |
| **Build (freeze at seed/edit)** | `lib/zoho/freeze-raw-bag-receive-payload.ts` | `seedPendingRawBagReceiveRows`, `regenerateFrozenRawBagReceivePayload` |
| **Intake orchestration** | `lib/zoho/raw-bag-intake-receive.ts` | Path B intake → delegates to bag-finish preview/commit |
| **Shared commit + replay** | `lib/zoho/shared-raw-bag-receive-commit.ts` | Manual commit + auto-commit cron |
| **Service I/O** | `lib/zoho/bag-finish-receive-client.ts` | POST `/zoho/luma/bag-receive/preview` and `/commit` |
| **Preview idempotency** | `lib/zoho/source-receipt-evidence.ts` | `luma-bag-finish-receive:{inventory_bag_id}` |
| **Commit idempotency** | `lib/zoho/shared-raw-bag-receive-commit.ts` | `rbg-{sha256}` of op + PO + line + qty + date |
| **Notes (frozen body)** | `lib/zoho/zoho-commit-notes.ts` | Written into `commit_request_payload.notes` at freeze |

---

## 2. Payload path table

| Builder / store | Caller | Path | Input | Output | Frozen? | Idempotency | Audit | Tests |
|-----------------|--------|------|-------|--------|---------|-------------|-------|-------|
| `buildBagFinishReceivePayload` | `previewBagFinishReceive` | Preview (legacy flow) | `BagFinishReceiveBuildInput` from DB | `BagFinishReceiveRequest` (no notes) | No | `luma-bag-finish-receive:*` | preview status on row | `bag-finish-receive.test.ts`, Z-3 contract |
| `buildBagFinishReceivePayload` | `commitBagFinishReceive` | Legacy commit | same | same | No | preview key | commit audit | `bag-finish-receive.test.ts` |
| `freezeRawBagReceivePayloadAtSeed` | `seedPendingRawBagReceiveRows` | Intake seed | `zoho_raw_bag_receives` row + bag joins | `commit_request_payload` + `commit_idempotency_key` | **Yes** | `rbg-*` | `zoho_raw_bag_receive.payload_frozen` | Z-3 contract, `phase-h-acceptance.test.ts` |
| `regenerateFrozenRawBagReceivePayload` | staging edit / overs adjust | Edit buffer | same | refreshed freeze | **Yes** | new `rbg-*` | same action | `overs-resolution-contract.test.ts` |
| frozen replay | `sharedCommitRawBagReceive` | Manual + auto commit | `commit_request_payload` JSONB | outgoing payload + trigger suffix on notes | **Yes (preferred)** | stored `commit_idempotency_key` | commit state transitions | `shared-raw-bag-receive-commit.test.ts`, Z-3 contract |
| rebuild fallback | `sharedCommitRawBagReceive` | Legacy rows w/o freeze | `loadBagFinishReceiveContext` | rebuilt payload | No | derived `rbg-*` | logged fallback | Z-3 static contract |

**Mapping guards:** `loadBagFinishReceiveContext` and `loadRawBagReceiveContext` return `{ ok: false, reason }` when PO ID, PO line ID, or tablet Zoho item ID is missing — **no malformed payload is built**.

---

## 3. Field classification (Luma vs service)

| Field / concern | Class | Owner today | Target owner |
|-----------------|-------|-------------|--------------|
| `inventory_bag_id`, `luma_receive_id`, quantities, dates, receipt/lot identifiers | **Luma domain** | Luma | Luma |
| `quantity_source`, eligibility, allocation snapshot | **Luma domain** | Luma | Luma |
| `zoho_purchaseorder_id`, `zoho_purchaseorder_line_item_id`, `zoho_raw_item_id` | **Transitional** | Luma reads from local PO/product mapping | Service (after PO sync contract) |
| `BagFinishReceiveRequest` wire shape | **Zoho implementation** | Luma builder | Service |
| `notes` body formatting / truncation | **Zoho implementation** (accounting view) | Luma `zoho-commit-notes` | Service |
| Commit-trigger suffix on notes | **Audit field** | Luma at commit time | Luma (who pushed) |
| `commit_request_payload`, `commit_idempotency_key`, buffer timestamps | **Frozen replay** | Luma DB | Luma until service replay parity |
| `luma-bag-finish-receive:*` preview key | **Idempotency** | Luma | Unclear — may stay for source-receipt evidence |
| `rbg-*` commit key | **Idempotency/audit** | Luma | Must stay stable through migration |
| `zoho_raw_bag_receives` state machine | **Luma workflow** | Luma | Luma |
| Gateway 4xx `mapping_blockers` routing | **Transitional** | Luma parses | Shared contract |

---

## 4. Proposed service-boundary request shape

**Preparatory only** — pinned in `lib/zoho/bag-receive-service-boundary.contract.test.ts`.

```typescript
type ProposedBagReceiveDomainRequest = {
  inventory_bag_id: string;
  luma_receive_id: string;
  internal_receipt_number: string | null;
  human_lot_number: string | null;
  received_quantity: number;
  quantity_source: string;
  receive_date: string;
  zoho_purchaseorder_id: string;
  zoho_purchaseorder_line_item_id: string;
  zoho_raw_item_id: string;
};
```

**Proposed read-only service response** (for Luma to freeze):

```typescript
type ProposedBagReceiveServiceBuildResponse = {
  gateway_payload: BagFinishReceiveRequest & { notes: string };
  preview_idempotency_key: string;  // luma-bag-finish-receive:{bag_id}
  commit_idempotency_key: string;     // rbg-{hash}
};
```

Existing service endpoints (unchanged):

- `POST /zoho/luma/bag-receive/preview`
- `POST /zoho/luma/bag-receive/commit`

No documented external service repo contract was found in this repository; Z-3 fixtures are local/preparatory.

---

## 5. What Luma should keep

- `zoho_raw_bag_receives` workflow state (PENDING → COMMITTED, HELD, NEEDS_REVIEW, etc.)
- Frozen payload storage + 24h buffer semantics
- Commit idempotency key derivation (`rbg-*`) until gateway proves equivalent replay
- Auto-commit cron orchestration + env write gates
- Mapping blocker routing (`NEEDS_MAPPING` vs `NEEDS_REVIEW`)
- Audit log actions (`pending_seeded`, `payload_frozen`, `committed`)
- Source-receipt evidence for production-output gating

---

## 6. What should move to the service (later)

- `BagFinishReceiveRequest` JSON assembly (including notes body)
- Zoho field validation rules (PO/line/item existence, qty semantics)
- Custom-field / accounting formatting on the Zoho receive row

---

## 7. Migration blockers

1. **Two idempotency namespaces** — preview (`luma-bag-finish-receive:*`) vs commit (`rbg-*`) must not be collapsed during migration.
2. **Frozen replay** — operators review exact bytes in `commit_request_payload`; service must return byte-identical payloads or Luma keeps freezing locally.
3. **Dual commit paths** — `commitBagFinishReceive` (legacy, no freeze) vs `sharedCommitRawBagReceive` (frozen-first); migration must not break staging buffer path.
4. **Notes suffix** — commit-trigger line appended at send time must remain Luma-owned for audit clarity.
5. **No service build endpoint yet** — preview/commit accept full payloads; no read-only `build-payload` dual-run endpoint exists.

---

## 8. Recommended Phase Z-4 (one narrow step)

**Add a read-only integration-service endpoint (or extend preview with `dry_run=build_only`) that accepts `ProposedBagReceiveDomainRequest` and returns `ProposedBagReceiveServiceBuildResponse`.**

Luma dual-runs locally: compare service response to `freeze-raw-bag-receive-payload` output for golden fixtures. **Do not switch runtime builders until equivalence is proven in CI.**

Why this over other options:

- Preview/commit endpoints already exist — adding a third **read-only build** step avoids changing live commit/frozen replay.
- Keeps frozen payload + `rbg-*` keys in Luma during equivalence proving.
- Smaller blast radius than "Luma switches preview to service" or deleting local builders.

---

## 9. Z-3 deliverables

| Artifact | Path |
|----------|------|
| Contract tests | `lib/zoho/bag-receive-service-boundary.contract.test.ts` |
| This note | `docs/ZOHO_BAG_RECEIVE_CONTRACT_PREP_2026-06-25.md` |
| Audit cross-link | `docs/ZOHO_BOUNDARY_AUDIT_2026-06-25.md` §12 |

**No runtime, schema, env, or payload shape changes in Z-3.**

---

## 10. Phase Z-4 — dual-run equivalence (2026-06-25)

**Goal:** Prove Luma's local bag-receive builder against the service's new read-only build endpoint **before** any runtime migration. Equivalence proof only.

### 10.1 Service endpoint availability (preflight, Task 0)

| Check | Result |
|-------|--------|
| Service reachable (`GET /health`) | **Yes** — HTTP 200, `version: 1.28.0`, `db_connected: true` |
| Build route present (`POST /zoho/luma/bag-receive/build`) | **Yes** — returns `ZOHO_AUTH_MISSING` (Bearer required), not 404 → route registered |
| Capability `luma.raw_intake.build` | Expected per S-1; confirmed via build-route presence (no public capability list endpoint) |
| Luma local creds for live call | **Not provisioned on this workstation** — no `.env`, no `ZOHO_SERVICE_BEARER_SECRET` |

**Honesty note:** A live authenticated capture was **not possible from the dev workstation** (no bearer secret). The deterministic dual-run therefore compares Luma's real builder output against a fixture that **encodes the S-1 documented contract**. A second, **env-gated live dual-run test** (`it.skipIf`) calls the real endpoint and runs the same diff — it is **skipped** wherever creds are absent (CI/local) and provides the real proof when run in the deployed environment. No equivalence was faked.

### 10.2 Luma request mapper (isolated, not wired to runtime)

- `lib/zoho/bag-receive-build-service-client.ts`
  - `bagFinishReceiveBuildInputToDomainRequest()` — `BagFinishReceiveBuildInput` → `ProposedBagReceiveDomainRequest`
  - `callBagReceiveBuildService()` — read-only `POST /zoho/luma/bag-receive/build`, Bearer auth, **not** gated on `ZOHO_DRY_RUN_WRITES_ENABLED` (no side effects), **not** imported by any preview/commit/freeze path
  - `parseBagReceiveBuildResponse()`, `diffBagReceiveBuild()` — pure response parse + diff

### 10.3 Dual-run comparison results

Canonical input: full-bag Choco receive (qty 7219, PO/line/item mapped).

| Axis | Luma | Service (S-1) | Verdict |
|------|------|---------------|---------|
| Domain values (bag, receive, qty, source, date, PO, line, item) | from build input | `normalized_request` echo | **MATCH** |
| Core Zoho PR values (PO id, line id, item id, qty, date) | `buildBagFinishReceivePayload` | `zoho_purchase_receive_payload` | **MATCH** |
| `internal_receipt_number` nullability | `string \| null` (already nullable) | nullable | **MATCH** (no real divergence) |
| Preview idempotency key | `luma-bag-finish-receive:<inventory_bag_id>` | `luma-bag-receive-preview:<luma_receive_id>` | **MISMATCH** |
| Commit idempotency key | `rbg-<sha256>` (op + PO + line + qty + date) | service per-receive key | **MISMATCH** |
| Receive idempotency key | `luma-bag-finish-receive:<inventory_bag_id>` | service per-receive key | **MISMATCH** |
| Notes body | priority field list (`Luma op`, `Receipt #`, `Bag #`, `Internal receipt #`, `Qty`, …) | `luma_receive_id` + `quantity_source` | **MISMATCH** |
| Blockers / warnings (happy path) | n/a | `[]` / `[]` | **MATCH** |

### 10.4 Mismatch table + classification

| # | Mismatch | Classification | Action |
|---|----------|----------------|--------|
| M1 | Preview key namespace + source field (`bag_id` vs `luma_receive_id`) | **Must align before migration** | Do NOT collapse Luma namespaces (hard rule). Service should expose Luma's per-bag preview key OR Luma keeps minting it locally. Domain decision in Z-5. |
| M2 | Commit key format (`rbg-*` vs service key) | **Must align before migration** | Commit/frozen replay stays Luma-local; service must not own commit idempotency until replay parity proven. |
| M3 | Receive (source-receipt) key namespace | **Must align before migration** | `buildOutboundSourceReceipts` feeds production-output gating; key must stay stable. Keep Luma-owned. |
| M4 | Notes body fields/format | **Intentional difference (do not auto-fix)** | Per hard rule, notes formatting change needs explicit approval. Service notes are sparser; Luma's accounting notes are richer. Reconcile only after approval. |
| M5 | Core domain + Zoho values | **Harmless / equivalent** | Safe to rely on for preview build migration. |

### 10.5 Idempotency key comparison

| Key | Luma namespace | Service namespace | Collapse allowed? |
|-----|----------------|-------------------|-------------------|
| Preview | `luma-bag-finish-receive:` (per bag) | `luma-bag-receive-preview:` (per receive) | **No** (hard rule) |
| Commit | `rbg-` (hash) | service per-receive | **No** — stays Luma-local through migration |
| Receive (source receipt) | `luma-bag-finish-receive:` | service per-receive | **No** — production-output gate depends on it |

### 10.6 Notes-format comparison

- **Luma** (`buildRawBagReceiveNotes`): priority-ordered `label: value` lines, never-drop top 5 (`Luma op`, `Receipt #`, `Bag #`, `Internal receipt #`, `Qty`), 2000-char cap, accounting-rich.
- **Service** (S-1 build): includes `luma_receive_id` + `quantity_source`.
- **Verdict:** different content + format. Not byte-equal. Classified **intentional / approval-gated (M4)** — not changed in Z-4.

### 10.7 Blocker comparison

Happy-path build returns empty `blockers`/`warnings`. Luma's mapping guards (`loadBagFinishReceiveContext`) reject missing PO/line/item **before** building a payload. Service blocker semantics for missing mapping were not exercised live (no creds); to be confirmed in the env-gated live run.

### 10.8 Recommendation for Z-5

**Outcome 2 — align service build output first (minor/structural mismatches), keep Luma builder + commit/frozen replay local.**

Concretely, the single narrow Z-5 step:

> Reconcile the **preview idempotency key** contract (M1) only: either (a) have the service accept/echo Luma's per-bag preview key, or (b) confirm Luma continues minting `luma-bag-finish-receive:<bag_id>` and the service treats it as opaque. Add a contract test pinning the agreed behavior. **Do not** touch commit/receive keys (M2/M3), notes (M4), or switch runtime preview to the service yet.

Rationale: core payload + domain values already match (M5); the only true blocker to a *preview-build* switch is the preview-key contract. Commit/frozen replay and notes remain Luma-owned by hard rule until separately approved.

### 10.9 Z-4 deliverables

| Artifact | Path |
|----------|------|
| Isolated mapper + read-only client + diff | `lib/zoho/bag-receive-build-service-client.ts` |
| Dual-run equivalence tests (15 deterministic + 1 env-gated live) | `lib/zoho/bag-receive-build-dual-run.contract.test.ts` |
| This section | `docs/ZOHO_BAG_RECEIVE_CONTRACT_PREP_2026-06-25.md` §10 |

**No runtime preview/commit/freeze migration, no live Zoho writes, no schema/env changes, no idempotency-namespace collapse, no notes-format change in Z-4.**

---

## 11. Phase Z-5 — preview key alignment (2026-06-25)

**Goal:** Re-run the dual-run after service **S-2** and confirm the preview idempotency key mismatch (M1) is resolved.

### 11.1 Service S-2

| Item | Value |
|------|-------|
| Service commit | `4b5615cb1c90928007623e7d38e72aaa342b5590` |
| Change | Build endpoint accepts optional `preview_idempotency_key`; when provided, the service **echoes it verbatim** |
| Unchanged by S-2 | commit keys, receive keys, notes, preview route, commit route, idempotency persistence, audit behavior |
| Reachability (re-checked) | `/health` 200 (`v1.28.0`); build route present (auth-required) |
| Live capture from dev workstation | Still not possible (no bearer secret) — deterministic fixture + env-gated live test retained |

### 11.2 Luma client change (isolated)

- `buildBagReceiveBuildRequestBody(domain)` — attaches `preview_idempotency_key: "luma-bag-finish-receive:<inventory_bag_id>"` (Luma's existing per-bag key).
- `callBagReceiveBuildService` now sends that body + sets the `Idempotency-Key` header to the same value.
- Still **not** wired into runtime preview/commit/freeze. No namespace collapse — Luma keeps minting its own key; the service just echoes it.

### 11.3 Preview key echo — M1 RESOLVED

| | Luma | Service (S-2, key supplied) |
|---|------|----------------------------|
| Preview idempotency key | `luma-bag-finish-receive:<bag_id>` | `luma-bag-finish-receive:<bag_id>` (echoed) |
| Verdict | — | **MATCH** |

Regression guard: when no preview key is supplied, S-2 still falls back to `luma-bag-receive-preview:<luma_receive_id>` (pinned in tests).

### 11.4 Remaining mismatch table (honest)

| # | Mismatch | Status after Z-5 | Owner / action |
|---|----------|------------------|----------------|
| M1 | Preview idempotency key | **RESOLVED** (S-2 echo) | Service echoes Luma's per-bag key |
| M2 | Commit idempotency key (`rbg-*`) | **OPEN — stays Luma-owned** | Commit/frozen replay remains local until replay parity proven |
| M3 | Receive/source-receipt key | **OPEN — stays Luma-owned** | Production-output gate depends on it; keep Luma-owned |
| M4 | Notes body format | **OPEN — approval-gated** | Service notes (`luma_receive_id`+`quantity_source`) differ from Luma's priority list; change needs explicit approval |
| M5 | Core domain + Zoho values | **MATCH** | Safe for a future preview-build switch |

### 11.5 Recommendation for next phase

**Stop here for runtime; Luma runtime stays unchanged.** Two acceptable next steps, both contract-only:

1. **Preferred — stop / hold.** With M1 resolved and core values matching, a future preview-build switch is technically unblocked, but commit/frozen replay (M2/M3) and notes (M4) remain Luma-owned by hard rule. No further contract work is required to keep the system correct. Recommend pausing until a product decision authorizes a runtime preview switch.
2. **Optional Z-6 (contract-only) — align notes formatting in the service build endpoint**, then update the dual-run to assert notes equality. This must NOT touch Luma's runtime notes builder or commit/frozen replay, and requires explicit approval (M4 is approval-gated).

**Do not** migrate runtime preview/commit, collapse idempotency namespaces, or change notes formatting without a dedicated, approved brief.

### 11.6 Z-5 deliverables

| Artifact | Path |
|----------|------|
| Updated isolated client (preview-key echo) | `lib/zoho/bag-receive-build-service-client.ts` |
| Updated dual-run tests (M1 passes; M2/M3/M4 documented) | `lib/zoho/bag-receive-build-dual-run.contract.test.ts` |
| This section | `docs/ZOHO_BAG_RECEIVE_CONTRACT_PREP_2026-06-25.md` §11 |

**No runtime migration, no live Zoho writes, no commit/receive idempotency changes, no notes-format change, no schema/env changes in Z-5.**
