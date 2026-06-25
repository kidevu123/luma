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
