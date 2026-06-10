# Zoho raw-bag receipt granularity (v1.20.8)

## Decision: Policy A — one Zoho receive per physical bag

Path B intake may create multiple `inventory_bags` under one Luma `receives` row.
Each physical bag:

- has its own `internal_receipt_number` (Luma receipt)
- has its own `declared_pill_count`
- has its own `zoho_raw_bag_receives` row (unique `inventory_bag_id`)
- has its own idempotency key: `luma-raw-bag-receive:{inventory_bag_id}`
- commits its own Zoho purchase receive at full declared quantity

### Example: intake with 6 child bags

If one Luma intake receive contains six physical bags, committing all six creates
**six** Zoho purchase receives — not one combined receive.

### Policy B (not implemented)

One Zoho receive per Luma intake receive would require:

- parent intake-receive linkage on `zoho_raw_bag_receives`
- shared `zoho_purchase_receive_id` across child bags
- sum-of-child declared quantity on commit
- intake-receive-based idempotency

This is deferred. The schema prevents duplicate Zoho PR IDs across bags via
`zoho_raw_bag_receives_zoho_pr_unique`.

## ID semantics

| Field | Example | Meaning |
|-------|---------|---------|
| `internal_receipt_number` | `352176` | Luma operator receipt — never a Zoho entity ID |
| `zoho_purchase_receive_id` | `5254962000001234567` | Zoho Inventory entity ID |
| `zoho_receive_number` | `PR-00482` | Human-readable Zoho receive number |
