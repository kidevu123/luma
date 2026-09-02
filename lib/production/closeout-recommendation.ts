// SIMPLIFY-A — collapse the closeout blocker stack into one recommended next
// action. Pure priority ladder over bucket counts; the page renders exactly
// one banner from this (details stay behind an expand).

import type { CloseoutBucket } from "./po-closeout";

export type CloseoutRecommendation = {
  headline: string;
  kind: "BULK_ISSUE" | "BULK_RELEASE" | "WORK_DO_HERE" | "FLOOR" | "ZOHO";
};

const bags = (n: number) => `${n} bag${n === 1 ? "" : "s"}`;

export function recommendCloseoutNextAction(input: {
  buckets: Record<CloseoutBucket, number>;
  issueReady: number;
  releaseReady: number;
}): CloseoutRecommendation | null {
  const { buckets, issueReady, releaseReady } = input;
  if (issueReady > 0) {
    return { headline: `${bags(issueReady)} ready to issue finished lots`, kind: "BULK_ISSUE" };
  }
  if (releaseReady > 0) {
    return { headline: `${releaseReady} lot${releaseReady === 1 ? "" : "s"} ready to release`, kind: "BULK_RELEASE" };
  }
  if (buckets.DO_HERE > 0) {
    return {
      headline: `${bags(buckets.DO_HERE)} need${buckets.DO_HERE === 1 ? "s" : ""} a decision here`,
      kind: "WORK_DO_HERE",
    };
  }
  if (buckets.ON_FLOOR > 0) {
    return { headline: `${bags(buckets.ON_FLOOR)} still in production on the floor`, kind: "FLOOR" };
  }
  if (buckets.WAITING_ZOHO > 0) {
    return { headline: `${bags(buckets.WAITING_ZOHO)} waiting on Zoho mapping or queueing`, kind: "ZOHO" };
  }
  return null;
}
