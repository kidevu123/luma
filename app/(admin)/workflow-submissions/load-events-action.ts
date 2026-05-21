"use server";

import { deriveBagGenealogy } from "@/lib/production/metrics";

export async function loadBagEventsAction(bagId: string) {
  return deriveBagGenealogy(bagId);
}
