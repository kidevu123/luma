# Floor Scan E2E Verification — FLOOR-FIRST-RUN-E2E-2

Manual checklist to verify the camera-scan → product-select → Start production flow
on the live staging URL. Run this after every deploy that touches `scan-card-form.tsx`,
`actions.ts`, or the floor page.

**Staging URL:** `https://luma.booute.duckdns.org/floor/{token}`

Find a valid station token from the admin UI: Settings → Stations → click a first-op
station (BLISTER, HANDPACK_BLISTER, BOTTLE_HANDPACK, or COMBINED) → copy the QR scan
token from the station page URL or footer.

---

## Pre-conditions

- [ ] At least one received bag QR (status=ASSIGNED, no current workflow bag) available.
      Find via Admin → Inbound → pick a receive → check bag QR codes.
- [ ] At least one product is configured for the bag's tablet type at this station.
      Find via Admin → Products → confirm `allowedTabletTypeIds` is set.
- [ ] Staging is running the commit SHA you want to verify
      (`/api/health` returns the expected SHA in JSON).

---

## Path A: Camera scan → single product (auto-submit)

When exactly one product is compatible with the bag's tablet type, the form should
submit automatically without showing the product picker.

- [ ] Open the floor station URL on the tablet (or Chrome DevTools mobile emulator).
- [ ] Tap the camera icon. Camera preview opens.
- [ ] Aim at the bag QR code. QR is decoded and camera closes.
- [ ] Scan input field shows the bag label (e.g. `bag-card-117`).
- [ ] Green confirmation chip appears: "Scanned: {bag label}".
- [ ] Spinner shows briefly, then **page reloads with the active-bag panel** — no
      product picker, no extra button click needed.
- [ ] Active-bag panel shows "Making: {product name}" and a started-at timestamp.

---

## Path B: Camera scan → multiple products → manual pick → Start

When two or more products match the bag's tablet type, the product picker appears.

- [ ] Open the floor station URL.
- [ ] Tap the camera icon. Scan a bag QR with multiple compatible products.
- [ ] Scan input shows bag label. Green chip appears.
- [ ] **Product picker appears** ("What are you making?" amber card) with the
      compatible products listed by name.
- [ ] Pick a product from the dropdown.
- [ ] Tap "Start production".
- [ ] Page reloads with active-bag panel showing the chosen product name.

**Key regression checks during Path B:**
- [ ] Tapping "Start production" with a product selected does NOT re-show the scan
      input or reset the picker. (FLOOR-FIRST-RUN-E2E-1 regression: it used to re-scan.)
- [ ] If you tap "Start production" WITHOUT selecting a product, you see the error:
      "Pick a product before starting." The picker remains visible.

---

## Path C: Typed scan → product → Start

Same flow as Path B but using the keyboard/barcode-gun input instead of camera.

- [ ] Type a bag label (e.g. `bag-card-117`) into the scan input, press Enter.
- [ ] Lookup happens server-side, bag label and chip appear.
- [ ] Complete product pick + Start as in Path B.

---

## Path D: Scan failure shows error — does not blank the form

- [ ] Type a non-existent token (e.g. `bag-card-9999`) and press Enter.
- [ ] Red error banner appears: "QR code not found" (or similar).
- [ ] Scan input still shows the typed token. No blank fields or crashed overlay.
- [ ] Type the correct token and press Enter — lookup succeeds normally.

---

## Path E: Downstream (non-first-op) station — pickup path

Verify that a SEALING or PACKAGING station can pick up a bag already in production
using the scan path (no product picker shown).

- [ ] Open a sealing/packaging station floor URL.
- [ ] Scan the QR of a bag already at STARTED or BLISTER_COMPLETE stage.
- [ ] Page reloads with active-bag panel. No product picker appears (not a fresh bag).

---

## Post-submit DB check (optional but recommended for first deploy)

Connect to the staging database and verify the workflow records:

```sql
-- Most recent workflow bag + event
SELECT wb.id, wb.started_at, we.event_type, we.product_id, rsl.station_id
FROM workflow_bags wb
JOIN workflow_events we ON we.workflow_bag_id = wb.id
JOIN read_station_live rsl ON rsl.current_workflow_bag_id = wb.id
ORDER BY wb.created_at DESC
LIMIT 1;
```

Expected: `event_type = 'CARD_ASSIGNED'`, `product_id` populated (not null) for first-op
stations when a product was selected.

---

## Auth smoke reminder

After any deploy, run:

```bash
docker compose exec -T -e ALLOW_STAGING_QA_DATA=true app \
  sh -c 'node_modules/.bin/tsx scripts/smoke-authenticated-routes.ts'
```

Expected: `PASS=N  REDIR=0  FAIL=0` with the current route count.
