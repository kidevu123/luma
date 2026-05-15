# Nexus / QIP customer complaint integration — implementation plan (NEXUS-0)

> **SUPERSEDED 2026-05-15** by `docs/COMMERCIAL_TRACEABILITY_PLAN.md`.
>
> The product goal changed: Luma is the finished-batch truth system, Zoho owns customer / invoice / sales-order truth, and Nexus is a thin read-only lookup UI that resolves invoice numbers and trace codes into Luma's recall passport. **Luma does NOT store customer complaints.** No `nexus_complaints` table, no inbound-complaint webhook, no `complaint_attachments`, no `complaint_status_history`, no `complaint_qc_events` join.
>
> This document stays committed for the boundary discussion + the open-question record. Implementation phases NEXUS-1..6 below are abandoned; the replacement ladder is COMMERCIAL-TRACE-1..8.
>
> The Luma → Nexus outbound side (LOT-1F/G, `NexusFinishedLotPayload`, `sendFinishedLotToNexusAction`) is still in place and still useful — it pre-populates Nexus's per-customer dropdown so customers can pick a trace code without typing it.

**Status (original).** Audit + plan only. No code, no schema changes, no live Nexus calls.

**Authoring branch.** `production-intelligence-command-center`
**Authored.** 2026-05-15
**Companion docs.**
- `docs/FINISHED_LOT_RECALL_PASSPORT_PLAN.md` (LOT-1A spec — boundary §5).
- `docs/CLAUDE_BUILD_QUEUE.md` LOT-1F / LOT-1G closeouts — outbound handoff already shipped.
- `docs/ZOHO_LIVE_SYNC_PLAN.md` §2 — Zoho owns customer master; Nexus uses Luma's `customers.nexus_customer_id` as the join key.

NEXUS-0 ends here. NEXUS-1..6 lands the actual implementation.

---

## 1. Current state audit

### 1.1 Outbound (Luma → Nexus) — already shipped (LOT-1F + LOT-1G)

| Surface | Path | What it does |
|---|---|---|
| Contract module | `lib/integrations/nexus/finished-lots.ts` | `validateNexusConfig`, `buildNexusFinishedLotPayload` (schema_version=1.0, customer-safe by default, supplier_lot hidden unless `customers.supplier_lot_visible=true`, NEVER carries `internal_receipt_number`), `isFinishedLotSendableToNexus` (typed reasons), `sendFinishedLotToNexus` (POST with `x-luma-nexus-secret` + `x-luma-finished-lot-id` + `x-luma-trace-code` headers), `stripNexusSecret`. |
| Admin action | `app/(admin)/finished-lots/[id]/labels/nexus-actions.ts` | `sendFinishedLotToNexusAction` — loads context, gates by `isFinishedLotSendableToNexus`, builds + posts payload; persists `nexus_sent_at` / `nexus_last_sent_response` / `nexus_last_send_error` on `shipment_finished_lots`; writes `audit_log` entries `nexus.finished_lot.send` / `nexus.finished_lot.send_failed`. |
| UI button | `app/(admin)/finished-lots/[id]/labels/_send-button.tsx` | "Send to Nexus" button with canonical copy: *"Send to Nexus creates a customer-facing finished-lot record for issue reporting. It does not create a complaint ticket."* |
| Verify harness | `scripts/verify-lot1g.ts` | In-container end-to-end test against a mock receiver. Happy + 500-failure paths. |
| Env vars | `NEXUS_FINISHED_LOT_URL`, `NEXUS_FINISHED_LOT_SECRET` | Currently unset on staging — `/finished-lots/[id]/labels` shows "Nexus not configured" honestly. |

**Net.** The Luma → Nexus side is complete, tested, and persisted. NEXUS-0 does not need to redesign it; the inbound side simply mirrors it.

### 1.2 Inbound (Nexus → Luma) — none today

- No webhook route exists. `app/api/integrations/nexus-qip/` is the planned directory; only `app/api/integrations/packtrack/` exists today.
- No inbound payload contract module, no DB tables, no admin UI, no test harness.
- The `docs/CLAUDE_BUILD_QUEUE.md` line 519 "Nexus / QIP batch-complaint integration" entry is a stub — this plan replaces it with NEXUS-0..6.

### 1.3 Schema relevant to NEXUS-0

| Table | Field | Role |
|---|---|---|
| `customers` | `id`, `customer_code`, `name`, `zoho_customer_id`, `nexus_customer_id`, `supplier_lot_visible`, `active` | Luma's customer master. `nexus_customer_id` is the join key Nexus will send back on inbound complaints. |
| `customers` | partial index `customers_nexus_idx` on `nexus_customer_id` WHERE NOT NULL | Already exists — fast lookup from inbound payload. |
| `shipments` | `id`, `po_id`, `carrier`, `tracking_number`, `shipped_at`, `delivered_at`, `customer_id` | Shipping records. |
| `shipment_finished_lots` | `id`, `shipment_id`, `finished_lot_id`, `customer_id`, `quantity`, `unit`, `shipped_at`, `nexus_sent_at`, `nexus_last_sent_response`, `nexus_last_send_error` | The exact join table Nexus will reference back. `id` is the stable Luma-side handle for one (shipment, finished_lot, customer) triple. Already unique on `(shipment_id, finished_lot_id)` and indexed on `nexus_sent_at`. |
| `finished_lots` | `id`, `trace_code`, `finished_lot_number`, `packed_at`, `expires_at`, `product_id` | Customer-facing trace code namespace. |
| `finished_lot_qc_events` | `id`, `finished_lot_id`, `event_type`, `occurred_at`, `workflow_event_id` | Existing QC linkage from LOT-1B. Inbound complaints will be a separate concept — see §6. |
| `finished_lot_raw_bags` | (M:N) | Already powers recall passport raw-bag drill-down. |
| `audit_log` | — | Every inbound write must `writeAudit`. |

### 1.4 Recall passport surface

- `lib/production/recall-passport-loaders.ts` exposes `getRecallPassport(input)` returning raw bags + finished lots + outputs + packaging lots + QC events + shipments + warnings + missingLinks + confidence.
- `/recall` UI is six-axis search (supplier_lot / internal_receipt_number / raw_bag_qr / finished_lot_trace_code / product_date_range / customer_date_range). Inbound complaints become a seventh diagnostic source — a NEXUS-side complaint id can be joined back to the same passport. **Adding "complaint id" as a recall search axis is in NEXUS-4.**

---

## 2. Data flow

### 2.1 Luma → Nexus (already implemented)

Trigger: admin clicks "Send to Nexus" on `/finished-lots/[id]/labels`. One `shipment_finished_lots` row per click.

```
POST {NEXUS_FINISHED_LOT_URL}
Headers:
  x-luma-nexus-secret: ********
  x-luma-finished-lot-id: <finished_lots.id>
  x-luma-trace-code: <finished_lots.trace_code>
Body: NexusFinishedLotPayload (LOT-1F)
  {
    schema_version: "1.0",
    source: "LUMA",
    customer: { customer_code, customer_name, nexus_customer_id },
    finished_lot: { finished_lot_id, trace_code, product_name, product_sku,
                    packed_at, expires_at, outputs: [...] },
    shipment:    { shipment_id, shipped_at, tracking_number, carrier },
    recall_passport: { confidence, warnings, missing_links, qc_summary,
                       supplier_lot_visible, supplier_lot_number? },
    links: { luma_recall_url, luma_finished_lot_url }
  }
```

Nexus's job after receiving: create a customer-facing "this lot was shipped to you" record so the customer dropdown only shows lots they actually received. Each push gives Nexus enough to display product / trace / pack date / outputs and to drill back to Luma via the recall URL.

### 2.2 Nexus → Luma (NEW — this plan)

Trigger: customer files a complaint inside the Nexus / QIP portal. Customer selects a finished-lot row from the dropdown that Luma already populated. Nexus POSTs the structured complaint back to Luma.

```
POST https://<luma-lxc>/api/integrations/nexus/complaints
Headers:
  x-nexus-secret: ********              (matches NEXUS_INBOUND_SECRET)
  x-nexus-complaint-id: <nexus_complaint_id>   (idempotency key)
  x-nexus-event: complaint.created | complaint.updated | complaint.resolved
  content-type: application/json
Body: NexusInboundComplaintPayload (defined in §7)
```

Luma's job after receiving:
1. Verify the secret header.
2. Look up the `customer` via `nexus_customer_id` → reject if unknown.
3. Look up the `shipment_finished_lots.id` → reject if missing or belongs to a different customer (anti-spoofing).
4. Upsert one `nexus_complaints` row keyed on `nexus_complaint_id`.
5. Optionally write child rows: `complaint_finished_lots`, `complaint_attachments`, `complaint_status_history`.
6. Notify the supervisor surface for review. **Never auto-create QC events, rework, or scrap.**

---

## 3. Customer dropdown behavior

### 3.1 Rules

| Rule | Enforcement |
|---|---|
| Customer sees only lots shipped to them | Nexus consumes the per-customer batch list from the LOT-1F payloads. Each `shipment_finished_lots` row Luma sent is scoped to one `nexus_customer_id`. Customer's session must be tied to that id. |
| No full catalog | Same — Nexus only knows about lots Luma explicitly pushed. |
| No free-form batch entry by default | The Nexus form should hard-disable a free-text "trace code" input; customer picks from the dropdown only. Admin / CSR override may exist in Nexus, never in the customer surface. |
| Hidden field uses `shipment_finished_lots.id` | The dropdown's `value` attribute is `shipment_finished_lots.id` (or a Nexus-side UUID that Nexus maps internally). `trace_code` is the visible label. Never use trace_code as the join key — it's a display string. |
| `trace_code` visible | Shown alongside product name + pack date + customer's PO number / tracking number for unambiguity. |
| Supplier lot hidden | Never on the customer-facing dropdown. Only visible internally + only when `customers.supplier_lot_visible=true` (the existing LOT-1B/LOT-1F gate). |

### 3.2 What the customer sees (illustrative)

```
Select the affected lot:
  ┌──────────────────────────────────────────────────────┐
  │ FL-2026-0123 · HN Daily Multi 30ct · packed 2026-04-12 │  ← shipment_finished_lots.id = abc-...
  │ FL-2026-0128 · HN Daily Multi 60ct · packed 2026-05-01 │  ← shipment_finished_lots.id = def-...
  │ FL-2026-0135 · HN Sleep Aid 30ct   · packed 2026-05-08 │  ← shipment_finished_lots.id = ghi-...
  └──────────────────────────────────────────────────────┘
```

### 3.3 Edge cases

- **Customer ships from multiple Luma customers (sub-accounts).** Nexus must surface every sub-account's lots if the customer's Nexus session ties to multiple `nexus_customer_id`s. Outside Luma's scope — Nexus solves this.
- **Customer reports against a lot Luma never shipped to them.** Inbound webhook rejects with `customer_lot_mismatch` (HTTP 422). The fact that Luma populated the dropdown should make this near-impossible, but the inbound validation catches manual API misuse.
- **Lot recalled before complaint filed.** Allowed. Recall and complaint are orthogonal — both reference the same finished_lot.

---

## 4. Luma inbound complaint model

**Decision: Luma stores its own complaint records.** Nexus remains the source of truth for ticket *workflow* (status, comments, CSR actions), but Luma needs durable storage of:
- which finished lot was complained about
- which customer
- what issue type
- when it landed
- the body of customer notes
- attachment references

…because the recall passport needs to surface "this lot had 3 customer complaints in the last 90 days" without a live Nexus call on every passport read, and because the supervisor review pane (§6) needs to read from a local source-of-truth.

### 4.1 New tables (migration `00XX_nexus_complaints` — number assigned at NEXUS-1)

```sql
-- complaint header. One row per Nexus complaint. nexus_complaint_id is
-- the idempotency key + the natural source-of-truth pointer.
CREATE TABLE nexus_complaints (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nexus_complaint_id       text NOT NULL,         -- Nexus-side UUID; idempotency key
  shipment_finished_lot_id uuid REFERENCES shipment_finished_lots(id) ON DELETE SET NULL,
  finished_lot_id          uuid REFERENCES finished_lots(id) ON DELETE RESTRICT,
  customer_id              uuid REFERENCES customers(id) ON DELETE SET NULL,
  issue_type               text NOT NULL,         -- "PACKAGING_DAMAGE" | "TABLET_QUALITY" | "TASTE" | "MISLABELED" | "FOREIGN_OBJECT" | "EFFECT" | "OTHER"
  severity                 text NOT NULL,         -- "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"  (Nexus-side classification mirrored)
  quantity_affected        integer,               -- count of units; nullable
  unit                     text,                  -- "tablets" | "bottles" | "displays" | "cases"
  customer_notes           text,                  -- verbatim customer comment, truncated to 4096 if needed
  submitted_at             timestamptz NOT NULL,
  nexus_url                text,                  -- back-link into Nexus for CSR drill-through
  status                   text NOT NULL DEFAULT 'OPEN',  -- mirror of Nexus status; "OPEN" | "IN_REVIEW" | "RESOLVED" | "REJECTED" | "WITHDRAWN"
  resolution_summary       text,                  -- set when Nexus marks resolved/rejected
  raw_payload              jsonb NOT NULL DEFAULT '{}'::jsonb,  -- verbatim inbound payload for forensics
  first_seen_at            timestamptz NOT NULL DEFAULT now(),
  last_updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX nexus_complaints_nexus_id_unique ON nexus_complaints (nexus_complaint_id);
CREATE INDEX nexus_complaints_lot_idx ON nexus_complaints (finished_lot_id);
CREATE INDEX nexus_complaints_customer_idx ON nexus_complaints (customer_id);
CREATE INDEX nexus_complaints_submitted_idx ON nexus_complaints (submitted_at DESC);
CREATE INDEX nexus_complaints_status_idx ON nexus_complaints (status);

-- attachment refs. Files live in Nexus storage; Luma stores a URL + a
-- content hash so the recall passport can show "3 photos attached" and
-- link out. We never proxy or store the binary.
CREATE TABLE complaint_attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id  uuid NOT NULL REFERENCES nexus_complaints(id) ON DELETE CASCADE,
  kind          text NOT NULL,                    -- "IMAGE" | "VIDEO" | "DOCUMENT" | "OTHER"
  filename      text,
  mime_type     text,
  byte_size     integer,
  content_sha256 text,
  url           text NOT NULL,                    -- Nexus-side URL
  thumbnail_url text,
  uploaded_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX complaint_attachments_complaint_idx ON complaint_attachments (complaint_id);

-- status / disposition history. Every inbound complaint.updated payload
-- appends one row here. Append-only; never updated, never deleted.
CREATE TABLE complaint_status_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id  uuid NOT NULL REFERENCES nexus_complaints(id) ON DELETE CASCADE,
  prior_status  text,
  new_status    text NOT NULL,
  actor         text,                             -- "NEXUS_CUSTOMER" | "NEXUS_CSR" | "LUMA_ADMIN" | "SYSTEM"
  notes         text,
  occurred_at   timestamptz NOT NULL,
  raw_payload   jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX complaint_status_history_complaint_idx ON complaint_status_history (complaint_id);
CREATE INDEX complaint_status_history_occurred_idx ON complaint_status_history (occurred_at DESC);
```

**Why a header + history rather than mutating one row?** The recall passport audit story benefits from immutable history; a customer who complains, withdraws, and re-files leaves a clean trail. Mirrors the LOT-1G pattern of preserving prior state.

### 4.2 Why not just store a Nexus reference and re-query?

- Recall passport pulls hundreds of finished-lot rows on a search; pre-fetching local complaint counts is O(1) per lot. A live Nexus call per lot would slow `/recall` to a crawl.
- Operator should still see the complaint summary even when Nexus is down.
- Audit story: regulator wants to know "how many complaints did this lot generate?" — Luma must answer authoritatively without dependency.

The trade-off: Luma's status field can lag Nexus by however long the webhook takes to fire. NEXUS-5 will add an outbound resend / status-poll panel so an admin can force-resync a stale row.

---

## 5. Traceability behavior

When a complaint lands in Luma, the supervisor screen (NEXUS-3) and the recall passport (NEXUS-4) both render the same context block:

| Field | Source |
|---|---|
| Customer | `customers.name`, `customer_code`, `nexus_customer_id` |
| Product | `finished_lots.product_id → products.name + .sku` |
| Finished lot trace code | `finished_lots.trace_code` |
| Shipment | `shipments` via `shipment_finished_lots.shipment_id` — carrier, tracking, shipped_at |
| Raw bags | `finished_lot_raw_bags` join — bag QR codes + internal receipt numbers (internal-only; never customer-visible) |
| Supplier lot | from `inventory_bags.supplier_lot_number` — internal-only by default. Only flagged to internal users; never re-exposed to customer-facing surface. |
| Machines + operators | Read from `workflow_bags` + `workflow_events` for the contributing bags (same data the recall passport uses) |
| Packaging lots | `finished_lot_packaging_lots` |
| QC history | `finished_lot_qc_events` — PACKAGING_DAMAGE_RETURN / REWORK_SENT / SUBMISSION_CORRECTED / etc. |
| Prior complaints | `nexus_complaints` GROUP BY `finished_lot_id` / `customer_id` / `product_id` — counts + last 5 |

Already-existing loaders cover most of this:
- `lib/production/recall-passport-loaders.ts` `getRecallPassport(input)` for the lot-side context
- Need new: `lib/production/complaint-loaders.ts` for the complaint-side context (prior complaints query + per-complaint detail). NEXUS-3 scope.

---

## 6. QC integration

**The hard rule: customer complaint is not proof of production loss.** Auto-creating SCRAP_RECORDED or REWORK_SENT from a customer complaint would corrupt internal yield/scrap math (an investigation might find the issue was customer-side mishandling, not Luma-side).

### 6.1 What a complaint may trigger

| Trigger | Action |
|---|---|
| Complaint arrives | Notification to the supervisor-review pane (NEXUS-3). No automatic data change. |
| Complaint is `HIGH` / `CRITICAL` severity | Same notification, plus a flag on the `/qc-review` page (NEXUS-4 surface change). |
| Supervisor reviews + decides production-side action is warranted | Supervisor clicks "Open QC investigation" — Luma creates a new internal QC event (`SUBMISSION_CORRECTED` or a new `INVESTIGATION_OPENED` type added in NEXUS-4) and links it to the complaint via `complaint_qc_events` (M:N — added in NEXUS-4). |
| Supervisor decides to scrap or rework affected stock | Existing QC actions (`recordScrapAction` / `recordReworkSentAction` from QC-2) — these emit normal QC events with full OP-1 accountability. The complaint is *referenced* in the QC event's notes / linked_event_id; it does not *cause* the QC event. |

### 6.2 What a complaint must NOT trigger

- Automatic `SCRAP_RECORDED` event.
- Automatic `REWORK_SENT` event.
- Automatic flip of `batches.status` to HELD or RECALLED.
- Automatic decrement of `material_inventory_events`.

### 6.3 Link target

Add a new table `complaint_qc_events (complaint_id, workflow_event_id, linked_at, linked_by_user_id, kind)` in NEXUS-4. `kind` distinguishes:
- `INVESTIGATION` — supervisor opened an inquiry but no production-side action yet.
- `QC_ACTION` — supervisor took a production-side action (scrap / rework / correction) attributed in part to this complaint.

---

## 7. API contracts

### 7.1 Outbound — Luma → Nexus (existing, recap)

See LOT-1F. `NexusFinishedLotPayload` defined in `lib/integrations/nexus/finished-lots.ts`. No changes in NEXUS-0..6 except possibly adding a `complaint_summary` field to the recall_passport block in NEXUS-5 (number of complaints landed for this lot) so Nexus can show a "this lot has 2 prior complaints" indicator.

### 7.2 Inbound — Nexus → Luma (NEW)

```typescript
type NexusInboundComplaintPayload = {
  schema_version: "1.0";
  source: "NEXUS";
  event: "complaint.created" | "complaint.updated" | "complaint.resolved";
  nexus_complaint_id: string;                          // idempotency key
  customer: {
    nexus_customer_id: string;
    customer_code?: string;                            // optional; Luma uses nexus_customer_id as the join
    customer_name?: string;
  };
  finished_lot: {
    shipment_finished_lot_id: string;                  // Luma's stable handle from the outbound payload
    trace_code?: string;                               // belt + suspenders — validated against the row
    finished_lot_id?: string;                          // optional cross-check
  };
  issue_type: "PACKAGING_DAMAGE" | "TABLET_QUALITY" | "TASTE" | "MISLABELED" | "FOREIGN_OBJECT" | "EFFECT" | "OTHER";
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  quantity_affected?: number;
  unit?: "tablets" | "bottles" | "displays" | "cases";
  customer_notes?: string;                             // verbatim; truncated server-side to 4096
  status: "OPEN" | "IN_REVIEW" | "RESOLVED" | "REJECTED" | "WITHDRAWN";
  resolution_summary?: string;                         // when status is RESOLVED / REJECTED
  attachments: Array<{
    nexus_attachment_id: string;
    kind: "IMAGE" | "VIDEO" | "DOCUMENT" | "OTHER";
    filename?: string;
    mime_type?: string;
    byte_size?: number;
    content_sha256?: string;
    url: string;
    thumbnail_url?: string;
    uploaded_at?: string;                              // ISO 8601
  }>;
  status_history?: Array<{
    prior_status?: string;
    new_status: string;
    actor: "NEXUS_CUSTOMER" | "NEXUS_CSR" | "LUMA_ADMIN" | "SYSTEM";
    notes?: string;
    occurred_at: string;                               // ISO 8601
  }>;
  nexus_url?: string;                                  // back-link
  submitted_at: string;                                // ISO 8601, original submission
};
```

### 7.3 Response shape

```typescript
// Success:
{ ok: true, complaint_id: "<luma uuid>", status: "OPEN" | "IN_REVIEW" | "RESOLVED" | ..., received_at: "..." }

// Idempotent replay (same nexus_complaint_id arrives twice):
{ ok: true, complaint_id: "<luma uuid>", status: "...", received_at: "...", replay: true }

// Validation failure:
HTTP 422 { ok: false, error: "validation_failed", reason_code: "...", details?: "..." }
   reason_codes: missing_secret | invalid_secret | unknown_customer | unknown_shipment_finished_lot |
                 customer_lot_mismatch | missing_required_field | invalid_event | schema_version_unsupported

// Server failure:
HTTP 500 { ok: false, error: "server_error" }      // no leak of inner detail
```

---

## 8. Security

### 8.1 Shared-secret auth (NEXUS-2 baseline)

- Env: `NEXUS_INBOUND_SECRET` (separate from the outbound `NEXUS_FINISHED_LOT_SECRET` — different direction = different secret).
- Header: `x-nexus-secret`. Constant-time comparison via `crypto.timingSafeEqual`.
- Whitespace = missing. Missing or mismatched → HTTP 401 with `missing_secret` / `invalid_secret` reason. No detailed diff in the response body.

### 8.2 HMAC body signing (future, NEXUS-5 or deferred)

Mirroring the PackTrack pattern, the secret-header model is enough for LAN traffic between LXC 9503 (Nexus) and LXC 122 (Luma). If Nexus moves off-LAN, layer in `x-nexus-signature: sha256=<hex(hmac(secret, body))>` and validate before parsing JSON. **NEXUS-0..4 stick with the simple secret header**; NEXUS-5 evaluates HMAC if the gateway moves to public internet.

### 8.3 Idempotency

- Header `x-nexus-complaint-id` mirrors body `nexus_complaint_id`. Webhook rejects if they disagree.
- DB-level: `nexus_complaints_nexus_id_unique` partial unique index on `nexus_complaint_id`. Re-POST = upsert.
- The webhook returns `replay: true` when the inbound matches an existing row byte-for-byte (deep-equal on `raw_payload`), so Nexus's retry logic doesn't double-count.

### 8.4 Supplier-lot exposure

- The inbound payload from Nexus must NEVER contain `supplier_lot_number`. Even if Nexus had it, Luma rejects the payload with `schema_version_unsupported` (we never gave Nexus any path to send it back).
- The outbound recall_passport block already enforces this; nothing changes inbound.

### 8.5 Customer-scope validation

- Lookup `shipment_finished_lot_id` → fetch its `customer_id` (Luma side) → must match the `customer_id` we resolve from the inbound `nexus_customer_id`. If they don't match → reject with `customer_lot_mismatch`. Prevents a compromised Nexus customer session from filing complaints against another customer's lots.

### 8.6 No-PII-in-logs

- `stripNexusSecret` helper already exists (LOT-1F) for outbound. NEXUS-2 adds the mirror inbound: `stripNexusComplaintSecret` redacts `x-nexus-secret`. OTel traces redact both.
- `customer_notes` is free-text from a customer — may contain phone numbers, addresses, complaint specifics. Stored verbatim in DB; rendered in admin UI; redacted in OTel `body` attributes.

### 8.7 Rate limiting

- Per source IP: 10 req / s with a 100-req burst (config in middleware or at the reverse proxy). Defends against accidental Nexus retry storms.
- Per `nexus_complaint_id`: at most 50 webhook calls in 1 h (status updates count). Higher cardinality protection.

---

## 9. Implementation phases

### NEXUS-0 — audit + plan (this document)
Stop after this file lands. Owner reviews the boundary + payload contracts + DB shape decision.

### NEXUS-1 — Luma inbound schema + validators
- Migration `00XX_nexus_complaints` adds `nexus_complaints`, `complaint_attachments`, `complaint_status_history`.
- `lib/integrations/nexus/complaints.ts` — pure validators + types:
  - `validateInboundComplaintConfig(env)` — checks `NEXUS_INBOUND_SECRET`.
  - `buildInboundComplaintHeaders` / `stripNexusComplaintSecret`.
  - `validateInboundComplaintPayload(body)` — Zod schema returning typed reasons.
  - `resolveLumaContextForComplaint(payload, db)` — looks up customer + shipment_finished_lot, returns context or typed failure.
- Tests: payload validation matrix (10 reason codes × happy path), schema fixtures.
- Stop: schema migrated on staging, validators tested against mocked payloads.

### NEXUS-2 — inbound webhook endpoint + idempotency
- Route `app/api/integrations/nexus/complaints/route.ts` (POST only). Mirrors `app/api/integrations/packtrack/receipts/route.ts` pattern.
- Server action `applyInboundComplaintAction` (called by the webhook): wraps validators + the DB upsert + audit_log entry + `complaint_status_history` insert in a single transaction.
- Idempotency tests: re-POST → `replay: true`; same id + different body → flagged in audit but does not silently overwrite (the `raw_payload` jsonb is replaced, the status history grows by 1).
- In-container verify harness `scripts/verify-nexus-2.ts` — mock-receiver pattern matching `verify-lot1g.ts`. Spawns an in-process HTTP server, sends a real payload, asserts the DB write + audit row + idempotent replay.

### NEXUS-3 — complaint admin page in Luma
- `/admin/complaints` — list view with filters (status / severity / issue_type / customer / date range / has_attachments). Same density patterns as `/qc-review`.
- `/admin/complaints/[id]` — detail view with full traceability block (§5).
- Sidebar entry.
- Auth smoke route count: 48 → 50 (list + detail).

### NEXUS-4 — link complaint ↔ recall passport ↔ QC review
- `complaint_qc_events` M:N join.
- `/recall` page surfaces "Customer complaints" section per lot, count + last 5 entries.
- `/qc-review` page surfaces a "Customer complaint mentions this bag" link when a complaint is open against a finished lot that contains a bag visible on that screen.
- Search axis: "Search by complaint id" added to `/recall` six-axis search → becomes seven-axis.
- `/admin/complaints/[id]` gains "Open QC investigation" + "Open scrap/rework form" buttons that pre-fill the existing QC actions with the complaint id in notes — operator-driven, never automatic.

### NEXUS-5 — outbound resend / status panel
- `/finished-lots/[id]/labels` (and the admin shipment-finished-lots detail) gains a "Pending Nexus pushes" + "Pending complaint syncs" status block.
- Add an optional `complaint_summary` block to the outbound `NexusFinishedLotPayload` (count of open + total complaints). Bumps schema_version to "1.1"; old Nexus consumers ignore the new field (additive only).
- Optional outbound endpoint hit: `POST /complaints/sync-request` to ask Nexus to re-emit any complaints we may have missed during a Luma downtime (operator-triggered).

### NEXUS-6 — staging verification + closeout
- `scripts/verify-nexus-end-to-end.ts` — mock customer-side complaint flow:
  1. Seed a shipment_finished_lot QA row.
  2. POST a `complaint.created` event.
  3. Assert the `nexus_complaints` row + audit entry land.
  4. POST a `complaint.updated` event with a new status.
  5. Assert `complaint_status_history` gains one row, header status updated.
  6. POST a `complaint.resolved` with attachments.
  7. Assert `complaint_attachments` populated.
  8. Re-POST the resolved event — assert `replay: true`.
- Cleanup of all QA rows. Auth smoke 50/50 PASS. Closeout docs.

---

## 10. Risks + open questions

### 10.1 Open questions (need Nexus-side input before NEXUS-1 starts)

1. **Does Nexus already have an auth + customer model?** Specifically: do Nexus customer sessions tie 1:1 to a `customers.nexus_customer_id`, or can one Nexus user span multiple Luma customers? If the latter, the dropdown filter logic in Nexus needs to OR across the user's accessible `nexus_customer_id`s; Luma's inbound validation can stay 1:1 because each complaint references one customer.
2. **What `nexus_customer_id` shape does Nexus use?** UUID? Auto-increment id? Email? Customer code? Luma's column is `text` so any string works; the spec assumes a stable opaque id Nexus generates and Luma stores.
3. **Does Nexus expose attachment URLs that Luma can fetch?** If they're signed and time-limited, Luma's recall-passport surface needs to refresh them or proxy them. Recommendation: store only the URL + sha256 on first receipt; let admin click-through to Nexus to view; no proxying.
4. **Should CSR resolution happen in Nexus or Luma?** Recommendation: **Nexus is authoritative for ticket workflow**. Luma's `nexus_complaints.status` is a mirror updated by `complaint.updated` / `complaint.resolved` webhooks. Luma admins can re-open / annotate locally, but the ticket lifecycle lives in Nexus.
5. **Should complaint creation trigger internal QC workflow?** No — per §6.2. Manual operator action only.
6. **What's the right severity-to-action mapping?** `CRITICAL` ⇒ supervisor email + dashboard pin? `HIGH` ⇒ dashboard pin only? Owner picks at NEXUS-3 time.
7. **Should Luma push a `complaint_count` enrichment to Nexus** so the customer dropdown shows "this lot has 1 prior complaint"? Useful for de-duplication but might bias subsequent complaints — defer to owner.

### 10.2 Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | Customer files a complaint against a lot Luma never shipped to them (manual API call or session compromise) | §8.5 hard validation. Audit log captures the rejection. |
| 2 | Nexus retries a failed webhook 100× in 5 minutes | §8.7 rate limiting; idempotency makes retries harmless. |
| 3 | Nexus is down when an admin needs complaint history | Local `nexus_complaints` table is source-of-truth for *recorded* state. Stale-status warning if `last_updated_at` > 7 days. |
| 4 | A customer complaint triggers a production-side scrap that shouldn't have happened | §6.2 hard rule. Supervisor must click through the QC form manually; complaint id is referenced, not authoritative. |
| 5 | Attachments contain PII or sensitive medical info | Files live in Nexus storage. Luma stores URL + hash only. Customer notes redacted in OTel. Admin UI access is `requireAdmin`. |
| 6 | Inbound payload contains `supplier_lot_number` someone added on the Nexus side | Reject with `schema_version_unsupported` (current spec is 1.0; the field isn't in 1.0). |
| 7 | Schema-version drift between Nexus and Luma | `schema_version: "1.0"` field is required + validated. Future versions add additive fields only; rejecting unknown required fields is the failure mode. |
| 8 | Customer files duplicate complaints (different `nexus_complaint_id`, same lot, same issue) | Allowed at the DB level — that's a real-world signal of a systemic problem. The admin UI groups by `finished_lot_id` so duplicates surface as a count. |
| 9 | A complaint references a `shipment_finished_lot_id` that was created but never actually pushed to Nexus (race) | Validate `shipment_finished_lots.nexus_sent_at IS NOT NULL` before accepting. If null → reject with `unknown_shipment_finished_lot`. |
| 10 | High-volume complaint storm overwhelms Luma's DB | Webhook writes are small (one row + history row + 0-5 attachments); even 1000 req/s would fit comfortably. Pre-flight with `EXPLAIN ANALYZE` in NEXUS-2 if owner expects burst load. |

---

## 11. Stop condition for NEXUS-0

This document committed. Owner answers the 7 open questions in §10.1 (or marks them defer-to-NEXUS-1). No code lands. No schema changes.

**NEXUS-1 is ready to start** once:
- Open questions §10.1 #1 (customer scope), #2 (id shape), and #4 (resolution authority) are answered. The other four are not blocking — they shape NEXUS-3..5 scope, not the schema.
- The migration number is assigned (after the latest applied migration on `main` / `production-intelligence-command-center`).
