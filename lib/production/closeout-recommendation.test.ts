import { describe, it, expect } from "vitest";
import { recommendCloseoutNextAction } from "./closeout-recommendation";

const zero = { DO_HERE: 0, ON_FLOOR: 0, WAITING_ZOHO: 0, DONE: 0, EMPTY: 0 };

describe("SIMPLIFY-A: recommendCloseoutNextAction — one recommended action, not a blocker stack", () => {
  it("bulk issue wins when issue-ready bags exist", () => {
    const r = recommendCloseoutNextAction({ buckets: { ...zero, DO_HERE: 7 }, issueReady: 5, releaseReady: 2 });
    expect(r).toEqual({ headline: "5 bags ready to issue finished lots", kind: "BULK_ISSUE" });
  });

  it("bulk release next when only release-ready bags exist", () => {
    const r = recommendCloseoutNextAction({ buckets: { ...zero, DO_HERE: 2 }, issueReady: 0, releaseReady: 2 });
    expect(r).toEqual({ headline: "2 lots ready to release", kind: "BULK_RELEASE" });
  });

  it("then remaining Do-here work", () => {
    const r = recommendCloseoutNextAction({ buckets: { ...zero, DO_HERE: 3, WAITING_ZOHO: 40 }, issueReady: 0, releaseReady: 0 });
    expect(r).toEqual({ headline: "3 bags need a decision here", kind: "WORK_DO_HERE" });
  });

  it("then floor work, then Zoho", () => {
    expect(
      recommendCloseoutNextAction({ buckets: { ...zero, ON_FLOOR: 2, WAITING_ZOHO: 5 }, issueReady: 0, releaseReady: 0 }),
    ).toEqual({ headline: "2 bags still in production on the floor", kind: "FLOOR" });
    expect(
      recommendCloseoutNextAction({ buckets: { ...zero, WAITING_ZOHO: 5 }, issueReady: 0, releaseReady: 0 }),
    ).toEqual({ headline: "5 bags waiting on Zoho mapping or queueing", kind: "ZOHO" });
  });

  it("singular forms read correctly", () => {
    expect(
      recommendCloseoutNextAction({ buckets: { ...zero, DO_HERE: 1 }, issueReady: 1, releaseReady: 0 })?.headline,
    ).toBe("1 bag ready to issue finished lots");
    expect(
      recommendCloseoutNextAction({ buckets: { ...zero, DO_HERE: 1 }, issueReady: 0, releaseReady: 0 })?.headline,
    ).toBe("1 bag needs a decision here");
  });

  it("nothing open returns null (no banner)", () => {
    expect(recommendCloseoutNextAction({ buckets: { ...zero, DONE: 40, EMPTY: 15 }, issueReady: 0, releaseReady: 0 })).toBeNull();
  });
});
