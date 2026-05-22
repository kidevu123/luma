# Handpack Blister Station Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `HANDPACK_BLISTER` station kind that replaces the blister machine when PVC/foil runs out or the machine goes down, auto-load unit-based material lots at deterministic stations, and capture pre-made blister consumption at the sealing step.

**Architecture:** New enum values + stage-progression entries mirror the existing `BOTTLE_HANDPACK` pattern. The projector gains one new stage-event mapping. Sealing detects handpack bags from bag-state and shows a count input; consumption fires a `PACKAGING_MATERIAL_ISSUED` event against the oldest available pre-made blister lot (FIFO). Auto-loading is read-only at page render time — no new persistent state needed.

**Tech Stack:** Next.js 15 App Router, TypeScript strict, Drizzle ORM + PostgreSQL 16, pg-notify projector, Tailwind v3.

---

## File Map

| File | Change |
|---|---|
| `lib/db/schema.ts` | Add `HANDPACK_BLISTER` to `stationKindEnum`; add `HANDPACK_BLISTER_COMPLETE` to `workflowEventTypeEnum` |
| `drizzle/0043_handpack_blister.sql` | Idempotent migration for both enum additions |
| `drizzle/meta/_journal.json` | Add idx 43 journal entry |
| `lib/production/stage-progression.ts` | Add routing entries for new station kind + event |
| `lib/production/first-op-product.ts` | Add `HANDPACK_BLISTER` to `FIRST_OP_STATION_KINDS` |
| `lib/projector/index.ts` | Add `HANDPACK_BLISTER_COMPLETE` to `STAGE_FOR_EVENT` |
| `app/(floor)/floor/[token]/actions.ts` | Add to `ALLOWED_EVENTS_BY_KIND`; add `sealHandpackBagAction` |
| `app/(floor)/floor/[token]/page.tsx` | Add station prereq mapping; auto-load lots panel; sealing count input |

---

## Task 1: Schema enum additions

**Files:**
- Modify: `lib/db/schema.ts`
- Create: `drizzle/0043_handpack_blister.sql`
- Modify: `drizzle/meta/_journal.json`

- [ ] **Step 1: Add enum values to schema.ts**

In `lib/db/schema.ts`, find `stationKindEnum` and add `"HANDPACK_BLISTER"`:

```typescript
// Before:
export const stationKindEnum = pgEnum("station_kind", [
  "BLISTER", "SEALING", "PACKAGING",
  "BOTTLE_HANDPACK", "BOTTLE_CAP_SEAL", "BOTTLE_STICKER", "COMBINED",
]);

// After:
export const stationKindEnum = pgEnum("station_kind", [
  "BLISTER", "SEALING", "PACKAGING",
  "BOTTLE_HANDPACK", "BOTTLE_CAP_SEAL", "BOTTLE_STICKER", "COMBINED",
  "HANDPACK_BLISTER",
]);
```

Find `workflowEventTypeEnum` and add `"HANDPACK_BLISTER_COMPLETE"` after `"BLISTER_COMPLETE"`:

```typescript
// Add after "BLISTER_COMPLETE":
"HANDPACK_BLISTER_COMPLETE",
```

- [ ] **Step 2: Create migration SQL**

Create `drizzle/0043_handpack_blister.sql`:

```sql
-- Add HANDPACK_BLISTER station kind
DO $$ BEGIN
  ALTER TYPE station_kind ADD VALUE IF NOT EXISTS 'HANDPACK_BLISTER';
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Add HANDPACK_BLISTER_COMPLETE event type
DO $$ BEGIN
  ALTER TYPE workflow_event_type ADD VALUE IF NOT EXISTS 'HANDPACK_BLISTER_COMPLETE';
EXCEPTION WHEN duplicate_object THEN null;
END $$;
```

- [ ] **Step 3: Update migration journal**

In `drizzle/meta/_journal.json`, add at the end of the `entries` array (copy the pattern from the idx 42 entry, increment to 43):

```json
{
  "idx": 43,
  "version": "7",
  "when": 1747872000000,
  "tag": "0043_handpack_blister",
  "breakpoints": true
}
```

- [ ] **Step 4: TypeScript check**

```bash
cd /Users/kidevu/luma && npx tsc --noEmit 2>&1 | head -20
```

Expected: no output (clean).

- [ ] **Step 5: Commit**

```bash
git add lib/db/schema.ts drizzle/0043_handpack_blister.sql drizzle/meta/_journal.json
git commit -m "feat: add HANDPACK_BLISTER station kind and HANDPACK_BLISTER_COMPLETE event type"
```

---

## Task 2: Stage progression routing

**Files:**
- Modify: `lib/production/stage-progression.ts`
- Modify: `lib/production/first-op-product.ts`

- [ ] **Step 1: Update EVENT_STAGE_PREREQ**

In `lib/production/stage-progression.ts`, add to `EVENT_STAGE_PREREQ`:

```typescript
// Add after BLISTER_COMPLETE entry:
HANDPACK_BLISTER_COMPLETE: ["STARTED"],
```

- [ ] **Step 2: Update STATION_RELEASE_FROM_STAGE**

In the same file, add to `STATION_RELEASE_FROM_STAGE`:

```typescript
// Add after BLISTER entry:
HANDPACK_BLISTER: "BLISTERED",
```

- [ ] **Step 3: STATION_PICKUP_FROM_STAGE — no entry needed**

`HANDPACK_BLISTER` is a first-op station (accepts via `CARD_ASSIGNED` on IDLE cards, not pickup). Do NOT add an entry to `STATION_PICKUP_FROM_STAGE`.

- [ ] **Step 4: Update FIRST_OP_STATION_KINDS**

In `lib/production/first-op-product.ts`, find `FIRST_OP_STATION_KINDS` and add `"HANDPACK_BLISTER"`:

```typescript
// Before:
export const FIRST_OP_STATION_KINDS: ReadonlySet<string> = new Set([
  "BLISTER",
  "COMBINED",
]);

// After:
export const FIRST_OP_STATION_KINDS: ReadonlySet<string> = new Set([
  "BLISTER",
  "COMBINED",
  "HANDPACK_BLISTER",
]);
```

- [ ] **Step 5: TypeScript check**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add lib/production/stage-progression.ts lib/production/first-op-product.ts
git commit -m "feat: add HANDPACK_BLISTER routing to stage-progression and first-op kinds"
```

---

## Task 3: Projector — advance bag to BLISTERED on HANDPACK_BLISTER_COMPLETE

**Files:**
- Modify: `lib/projector/index.ts`

- [ ] **Step 1: Add to STAGE_FOR_EVENT**

In `lib/projector/index.ts`, find the `STAGE_FOR_EVENT` mapping (around line 86). Add:

```typescript
// Add after BLISTER_COMPLETE entry:
HANDPACK_BLISTER_COMPLETE: "BLISTERED",
```

This is the only projector change needed. `HANDPACK_BLISTER_COMPLETE` does **not** trigger `emitMaterialConsumedFromBlister()` — that hook is exclusively for roll-weight-based consumption on the blister machine. Pre-made blister consumption happens at sealing (Task 5).

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add lib/projector/index.ts
git commit -m "feat: projector handles HANDPACK_BLISTER_COMPLETE → BLISTERED stage"
```

---

## Task 4: Floor actions — HANDPACK_BLISTER close-out

**Files:**
- Modify: `app/(floor)/floor/[token]/actions.ts`

- [ ] **Step 1: Add to ALLOWED_EVENTS_BY_KIND**

Find `ALLOWED_EVENTS_BY_KIND` (around line 92) and add:

```typescript
// Add after BLISTER entry:
HANDPACK_BLISTER: ["HANDPACK_BLISTER_COMPLETE"],
```

- [ ] **Step 2: Add HANDPACK_BLISTER_COMPLETE to fireStageEventAction schema**

Find `eventSchema` (the zod schema for `fireStageEventAction`, around line 434). The `eventType` field is a `z.enum([...])`. Add `"HANDPACK_BLISTER_COMPLETE"` to that enum:

```typescript
// Find the z.enum that lists event types, add:
"HANDPACK_BLISTER_COMPLETE",
```

- [ ] **Step 3: TypeScript check**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add "app/(floor)/floor/[token]/actions.ts"
git commit -m "feat: HANDPACK_BLISTER station can fire HANDPACK_BLISTER_COMPLETE"
```

---

## Task 5: Sealing action — plastic blister count + lot consumption

**Files:**
- Modify: `app/(floor)/floor/[token]/actions.ts`

This task adds a dedicated `sealHandpackBagAction` used only when the sealing station's current bag came from a `HANDPACK_BLISTER` station. The existing `fireStageEventAction` for `SEALING_COMPLETE` is unchanged and continues to handle normal (machine-blistered) bags.

- [ ] **Step 1: Add sealHandpackBagAction to actions.ts**

Add this function after `packagingCompleteAction`:

```typescript
// Schema
const sealHandpackSchema = z.object({
  token: z.string().min(1),
  stationId: z.string().uuid(),
  workflowBagId: z.string().uuid(),
  plasticBlisterCount: z.coerce.number().int().positive(),
});

export async function sealHandpackBagAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const parsed = sealHandpackSchema.safeParse({
    token: formData.get("token"),
    stationId: formData.get("stationId"),
    workflowBagId: formData.get("workflowBagId"),
    plasticBlisterCount: formData.get("plasticBlisterCount"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const { token, stationId, workflowBagId, plasticBlisterCount } = parsed.data;

  // Auth
  const station = await authStation(token, stationId);
  if (!station) return { error: "Invalid station token." };
  if (station.kind !== "SEALING") return { error: "Only SEALING stations may seal handpack bags." };

  // Stage check — bag must be BLISTERED
  const [bagState] = await db
    .select({ stage: readBagState.stage, isPaused: readBagState.isPaused, isFinalized: readBagState.isFinalized })
    .from(readBagState)
    .where(eq(readBagState.workflowBagId, workflowBagId))
    .limit(1);
  if (!bagState) return { error: "Bag not found." };
  if (bagState.isFinalized) return { error: "Bag is already finalized." };
  if (bagState.isPaused) return { error: "Resume the bag before sealing." };
  if (bagState.stage !== "BLISTERED") return { error: `Bag is at stage ${bagState.stage}, not BLISTERED.` };

  // Find oldest AVAILABLE pre-made blister lot (BLISTER_CARD, category MATERIAL)
  const [blisterLot] = await db
    .select({ id: packagingLots.id, qtyOnHand: packagingLots.qtyOnHand })
    .from(packagingLots)
    .innerJoin(packagingMaterials, eq(packagingMaterials.id, packagingLots.packagingMaterialId))
    .where(
      and(
        eq(packagingLots.status, "AVAILABLE"),
        eq(packagingMaterials.kind, "BLISTER_CARD"),
        eq(packagingMaterials.category, "MATERIAL"),
      )
    )
    .orderBy(asc(packagingLots.receivedAt))
    .limit(1);

  if (!blisterLot) return { error: "No available pre-made blister lot found. Receive stock first." };

  // Emit SEALING_COMPLETE + PACKAGING_MATERIAL_ISSUED in transaction
  await db.transaction(async (tx) => {
    const accountability = await resolveStationAccountability(tx, station.id);

    // SEALING_COMPLETE
    await projectEvent(tx, {
      eventType: "SEALING_COMPLETE",
      workflowBagId,
      stationId: station.id,
      employeeCode: accountability.employeeCode,
      payload: { plastic_blister_count: plasticBlisterCount },
    });

    // Consume from lot
    const consume = Math.min(plasticBlisterCount, blisterLot.qtyOnHand);
    await projectEvent(tx, {
      eventType: "PACKAGING_MATERIAL_ISSUED",
      workflowBagId,
      stationId: station.id,
      employeeCode: accountability.employeeCode,
      payload: {
        packaging_lot_id: blisterLot.id,
        qty_issued: consume,
        reason: "handpack_seal",
      },
    });

    // Decrement lot qty_on_hand
    await tx
      .update(packagingLots)
      .set({ qtyOnHand: sql`qty_on_hand - ${consume}` })
      .where(eq(packagingLots.id, blisterLot.id));
  });

  revalidatePath(`/floor/${token}`);
}
```

Add required imports at the top of actions.ts if not already present:
- `packagingLots`, `packagingMaterials` from `@/lib/db/schema`
- `asc` from `drizzle-orm`

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add "app/(floor)/floor/[token]/actions.ts"
git commit -m "feat: sealHandpackBagAction — SEALING_COMPLETE + consume pre-made blister lot"
```

---

## Task 6: Auto-load lot query helper

**Files:**
- Create: `lib/production/auto-load-lots.ts`

This helper is called from the floor station page to find available lots for deterministic-material stations. It's pure query logic — no side effects.

- [ ] **Step 1: Create the file**

Create `lib/production/auto-load-lots.ts`:

```typescript
import { db } from "@/lib/db";
import { packagingLots, packagingMaterials } from "@/lib/db/schema";
import { and, eq, asc } from "drizzle-orm";

export type AutoLoadedLot = {
  lotId: string;
  materialName: string;
  materialKind: string;
  qtyOnHand: number;
  boxNumber: string | null;
  supplierLotNumber: string | null;
};

// Maps station kind to the material kinds it auto-loads.
// Only unit-based materials are here — roll-based (PVC_ROLL, FOIL_ROLL)
// require physical mounting with tare weight and are loaded manually.
export const STATION_AUTO_MATERIAL_KINDS: Record<string, string[]> = {
  HANDPACK_BLISTER: ["BLISTER_CARD"], // category=MATERIAL filtered below
  BOTTLE_HANDPACK: ["BOTTLE", "CAP"],
  BOTTLE_CAP_SEAL: ["INDUCTION_SEAL"],
};

export async function loadAutoLots(
  stationKind: string,
): Promise<AutoLoadedLot[]> {
  const kinds = STATION_AUTO_MATERIAL_KINDS[stationKind];
  if (!kinds || kinds.length === 0) return [];

  // For HANDPACK_BLISTER: only MATERIAL category (not PACKAGING blister cards)
  const isMaterialOnly = stationKind === "HANDPACK_BLISTER";

  const rows = await db
    .select({
      lotId: packagingLots.id,
      materialName: packagingMaterials.name,
      materialKind: packagingMaterials.kind,
      qtyOnHand: packagingLots.qtyOnHand,
      boxNumber: packagingLots.boxNumber,
      supplierLotNumber: packagingLots.supplierLotNumber,
      category: packagingMaterials.category,
    })
    .from(packagingLots)
    .innerJoin(packagingMaterials, eq(packagingMaterials.id, packagingLots.packagingMaterialId))
    .where(
      and(
        eq(packagingLots.status, "AVAILABLE"),
        // drizzle inList — filter by kind
      )
    )
    .orderBy(asc(packagingLots.receivedAt));

  // Filter by kind in JS (avoids complex drizzle inList with category condition)
  return rows
    .filter((r) => {
      if (!kinds.includes(r.materialKind)) return false;
      if (isMaterialOnly && r.category !== "MATERIAL") return false;
      return true;
    })
    .map((r) => ({
      lotId: r.lotId,
      materialName: r.materialName,
      materialKind: r.materialKind,
      qtyOnHand: r.qtyOnHand,
      boxNumber: r.boxNumber,
      supplierLotNumber: r.supplierLotNumber,
    }));
}
```

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add lib/production/auto-load-lots.ts
git commit -m "feat: loadAutoLots helper — query available lots for deterministic-material stations"
```

---

## Task 7: Floor page — HANDPACK_BLISTER station UI + auto-load panel

**Files:**
- Modify: `app/(floor)/floor/[token]/page.tsx`

- [ ] **Step 1: Import new helpers**

At the top of `page.tsx`, add:

```typescript
import { loadAutoLots, STATION_AUTO_MATERIAL_KINDS } from "@/lib/production/auto-load-lots";
import { sealHandpackBagAction } from "./actions";
```

- [ ] **Step 2: Add STATION_PREREQ_STAGE mapping**

Find `STATION_PREREQ_STAGE` (around line 360) in `page.tsx`. It's a local map used for UI stage validation. Add:

```typescript
// Add after BLISTER entry:
HANDPACK_BLISTER: "STARTED",
```

- [ ] **Step 3: Load auto lots in the page data fetch**

In the `PoReconciliationListPage` default export (after the station and eligiblePickups queries), add:

```typescript
// Auto-load lots for deterministic-material stations
const autoLots = STATION_AUTO_MATERIAL_KINDS[station.station.kind]
  ? await loadAutoLots(station.station.kind)
  : [];
```

- [ ] **Step 4: Add AutoLoadedLotsPanel component**

Add this component at the bottom of `page.tsx`, before the final `}`:

```typescript
function AutoLoadedLotsPanel({ lots, stationKind }: { lots: AutoLoadedLot[]; stationKind: string }) {
  if (!STATION_AUTO_MATERIAL_KINDS[stationKind]) return null;

  return (
    <div className="rounded-xl border border-border bg-surface p-4 space-y-2">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
        Loaded materials
      </p>
      {lots.length === 0 ? (
        <p className="text-sm text-amber-700 font-medium">
          No available lots found — receive stock before starting.
        </p>
      ) : (
        <ul className="space-y-1">
          {lots.map((lot) => (
            <li key={lot.lotId} className="flex items-center justify-between gap-3 text-sm">
              <span className="font-medium">{lot.materialName}</span>
              <span className="tabular-nums text-text-muted font-mono text-xs">
                {lot.qtyOnHand} on hand
                {lot.boxNumber ? ` · box ${lot.boxNumber}` : ""}
                {lot.supplierLotNumber ? ` · lot ${lot.supplierLotNumber}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Render AutoLoadedLotsPanel on the station page**

In the page JSX, find where station details are rendered (after the scan form / active bag section). Add:

```tsx
<AutoLoadedLotsPanel lots={autoLots} stationKind={station.station.kind} />
```

- [ ] **Step 6: Add HANDPACK_BLISTER to the existing station-kind close-out button map**

Find wherever the page renders the "Complete" / close-out button based on station kind (the section that shows BLISTER_COMPLETE, SEALING_COMPLETE etc. buttons). Add `HANDPACK_BLISTER` so it renders a close-out button that fires `HANDPACK_BLISTER_COMPLETE` via `fireStageEventAction`:

```tsx
// HANDPACK_BLISTER uses the same close-out button pattern as BLISTER
// The eventType passed will be "HANDPACK_BLISTER_COMPLETE"
// Find the section rendering per-kind close-out forms and add:
{station.station.kind === "HANDPACK_BLISTER" && activeBag && (
  <HandpackCloseOutForm
    token={token}
    stationId={station.station.id}
    workflowBagId={activeBag.id}
  />
)}
```

Where `HandpackCloseOutForm` is a small form component that submits to `fireStageEventAction` with `eventType=HANDPACK_BLISTER_COMPLETE`. Look at how the existing `BLISTER` station renders its close-out form and copy that pattern exactly, substituting the event type.

- [ ] **Step 7: TypeScript check**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add "app/(floor)/floor/[token]/page.tsx"
git commit -m "feat: HANDPACK_BLISTER station UI with auto-load material panel"
```

---

## Task 8: Sealing station UI — detect handpack bag, show count input

**Files:**
- Modify: `app/(floor)/floor/[token]/page.tsx`

The sealing station page needs to detect if the active bag came from a `HANDPACK_BLISTER` station and conditionally render a plastic blister count form instead of the normal `SEALING_COMPLETE` button.

- [ ] **Step 1: Detect handpack bag on sealing page load**

In the page's data fetch (where `station.station.kind === "SEALING"` branches), query the active bag's prior event to check if it was `HANDPACK_BLISTER_COMPLETE`:

```typescript
// After loading activeBag for the SEALING station:
let bagIsHandpacked = false;
if (station.station.kind === "SEALING" && activeBag) {
  const [priorBlisterEvent] = await db
    .select({ eventType: workflowEvents.eventType })
    .from(workflowEvents)
    .where(
      and(
        eq(workflowEvents.workflowBagId, activeBag.id),
        // Check for HANDPACK_BLISTER_COMPLETE
      )
    )
    .limit(1);
  bagIsHandpacked = priorBlisterEvent?.eventType === "HANDPACK_BLISTER_COMPLETE";
}
```

Use `sql\`event_type = 'HANDPACK_BLISTER_COMPLETE'\`` if the Drizzle enum filter isn't available without casting.

- [ ] **Step 2: Add SealHandpackForm component**

Add this component at the bottom of `page.tsx`:

```typescript
function SealHandpackForm({
  token,
  stationId,
  workflowBagId,
}: {
  token: string;
  stationId: string;
  workflowBagId: string;
}) {
  return (
    <form action={sealHandpackBagAction} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="stationId" value={stationId} />
      <input type="hidden" name="workflowBagId" value={workflowBagId} />
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 space-y-3">
        <p className="text-sm font-semibold text-amber-800">
          Hand-packed bag — enter plastic blister count
        </p>
        <div className="flex items-center gap-3">
          <input
            type="number"
            name="plasticBlisterCount"
            min={1}
            required
            placeholder="0"
            className="w-28 rounded-lg border border-border bg-surface px-3 py-2 text-sm tabular-nums text-center"
          />
          <span className="text-sm text-text-muted">blisters sealed</span>
        </div>
        <button
          type="submit"
          className="w-full rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium py-2.5 transition-colors"
        >
          Complete sealing
        </button>
      </div>
    </form>
  );
}
```

- [ ] **Step 3: Render SealHandpackForm conditionally**

In the sealing station JSX, find where the normal `SEALING_COMPLETE` button is rendered. Wrap it:

```tsx
{station.station.kind === "SEALING" && activeBag && (
  bagIsHandpacked ? (
    <SealHandpackForm
      token={token}
      stationId={station.station.id}
      workflowBagId={activeBag.id}
    />
  ) : (
    // existing normal SEALING_COMPLETE form/button (unchanged)
    <NormalSealingForm ... />
  )
)}
```

- [ ] **Step 4: TypeScript check**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add "app/(floor)/floor/[token]/page.tsx"
git commit -m "feat: sealing station detects handpack bags, shows plastic blister count form"
```

---

## Task 9: Apply migration and deploy

- [ ] **Step 1: Push all commits**

```bash
git push origin luma-live-testing
```

- [ ] **Step 2: Verify migration runs on deploy**

Wait for the systemd timer to pick up the new HEAD (~60s), then check logs:

```bash
ssh root@192.168.1.190 'pct exec 122 -- bash -c "cd /opt/luma && docker compose logs --tail=20 app"'
```

Expected: "Migrations applied." with no errors.

- [ ] **Step 3: Verify enum values exist in DB**

```bash
ssh root@192.168.1.190 'pct exec 122 -- bash -c "cd /opt/luma && docker compose exec -T db psql -U luma -d luma -c \"SELECT unnest(enum_range(NULL::station_kind));\""'
```

Expected: `HANDPACK_BLISTER` appears in the list.

```bash
ssh root@192.168.1.190 'pct exec 122 -- bash -c "cd /opt/luma && docker compose exec -T db psql -U luma -d luma -c \"SELECT unnest(enum_range(NULL::workflow_event_type)) WHERE unnest LIKE \'%HANDPACK%\';\""'
```

Expected: `HANDPACK_BLISTER_COMPLETE` appears.

- [ ] **Step 4: Create a HANDPACK_BLISTER station in the admin UI**

Navigate to Settings → Machines & stations → add a new station with kind `HANDPACK_BLISTER`. Verify it appears in the station list.

- [ ] **Step 5: End-to-end smoke test**

1. Open the HANDPACK_BLISTER station's floor URL (`/floor/<scanToken>/`)
2. Scan an IDLE QR card — confirm product picker appears (first-op)
3. Assign the card — confirm bag appears in station
4. Submit close-out — confirm `HANDPACK_BLISTER_COMPLETE` fires and bag advances to `BLISTERED`
5. Open the SEALING station — scan the same card — confirm amber "hand-packed bag" banner and count input appears
6. Submit with a count — confirm `SEALING_COMPLETE` fires and a `PACKAGING_MATERIAL_ISSUED` event is recorded
7. Check `/packaging-inventory` — confirm the pre-made blister lot's `qty_on_hand` decreased

---

## Self-Review Notes

**Spec coverage:**
- ✅ HANDPACK_BLISTER station kind — Tasks 1, 2, 7
- ✅ HANDPACK_BLISTER_COMPLETE event — Tasks 1, 3, 4
- ✅ Sealing detects handpack + shows count — Tasks 5, 8
- ✅ Pre-made blister lot consumption at sealing — Task 5
- ✅ Auto-load for HANDPACK_BLISTER, BOTTLE_HANDPACK, BOTTLE_CAP_SEAL — Tasks 6, 7
- ✅ No BOM spec required (consumption from sealing count directly) — Task 5
- ✅ Mutual exclusion is operational (not enforced by code) — documented in spec, no task needed

**Placeholder check:** No TBDs. Task 7 Step 6 references "look at how BLISTER renders its close-out form" — this is intentional to avoid duplicating 50+ lines of existing JSX that will vary by codebase state.

**Type consistency:** `AutoLoadedLot` defined in Task 6 and imported in Task 7. `sealHandpackBagAction` defined in Task 5 and imported in Tasks 7/8. `STATION_AUTO_MATERIAL_KINDS` defined in Task 6, used in Task 7.
