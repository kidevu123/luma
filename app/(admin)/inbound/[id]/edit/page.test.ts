import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const pageSrc = readFileSync(join(__dirname, "page.tsx"), "utf8");
const formSrc = readFileSync(join(__dirname, "receive-edit-form.tsx"), "utf8");
const actionsSrc = readFileSync(join(__dirname, "actions.ts"), "utf8");
const querySrc = readFileSync(
  join(process.cwd(), "lib/db/queries/receive-edits.ts"),
  "utf8",
);

describe("RECEIVE-EDIT-2B-1 · receive edit page", () => {
  it("requires lead permission", () => {
    expect(pageSrc).toMatch(/requireLead/);
  });

  it("states only notes and open/closed are editable", () => {
    expect(pageSrc).toMatch(/notes and open\/closed status only/i);
    expect(formSrc).toMatch(/Receive name, PO, shipment, and bags are not editable/i);
  });

  it("does not expose PO, shipment, or receive name inputs", () => {
    expect(formSrc).toMatch(/\{receiveName\}/);
    expect(formSrc).not.toMatch(/setReceiveName|receiveName.*onChange/);
    expect(formSrc).not.toMatch(/poNumber|shipmentId|receivedAt|received_by/i);
    expect(formSrc).not.toMatch(/<input[^>]+id="receive-name"/i);
  });

  it("form only collects notes and open/closed", () => {
    expect(formSrc).toMatch(/receive-notes/);
    expect(formSrc).toMatch(/isClosed/);
    expect(formSrc).toMatch(/editReceiveAction\(receiveId, \{ notes, isClosed \}/);
  });
});

describe("RECEIVE-EDIT-2B-1 · receive edit action", () => {
  it("enforces requireLead and delegates to editReceive", () => {
    expect(actionsSrc).toMatch(/requireLead/);
    expect(actionsSrc).toMatch(/editReceive/);
  });
});

describe("RECEIVE-EDIT-2B-1 · receive edit query", () => {
  it("updates only notes and closedAt on receives", () => {
    expect(querySrc).toMatch(/notes: after\.notes/);
    expect(querySrc).toMatch(/closedAt: after\.closedAt/);
    expect(querySrc).not.toMatch(/receiveName/);
    expect(querySrc).not.toMatch(/receivedAt/);
    expect(querySrc).not.toMatch(/purchase_order/i);
  });

  it("writes receive.edit audit with notes and closedAt snapshots", () => {
    expect(querySrc).toMatch(/action: "receive\.edit"/);
    expect(querySrc).toMatch(/targetType: "Receive"/);
    expect(querySrc).toMatch(/notes: before\.notes/);
    expect(querySrc).toMatch(/closedAt: before\.closedAt/);
  });
});
