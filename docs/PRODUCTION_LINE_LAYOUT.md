# Production line layout

How physical production lines map to Luma stations and floor-board order.

**Floor board rule:** stations render **left → right** in line order (blister before sealing before packaging). This is not alphabetical and not sorted by exceptions.

---

## Card route (primary)

Raw inventory bag → blister → sealing → packaging → finalize.

| Step | Line stage | Station kind | Operator role |
|------|------------|--------------|---------------|
| 1 | **Blister / form** | `BLISTER`, `HANDPACK_BLISTER` | Mount **PVC + foil** rolls. Scan bag card. Run machine; enter **machine cycle** count at blister complete / roll change. Cycles × **cards/turn** (Blister Machine = 2) = cards formed. |
| 2 | **Sealing** | `SEALING`, `COMBINED` | Choose **finished product/flavor** if not set upstream. Seal blisters into display cards. Counter = presses × **cards per press** (per sealing machine config). |
| 3 | **Packaging** | `PACKAGING` | Enter **master cases**, **displays made**, **loose/leftover cards**. System derives total finished cards and bag yield. |

### Material at blister (step 1)

- Roll receive weight is in **kg**.
- Counter segments sum to **machine cycles** per roll.
- Yield vs manufacturer compares cycles to **cycles/kg** (not × cards/turn).
- Packaging finalized counts reconcile **cards out** vs blister room **cards claimed**.

### Queues between steps

| Queue | Meaning |
|-------|---------|
| Blister queue | Bags blistered, waiting for sealing |
| Sealing queue | Bags sealed, waiting for packaging |
| Packaging queue | Bags at pack station / finishing |

---

## Bottle route (when used)

| Step | Stage | Station kind |
|------|-------|--------------|
| 1 | Fill / handpack | `BOTTLE_HANDPACK` |
| 2 | Cap seal | `BOTTLE_CAP_SEAL` |
| 3 | Label / induction | `BOTTLE_STICKER` |
| 4 | Packaging | `PACKAGING` |

Product is selected at **first production op** on the bottle route and inherited downstream.

---

## Multiple sealing machines

If you run **Sealing 1, 2, 3** in parallel, they share **step 2** on the line diagram — same role, different physical machines. Order within a step is by station label unless you configure explicit sequence later.

---

## Not documented in code yet

If your plant uses a **different physical order** (e.g. packaging before a secondary seal, or a separate handpack line), draw the floor layout and we will add a `plant_line_overrides` config so the board matches reality.

**Code source of truth:** `lib/floor-command/production-lines.ts`
