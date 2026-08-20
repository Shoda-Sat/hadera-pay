import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  explicitlyConfirmedSiemActorsInGalaxy,
  repairSiemActorsLeakedIntoGalaxy,
  siemGalaxyIsolationRepairId,
  stateDeclaresAnotherWorkspace,
} from "../src/workspaceIsolation.mjs";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function clone(value) {
  return structuredClone(value);
}

function fixture() {
  const siemActor = {
    id: "ACT-7",
    name: "Siem Broker",
    role: "Broker",
    currency: "USD",
    active: true,
    managedByMaster: true,
    transferEnabled: true,
    transferMode: "master",
  };
  const galaxyActor = {
    id: "ACT-2",
    name: "Galaxy Broker",
    role: "Broker",
    currency: "USD",
    active: true,
    managedByMaster: true,
  };
  const leakedOrder = {
    id: "ORD-SIEM-1",
    brokerActorId: siemActor.id,
    broker: siemActor.name,
    agent: "Unassigned",
    journal: "JRN-SIEM-1",
    sourceCurrency: "USD",
    sourceAmountMinor: 1_000,
    state: "Paid",
  };
  const db = {
    users: [
      { id: "USR-SIEM", name: "Siem" },
      { id: "USR-GALAXY", name: "Galaxy" },
    ],
    workspaces: [
      { id: "WS-SIEM", name: "Siem Workspace", ownerUserId: "USR-SIEM" },
      { id: "WS-GALAXY", name: "Galaxy Workspace", ownerUserId: "USR-GALAXY" },
    ],
    memberships: [
      { workspaceId: "WS-SIEM", role: "Master", actorId: "ACT-0", actorName: "Master" },
      { workspaceId: "WS-GALAXY", role: "Master", actorId: "ACT-0", actorName: "Master" },
    ],
    appStates: {
      "WS-SIEM": {
        actors: [{ id: "ACT-0", name: "Master", role: "Master", currency: "USD" }, siemActor],
        orders: [leakedOrder],
      },
    },
  };
  const archive = {
    id: "ARC-GALAXY-CLOSED",
    actor: "Siem Broker",
    actorId: "ACT-7",
    balances: { USD: 700 },
    ledger: [{
      journal: "JRN-CLOSED",
      account: "Siem Broker ACTOR_CLEARING",
      direction: "Debit",
      currency: "USD",
      amountMinor: 700,
      archived: true,
    }],
  };
  const state = {
    actors: [
      { id: "ACT-0", name: "Master", role: "Master", currency: "USD", active: true },
      galaxyActor,
      clone(siemActor),
      { ...clone(siemActor), id: "ACT-8", currency: "EUR" },
    ],
    orders: [
      clone(leakedOrder),
      { id: "ORD-GALAXY-1", brokerActorId: galaxyActor.id, broker: galaxyActor.name, agent: "Unassigned", journal: "JRN-GALAXY-1" },
    ],
    ledger: [
      {
        journal: "JRN-SIEM-1",
        entryId: "JRN-SIEM-1",
        source: "ORDER_PAYMENT",
        orderId: leakedOrder.id,
        account: "Siem Broker ACTOR_CLEARING",
        direction: "Debit",
        currency: "USD",
        amountMinor: 1_000,
      },
      {
        journal: "JRN-SIEM-1",
        entryId: "JRN-SIEM-1",
        source: "ORDER_PAYMENT",
        orderId: leakedOrder.id,
        account: "MASTER_ORDER_CLEARING",
        direction: "Credit",
        currency: "USD",
        amountMinor: 1_000,
      },
      {
        journal: "JRN-GALAXY-1",
        entryId: "JRN-GALAXY-1",
        source: "JOURNAL",
        account: "Galaxy Broker ACTOR_CLEARING",
        direction: "Debit",
        currency: "USD",
        amountMinor: 500,
      },
      {
        journal: "JRN-GALAXY-1",
        entryId: "JRN-GALAXY-1",
        source: "JOURNAL",
        account: "MASTER_JOURNAL_CLEARING",
        direction: "Credit",
        currency: "USD",
        amountMinor: 500,
      },
      {
        journal: "JRN-CLOSED",
        entryId: "JRN-CLOSED",
        source: "ORDER_PAYMENT",
        account: "Siem Broker ACTOR_CLEARING",
        direction: "Debit",
        currency: "USD",
        amountMinor: 700,
        archived: true,
      },
    ],
    receivables: [{ id: "REC-SIEM-1", orderId: leakedOrder.id, borrowerActorId: siemActor.id, borrower: siemActor.name }],
    transfers: [{ id: "TRF-SIEM-1", fromActorId: siemActor.id, from: siemActor.name, to: "Master", journal: "JRN-SIEM-2" }],
    savedCustomers: [{ id: "CUS-SIEM-1", actorId: siemActor.id, name: "Foreign customer" }],
    chatConversations: [{ id: "CHAT-SIEM-1", members: ["Master", siemActor.name], messages: [{ id: "MSG-SIEM-1" }] }],
    archives: [archive],
    settlements: [
      { actor: siemActor.name, currency: "USD", netMinor: 1_000 },
      { actor: galaxyActor.name, currency: "USD", netMinor: 500 },
    ],
  };
  db.appStates["WS-GALAXY"] = state;
  return { db, state, archive, siemActor, galaxyActor };
}

test("Galaxy removes leaked Siem actors and active balance effects while closed history stays unchanged", () => {
  const { db, state, archive, siemActor, galaxyActor } = fixture();
  const sourceBefore = clone(db.appStates["WS-SIEM"]);
  const archiveBefore = clone(archive);

  const result = repairSiemActorsLeakedIntoGalaxy(db, "WS-GALAXY", state);

  assert.equal(result.repaired, true);
  assert.equal(result.leakedActorCount, 1);
  assert.deepEqual(result.leakedActors, [siemActor.name]);
  assert.equal(result.balanceMerged, true);
  assert.equal(result.removedLedgerLineCount, 2, "The foreign actor line and its balancing Master line are removed together.");
  assert.equal(state.actors.some((actor) => actor.id === siemActor.id), false);
  assert.equal(state.actors.some((actor) => actor.id === "ACT-8"), true, "A similar but non-identical profile is not classified as leaked.");
  assert.equal(state.actors.some((actor) => actor.id === galaxyActor.id), true);
  assert.deepEqual(state.ledger.map((line) => line.journal), ["JRN-GALAXY-1", "JRN-GALAXY-1", "JRN-CLOSED"]);
  assert.equal(state.orders.some((order) => order.id === "ORD-SIEM-1"), false);
  assert.equal(state.orders.some((order) => order.id === "ORD-GALAXY-1"), true);
  assert.deepEqual(state.receivables, []);
  assert.deepEqual(state.transfers, []);
  assert.deepEqual(state.savedCustomers, []);
  assert.deepEqual(state.chatConversations, []);
  assert.deepEqual(state.archives, [archiveBefore], "Closed reports are byte-for-byte unchanged.");
  assert.deepEqual(state.settlements, [
    { actor: galaxyActor.name, currency: "USD", netMinor: 500 },
    { actor: "Siem Broker", currency: "EUR", netMinor: 0 },
  ]);
  assert.deepEqual(db.appStates["WS-SIEM"], sourceBefore, "The source Master's data is read-only during repair.");
  const audit = state.workspaceIsolationRepairs.find((item) => item.id === siemGalaxyIsolationRepairId);
  assert.equal(audit.balanceMerged, true);
  assert.equal(audit.closedReportsChanged, false);

  state.ledger.push(
    { journal: "JRN-STALE", entryId: "JRN-STALE", source: "JOURNAL", account: `${siemActor.name} ACTOR_CLEARING`, direction: "Debit", currency: "USD", amountMinor: 300 },
    { journal: "JRN-STALE", entryId: "JRN-STALE", source: "JOURNAL", account: "MASTER_JOURNAL_CLEARING", direction: "Credit", currency: "USD", amountMinor: 300 },
  );
  const staleDeviceRepair = repairSiemActorsLeakedIntoGalaxy(db, "WS-GALAXY", state);
  assert.equal(staleDeviceRepair.repaired, true, "A stale device cannot resurrect removed foreign ledger rows.");
  assert.equal(state.ledger.some((line) => line.journal === "JRN-STALE"), false);

  const afterSecondRepair = clone(state);
  const third = repairSiemActorsLeakedIntoGalaxy(db, "WS-GALAXY", state);
  assert.equal(third.repaired, false);
  assert.deepEqual(state, afterSecondRepair, "The repair is idempotent after leaked records are gone.");
});

test("workspace identity markers reject a state cached for another Master", () => {
  assert.equal(stateDeclaresAnotherWorkspace({ _workspaceId: "WS-SIEM" }, "WS-GALAXY"), true);
  assert.equal(stateDeclaresAnotherWorkspace({ _workspaceId: "WS-GALAXY" }, "WS-GALAXY"), false);
  assert.equal(stateDeclaresAnotherWorkspace({}, "WS-GALAXY"), false, "Legacy unmarked state remains migratable.");
});

test("the audit reports when leaked profiles did not merge an active balance", () => {
  const { db, state } = fixture();
  state.ledger = state.ledger.filter((line) => line.journal !== "JRN-SIEM-1");
  const result = repairSiemActorsLeakedIntoGalaxy(db, "WS-GALAXY", state);
  assert.equal(result.repaired, true);
  assert.equal(result.balanceMerged, false);
  assert.equal(result.removedLedgerLineCount, 0);
  const audit = state.workspaceIsolationRepairs.find((item) => item.id === siemGalaxyIsolationRepairId);
  assert.equal(audit.balanceMerged, false);
  assert.equal(audit.closedReportsChanged, false);
});

test("Galaxy hides the explicitly confirmed Europe and Asdc profiles even after their settings diverge", () => {
  const { db, state, siemActor } = fixture();
  const europeSource = { ...siemActor, id: "ACT-EUROPE", name: "Europe", currency: "USD", orderFixedCommission: { enabled: true, percent: 2 } };
  const asdcSource = { ...siemActor, id: "ACT-ASDC", name: "Asdc", currency: "EUR", transferMode: "both" };
  db.appStates["WS-SIEM"].actors = [
    { id: "ACT-0", name: "Master", role: "Master", currency: "USD" },
    europeSource,
    asdcSource,
  ];
  state.actors = state.actors.filter((actor) => actor.name !== siemActor.name);
  state.actors.push(
    { ...europeSource, currency: "ETB", orderFixedCommission: { enabled: false, percent: 9 } },
    { ...asdcSource, currency: "SSP", transferMode: "master" },
  );
  state.orders = [];
  state.receivables = [];
  state.transfers = [];
  state.savedCustomers = [];
  state.chatConversations = [];
  state.ledger = [
    { journal: "JRN-EUROPE", entryId: "JRN-EUROPE", source: "JOURNAL", account: "Europe ACTOR_CLEARING", direction: "Debit", currency: "USD", amountMinor: 400 },
    { journal: "JRN-EUROPE", entryId: "JRN-EUROPE", source: "JOURNAL", account: "MASTER_JOURNAL_CLEARING", direction: "Credit", currency: "USD", amountMinor: 400 },
    { journal: "JRN-ASDC", entryId: "JRN-ASDC", source: "JOURNAL", account: "Asdc ACTOR_CLEARING", direction: "Credit", currency: "EUR", amountMinor: 250 },
    { journal: "JRN-ASDC", entryId: "JRN-ASDC", source: "JOURNAL", account: "MASTER_JOURNAL_CLEARING", direction: "Debit", currency: "EUR", amountMinor: 250 },
  ];

  assert.deepEqual(explicitlyConfirmedSiemActorsInGalaxy, ["Europe", "Asdc"]);
  const result = repairSiemActorsLeakedIntoGalaxy(db, "WS-GALAXY", state);
  assert.equal(result.repaired, true);
  assert.deepEqual(new Set(result.leakedActors), new Set(["Europe", "Asdc"]));
  assert.equal(result.balanceMerged, true);
  assert.equal(result.removedLedgerLineCount, 4);
  assert.equal(state.actors.some((actor) => ["europe", "asdc"].includes(actor.name.toLocaleLowerCase())), false);
  assert.deepEqual(state.ledger, []);
  assert.equal(state.archives.length, 1, "Closed reports remain untouched.");
});

test("the web Master receives the balance-isolation result after login", async () => {
  const web = await readFile(path.join(repositoryRoot, "index.html"), "utf8");
  assert.match(web, /notifyWorkspaceIsolationRepair\(\)/);
  assert.match(web, /balances were recalculated/);
  assert.match(web, /balances were not merged/);
  assert.match(web, /Closed reports were unchanged/);
});
