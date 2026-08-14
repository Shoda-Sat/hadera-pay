import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  findPendingOrderIntegrityIssues,
  nextBrokerOrderNumberForActor,
  removeRecoveredOrderAliases,
} from "../src/orderIntegrity.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function order(id, overrides = {}) {
  return {
    id,
    brokerActorId: "ACT-GOITOM",
    broker: "Goitom",
    brokerOrderNumber: "HAB011",
    brokerOrderNumberCycle: 0,
    agent: "Unassigned",
    agentActorId: "",
    sourceCurrency: "EUR",
    sourceAmountMinor: 20_000,
    payoutCurrency: "ETB",
    payoutAmountMinor: 3_960_000,
    rate: 198,
    senderName: "Sender",
    receiverName: "Receiver",
    receiverCity: "City",
    accountNumber: "1000601268934",
    fundingType: "cash",
    state: "Pending Forward",
    createdAt: "2026-08-14T17:51:29.000Z",
    sentAt: "2026-08-14T17:51:29.000Z",
    updatedAt: "2026-08-14T17:51:29.000Z",
    ...overrides,
  };
}

test("detects Goitom's wrong Broker prefix and exact duplicate copies without exposing details", () => {
  const state = {
    actors: [
      { id: "ACT-GOITOM", name: "Goitom", role: "Broker" },
      { id: "ACT-HABTOM", name: "Habtom", role: "Broker" },
    ],
    orders: [order("ORD-A"), order("ORD-B"), order("ORD-C"), order("ORD-D")],
    ledger: [],
    receivables: [],
    chatConversations: [],
  };
  const issues = findPendingOrderIntegrityIssues(state);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].actorName, "Goitom");
  assert.equal(issues[0].orderNumber, "HAB011");
  assert.equal(issues[0].expectedPrefix, "GOI");
  assert.equal(issues[0].count, 4);
  assert.equal(issues[0].extraCopies, 3);
  assert.equal(issues[0].wrongPrefix, true);
  assert.equal(issues[0].exactDuplicates, true);
  assert.equal(issues[0].safeAutoRepair, true);
  assert.equal(Object.prototype.hasOwnProperty.call(issues[0], "receiverName"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(issues[0], "accountNumber"), false);
});

test("blocks automatic cleanup when duplicate details differ or linked records exist", () => {
  const different = {
    actors: [{ id: "ACT-GOITOM", name: "Goitom", role: "Broker" }],
    orders: [order("ORD-A"), order("ORD-B", { sourceAmountMinor: 30_000 })],
    ledger: [],
    receivables: [],
    chatConversations: [],
  };
  assert.equal(findPendingOrderIntegrityIssues(different)[0].safeAutoRepair, false);

  const linked = structuredClone(different);
  linked.orders = [order("ORD-A")];
  linked.ledger = [{ orderId: "ORD-A", source: "ORDER_PAYMENT" }];
  assert.equal(findPendingOrderIntegrityIssues(linked)[0].safeAutoRepair, false);
});

test("server numbering uses the Broker identity and reserves active Actor sequences", () => {
  const actor = { id: "ACT-GOITOM", name: "Goitom", role: "Broker", numberingCycle: 2 };
  const state = {
    actors: [actor],
    orders: [
      order("ORD-1", { brokerOrderNumber: "GOI001", brokerOrderNumberCycle: 2 }),
      order("ORD-2", {
        brokerActorId: "ACT-OTHER",
        broker: "Other",
        brokerOrderNumber: "OTH001",
        agent: "Goitom",
        agentOrderNumber: "002_OTH001",
        agentOrderActor: "Goitom",
        agentOrderNumbers: { Goitom: "002_OTH001" },
        agentOrderNumberCycles: { Goitom: 2 },
      }),
    ],
    archives: [],
    ledger: [{ account: "Goitom ACTOR_CLEARING", actorLedgerNumber: "003_TRF-01", archived: false }],
  };
  assert.deepEqual(nextBrokerOrderNumberForActor(state, actor), {
    brokerOrderNumber: "GOI004",
    brokerOrderNumberCycle: 2,
  });
});

test("a recovered order removes only its same-Broker stale alias", () => {
  const staleGoitom = order("ORD-SHARED");
  const originalHabtom = order("ORD-SHARED", {
    brokerActorId: "ACT-HABTOM",
    broker: "Habtom",
    receiverName: "Different receiver",
  });
  const recovered = order("ORD-RECOVERED", {
    brokerOrderNumber: "GOI001",
    collisionSourceOrderId: "ORD-SHARED",
  });
  const cleaned = removeRecoveredOrderAliases([originalHabtom, staleGoitom, recovered]);
  assert.equal(cleaned.includes(staleGoitom), false);
  assert.equal(cleaned.includes(originalHabtom), true);
  assert.equal(cleaned.includes(recovered), true);
});

test("Owner-only production scan and both clients enforce recovered order aliases", async () => {
  const [server, index, preview, mobileClient, mobileTypes] = await Promise.all([
    readFile(path.join(root, "server.mjs"), "utf8"),
    readFile(path.join(root, "index.html"), "utf8"),
    readFile(path.join(root, "preview.html"), "utf8"),
    readFile(path.join(root, "mobile/src/api/client.ts"), "utf8"),
    readFile(path.join(root, "mobile/src/types.ts"), "utf8"),
  ]);
  assert.equal(index, preview);
  assert.match(server, /\/api\/owner\/order-integrity\/plan[\s\S]*requireOwner/);
  assert.match(server, /findPendingOrderIntegrityIssues/);
  assert.match(server, /safeAutoRepair: issue\.safeAutoRepair/);
  assert.match(server, /collisionSourceOrderId/);
  assert.match(index, /removeRecoveredOrderAliases\(state\.orders, remoteOrders\)/);
  assert.match(mobileClient, /removeRecoveredOrderAliases/);
  assert.match(mobileTypes, /collisionSourceOrderId\?: string/);
  assert.doesNotMatch(server.slice(server.indexOf('url.pathname === "\/api\/owner\/order-integrity\/plan"'), server.indexOf('url.pathname === "\/api\/owner\/repair-order-archives\/apply-all"')), /receiverName|accountNumber|phoneNumber/);
});
