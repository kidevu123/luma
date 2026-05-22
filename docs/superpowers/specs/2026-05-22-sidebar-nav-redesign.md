# Sidebar Navigation Redesign

**Date:** 2026-05-22  
**Status:** Approved — ready for implementation planning

## Problem

The admin sidebar has 20 items spread across four sections, the last of which ("Advanced") is collapsed by default and contains 15 items including Dashboard and Live floor. The result is a navigation that requires hunting for common pages and buries the most-used views.

## Goal

Reduce the sidebar to 14 purposeful items structured around the actual daily workflow. Nothing buried. Dashboard and Live floor always one click away.

---

## New Sidebar Structure

### Pinned (always visible, no section heading)

| Label | Href |
|---|---|
| Dashboard | `/dashboard` |
| Live floor | `/floor-board` |

### OPERATIONS

Daily shift work — things an operator or supervisor touches every run.

| Label | Href | Notes |
|---|---|---|
| Start production | `/production/start` | unchanged |
| Receiving | `/inbound` | gains tabs (see below) |
| Pack-out | `/packaging-output` | unchanged |
| QC review | `/qc-review` | unchanged |

### INVENTORY

Review and traceability — things checked during or after a shift.

| Label | Href | Notes |
|---|---|---|
| Materials | `/packaging-inventory` | renamed from "Inventory"; gains tabs |
| Finished lots | `/finished-lots` | unchanged |
| Batches | `/batches` | moved from Advanced |
| Workflows | `/workflow-submissions` | moved from Oversight |
| Find lot | `/recall` | renamed from "Find lot / batch"; absorbs genealogy |

### REPORTS

| Label | Href | Notes |
|---|---|---|
| Metrics | `/metrics` | gains tabs (see below) |
| Productivity | `/operator-productivity` | moved from Advanced |

### Bottom link (no section heading)

| Label | Href |
|---|---|
| ⚙ Settings | `/settings` |

---

## Pages That Gain Tabs

Rather than keeping niche views as top-level sidebar items, they become tabs inside the page they naturally belong to.

### Receiving (`/inbound`) — new tabs

| Tab label | Currently at |
|---|---|
| Raw bags | (existing default view) |
| Packaging receipts | `/packaging-receipts` |
| PO reconciliation | `/po-reconciliation` |

The `/packaging-receipts` and `/po-reconciliation` routes remain functional (direct URL still works) but are no longer in the sidebar.

### Materials (`/packaging-inventory`) — new tabs

| Tab label | Currently at |
|---|---|
| Stock | (existing default view) |
| Active rolls | `/active-rolls` |
| Material alerts | `/material-alerts` |

### Metrics (`/metrics`) — new tabs

| Tab label | Currently at |
|---|---|
| Throughput | (existing default view) |
| Production reports | `/reports` |
| Capacity | `/production-capacity` |
| Roll variance | `/roll-variance` |

### Find lot (`/recall`) — absorbs genealogy

The Find lot page gains a detail section that surfaces bag genealogy (currently at `/genealogy`). When a lot or bag is found, a "Genealogy" link/tab on the detail view replaces the standalone sidebar entry.

---

## Settings Hub Additions

The Settings hub at `/settings` already exists. Add cards for pages that are currently in Advanced but belong to configure-once territory:

| Card label | Href | Currently |
|---|---|---|
| Product requirements | `/product-packaging-requirements` | Advanced |
| Zoho Operations | `/zoho-operations` | Advanced |
| Invoice allocations | `/invoice-allocations` | Advanced |
| Material reconciliation | `/material-reconciliation` | Advanced |

These four join the existing Settings hub cards (Users, Products, Tablet types, Machines & stations, Packaging & Materials, Blister standards, Standards & targets, Workflow validation, QR cards, Zoho Inventory, PackTrack).

---

## Items Removed from Sidebar

| Item | Where it goes |
|---|---|
| Dashboard | Pinned top |
| Live floor | Pinned top |
| Inventory (label) | Renamed to Materials, stays in sidebar |
| Capacity | Tab in Metrics |
| Material alerts | Tab in Materials |
| Active rolls | Tab in Materials |
| Production reports | Tab in Metrics |
| Roll variance | Tab in Metrics |
| PO reconciliation | Tab in Receiving |
| Packaging receipts | Tab in Receiving |
| Bag genealogy | Detail section in Find lot |
| Product requirements | Settings hub |
| Zoho Operations | Settings hub |
| Invoice allocations | Settings hub |
| Material reconciliation | Settings hub |
| Products (from Configure section) | Already in Settings hub; sidebar link removed |

---

## Schema Changes

None. This is a pure UI change — routing, labels, and tab structure only. All existing URLs remain functional.

---

## Files to Change

| File | Change |
|---|---|
| `components/admin/sidebar.tsx` | Restructure nav items array; new sections; remove Advanced |
| `app/(admin)/settings/page.tsx` | Add 4 new hub cards |
| `app/(admin)/inbound/page.tsx` | Add tab bar: Raw bags · Packaging receipts · PO reconciliation |
| `app/(admin)/packaging-inventory/page.tsx` | Add tab bar: Stock · Active rolls · Material alerts |
| `app/(admin)/metrics/page.tsx` | Add tab bar: Throughput · Production reports · Capacity · Roll variance |
| `app/(admin)/recall/page.tsx` | Add genealogy detail link when a bag/lot is found |

Tab bar implementation: simple `<nav>` with links that match the current pathname, consistent with the existing tab pattern in the codebase. No new shared component needed unless one already exists.

---

## What Does Not Change

- All existing page URLs — no redirects needed
- Floor PWA (`/floor/*`) — completely separate nav
- Mobile behavior — sidebar remains desktop-only
- Any page content — only the sidebar structure and tab bars change
