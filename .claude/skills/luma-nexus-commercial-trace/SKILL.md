---
name: luma-nexus-commercial-trace
description: Keep Nexus integration scoped. Nexus owns customer service / complaints / RMA / CSR workflow. Luma exposes batch + invoice + passport truth via read-only endpoints. Confirmed allocations only.
---

# Luma ↔ Nexus commercial trace

## When this skill applies

Any time you touch `app/api/nexus/*`, `lib/integrations/nexus/*`,
`lib/db/queries/nexus-lookups.ts`, or anything that talks about
customer-facing batch / invoice lookup.

## Responsibility split

| System | Owns |
|--------|------|
| **Nexus** | Customer service, complaints, RMA, CSR workflow, customer communication, ticketing |
| **Luma** | Batch / invoice / passport truth — exposes confirmed allocations through three read-only endpoints |

## Do NOT build inside Luma

- `nexus_complaints` table or any complaint workflow.
- Complaint attachment / status-history tables.
- Complaint webhook (unless explicitly approved by name in a later
  phase brief).
- CSR ticketing UI.
- Customer communication (email / SMS / portal messaging).
- Any UI that duplicates Nexus's existing complaint / RMA flow.

The Nexus team owns those surfaces. Luma surfaces production truth
they need to do their job.

## Three read-only endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /api/nexus/invoice-batches` | Given an invoice number, return its confirmed finished-lot allocations |
| `GET /api/nexus/customer-batches` | Given a customer id, return all confirmed allocations for that customer |
| `GET /api/nexus/batch-passport` | Given a trace_code or shipment_finished_lot_id, return the passport summary |

All three are **GET only**. POST/PUT/PATCH/DELETE return 405 with
`Allow: GET`. No write paths.

## Auth contract

| Header | Token | Scope |
|--------|-------|-------|
| `Authorization: Bearer <token>` | `NEXUS_LOOKUP_TOKEN` | customer |
| `Authorization: Bearer <token>` | `NEXUS_CSR_LOOKUP_TOKEN` | csr |

- Missing env vars → 503 `NEXUS_LOOKUP_NOT_CONFIGURED`.
- Missing / malformed header → 401.
- Wrong token → 401 (token value **never** echoed in any response).
- Constant-time compare via `safeEqual`.
- CSR may downgrade to customer-scope preview via `?scope=customer`.
- Customer cannot upgrade to CSR scope, ever.

## Confirmed-only gate

Every Nexus lookup query MUST filter:

```ts
and(
  eq(finishedLotInvoiceAllocations.confirmed, true),
  eq(finishedLotInvoiceAllocations.status, "CONFIRMED"),
)
```

`SUGGESTED`, `NEEDS_REVIEW`, and `REJECTED` allocations are never
exposed via Nexus endpoints. The engine never emits `HIGH` confidence
— that bumps via the per-row Confirm action only. Confidence on
Nexus responses is always `"HIGH"`.

## Customer-scope visibility (hard rules)

Customer scope **must hide**:

- `supplier_lot`, `supplier_lot_number`, `vendor_lot_number`
- `internal_receipt_number`
- `raw_bag_qr`, `bag_qr_code`
- `operator_name`, `operator_id`, `employee_name`, `employee_id`
- `machine_id`, `machine_label`, `station_id`, `station_label`
- `qc_history`

Enforce via `commercialTraceVisibilityPolicy("customer").allowField(field)`
plus the two sanitizers:

- `sanitizeNexusBatchForScope(batch, scope)` strips CSR-only fields
  from batch rows.
- `sanitizeNexusPassportForScope(passport, scope)` drops the seven
  CSR-only arrays from passport responses.

Even if a future change leaks a CSR-only field upstream, these
sanitizers act as the second line of defense before serialization.

## CSR / internal scope

CSR scope may see:

- Supplier lot / vendor lot
- Internal receipt number
- Raw bag QR
- PO / vendor
- Operators / machines / stations
- QC events
- Packaging lots
- Missing-link warnings

The passport surfaces `missing_links: string[]` honestly when data
isn't recorded. Never invent fills to make a passport look complete.

## Customer-scope ownership check

When a customer-scope caller passes `nexus_customer_id` or
`customer_code`, the endpoint must validate the requested batch /
invoice belongs to that customer. Mismatch → 422
`CUSTOMER_SCOPE_MISMATCH`. CSR scope skips the check (recall
investigations need full reach).

## Verification

`scripts/verify-commercial-trace.ts` is the canonical end-to-end
harness. It seeds a QA fixture, exercises all three endpoints, and
cleans up. Any new endpoint or sanitizer change must keep the
harness green.
