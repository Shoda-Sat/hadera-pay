import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("Actors can filter and manually sort their Orderbook without changing the default order", async () => {
  const [index, preview, mobileScreens] = await Promise.all([
    readFile(path.join(repositoryRoot, "index.html"), "utf8"),
    readFile(path.join(repositoryRoot, "preview.html"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/screens/WorkspaceScreens.tsx"), "utf8"),
  ]);

  assert.equal(index, preview);
  assert.match(index, /id="actorOrderStatusFilter"/);
  assert.match(index, /<option value="">Existing view \(Default\)<\/option>/);
  ["all", "paid", "pending", "cancelled", "voided"].forEach((status) => {
    assert.match(index, new RegExp(`<option value="${status}">`, "i"));
  });
  ["reference-asc", "reference-desc", "date-desc", "date-asc"].forEach((sortMode) => {
    assert.match(index, new RegExp(`<option value="${sortMode}">`));
  });
  assert.match(index, /id="actorOrderDateFrom" type="date"/);
  assert.match(index, /id="actorOrderDateTo" type="date"/);
  assert.match(index, /statusFilter\s*\?\s*visibleOrders\.filter[\s\S]*:\s*visibleOrders\.filter\(\(order\) => orderAppearsInOrderbookForActor/);
  assert.match(index, /:\s*orderSortForActor\(actor\)\);/);
  assert.match(index, /showActorOrderSort = canActAsSelectedActor/);

  assert.match(mobileScreens, /actorOrderStatusOptions[^\n]+"Default", "All", "Paid", "Pending", "Cancelled", "Voided"/);
  assert.match(mobileScreens, /actorOrderSortOptions[^\n]+"Default", "No\. Ascending", "No\. Descending", "Date Newest", "Date Oldest"/);
  assert.match(mobileScreens, /statusFilter === "Default"\s*\?\s*defaultOrders/);
  assert.match(mobileScreens, /if \(sortMode === "Default"\) return orders/);
  assert.match(mobileScreens, /placeholder="DD\/MM\/YYYY"/);
  assert.match(mobileScreens, /actorSortingAvailable = !isMasterView\(session\) && session\.managedByMaster !== true/);
});
