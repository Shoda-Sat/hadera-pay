import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  brokerCodeForActor,
  nextBrokerOrderNumberForActor,
  nextUniqueBrokerCode,
} from "../src/orderIntegrity.mjs";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("future Brokers receive permanent unique codes while legacy Brokers keep their old prefixes", () => {
  const legacyBroker = { id: "ACT-OLD", name: "Broker Old", role: "Broker" };
  assert.equal(brokerCodeForActor(legacyBroker), "BRO");
  assert.equal(Object.prototype.hasOwnProperty.call(legacyBroker, "brokerCode"), false);

  const firstFutureCode = nextUniqueBrokerCode("Broker X", [brokerCodeForActor(legacyBroker)]);
  const secondFutureCode = nextUniqueBrokerCode("Broker Y", [brokerCodeForActor(legacyBroker), firstFutureCode]);
  assert.equal(firstFutureCode, "BROA");
  assert.equal(secondFutureCode, "BROB");

  const futureBroker = { id: "ACT-NEW", name: "Broker X", role: "Broker", brokerCode: firstFutureCode };
  assert.deepEqual(nextBrokerOrderNumberForActor({ orders: [], archives: [], ledger: [] }, futureBroker), {
    brokerOrderNumber: "BROA001",
    brokerOrderNumberCycle: 0,
  });
});

test("server, web, and Android use the stored Broker code only for future Actor creation", async () => {
  const [server, index, preview, mobileClient, mobileTypes] = await Promise.all([
    readFile(path.join(repositoryRoot, "server.mjs"), "utf8"),
    readFile(path.join(repositoryRoot, "index.html"), "utf8"),
    readFile(path.join(repositoryRoot, "preview.html"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/api/client.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/types.ts"), "utf8"),
  ]);

  assert.equal(index, preview);
  assert.match(server, /membership\.brokerCode = nextUniqueBrokerCode\(name, reservedBrokerCodes\)/);
  assert.match(server, /else if \(existingActor\)[\s\S]*if \(existingActor\.brokerCode\)[\s\S]*else delete nextActor\.brokerCode/);
  assert.match(server, /assignFutureManagedBrokerCodes\(db, workspaceId, currentState, nextState, membershipActors\)/);
  assert.match(index, /brokerCode: brokerCode \|\| undefined/);
  assert.match(index, /brokerCodeForActor\(actor \|\| \{ name: brokerName \}\)/);
  assert.match(mobileClient, /actor\?\.brokerCode \|\| session\.brokerCode/);
  assert.match(mobileTypes, /brokerCode\?: string/);
});
