// STATION-NAV-CLEANUP-1 — production starts at floor station URLs (bag scan).
// Legacy /production/start bookmark; no admin fallback form.

import { redirect } from "next/navigation";

export default function StartProductionPage() {
  redirect("/floor-board");
}
