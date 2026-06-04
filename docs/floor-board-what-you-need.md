# Floor board — what you need vs what Luma shows

You are not missing a setting or a magic phrase in prompts. The floor board needs **three layers** to line up before the screen answers your questions.

## The three layers

```
Floor scans & events          →    Read models (DB tables)    →    UI surfaces
(BAG_*, BLISTER_*, etc.)           read_bag_metrics, etc.          /floor-board
```

| Your question | Read model (already in Luma) | Command center (before fix) | Operations briefing |
|---------------|------------------------------|----------------------------|---------------------|
| What flavors produced today? | `read_daily_throughput` → `flavorToday` | Not shown | Material → units |
| Which machine is slower? | `read_bag_metrics` per machine | Not shown (tiles showed —) | Machines vs normal |
| Average cycle? | `read_bag_metrics.total_seconds` | Often — or wrong (stuck bags) | Time per step |
| What’s on each station? | `read_station_live` + station scans | Wrong source → “No bag scanned” | At a station now |

**Your examples were correct.** The gap was **layer 3**: the new command center UI did not mount metrics that `getFloorManagerSnapshot()` already returns.

## When numbers show “—” or look wrong

That is usually **data**, not you:

1. **Stuck WIP** — Bags open for days inflate queue age (4083m) and break averages. Andon “9 bags stuck” is real.
2. **Few finalized this shift** — With 3 bags, machine pace and avg cycle need those bags to be normal-length (&lt; 8h). Multi-day bags are excluded from avg on purpose.
3. **No throughput today** — `read_daily_throughput` for today’s date is empty → flavor row empty, trend flat at zero.
4. **Material runway 0h** — `read_material_burn` + `packaging_lots` missing or zero on hand.
5. **Station “No bag scanned”** — `read_station_live` empty but manager snapshot still knows WIP at station (two projectors). UI must merge both (fixed in line flow strip).

## What you should do on the floor (checklist)

- [ ] Finalize or clear ghost bags older than 1–2 days (biggest metric killer).
- [ ] Confirm tablets emit stage events (blister/seal/pack) so throughput read model updates.
- [ ] Scan bag at station when work starts (fills station tiles + “at a station now”).
- [ ] Use **Full operations briefing** for tables until command center shows all four answer panels.

## What engineering owns

- [x] Show `flavorToday`, machine pace, avg cycle, last completed on command center (`CommandCenterProductionAnswers`).
- [x] Merge `managerSnapshot.stations` into line flow tiles.
- [ ] Rebuild material projections if runway stays 0h with stock on hand.
- [ ] Optional: link to `/metrics` for deep dive (dictionary in `docs/METRICS_DICTIONARY.md`).

Canonical metric definitions: `docs/metrics-strategy.md` and `lib/production/metrics.ts`.
