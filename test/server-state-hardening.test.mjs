import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function unusedPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitForServer(baseUrl, serverProcess, readStderr) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`Test server stopped before startup.\n${readStderr()}`);
    }
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Test server did not start.\n${readStderr()}`);
}

async function request(baseUrl, pathname, { cookie = "", method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  return {
    response,
    data,
    cookie: (response.headers.get("set-cookie") || "").split(";", 1)[0] || cookie,
  };
}

async function requestOk(baseUrl, pathname, options = {}) {
  const result = await request(baseUrl, pathname, options);
  assert.equal(result.response.ok, true, result.data.error || `${options.method || "GET"} ${pathname} failed`);
  return result;
}

function archivedPaidOrder(id, journal, actorId, actorName, paidAt) {
  return {
    id,
    internalOrderId: id,
    brokerActorId: actorId,
    broker: actorName,
    brokerOrderNumber: id,
    agentActorId: "ACT-ARCHIVE-AGENT",
    agent: "Historic Agent",
    state: "Paid",
    journal,
    sourceCurrency: "USD",
    sourceAmountMinor: 12_345,
    payoutCurrency: "ETB",
    payoutAmountMinor: 2_469_000,
    createdAt: paidAt,
    paidAt,
  };
}

test("server reserves historical Actor IDs, sanitizes new Broker orders, and keeps closed archives immutable", { timeout: 40_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "haderapay-state-hardening-"));
  const databasePath = path.join(dataDirectory, "auth-db.json");
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const ownerPassword = crypto.randomBytes(18).toString("base64url");
  const masterPassword = crypto.randomBytes(14).toString("base64url");
  const actorPassword = crypto.randomBytes(14).toString("base64url");
  let stderr = "";
  const serverProcess = spawn(process.execPath, ["server.mjs"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      DATA_DIR: dataDirectory,
      HOST: "127.0.0.1",
      PORT: String(port),
      OWNER_PASSWORD: ownerPassword,
    },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  serverProcess.stderr.setEncoding("utf8");
  serverProcess.stderr.on("data", (chunk) => { stderr += chunk; });

  try {
    await waitForServer(baseUrl, serverProcess, () => stderr);
    const ownerLogin = await requestOk(baseUrl, "/api/auth/login", {
      method: "POST",
      body: { email: "Owner", password: ownerPassword },
    });
    await requestOk(baseUrl, "/api/owner/masters", {
      cookie: ownerLogin.cookie,
      method: "POST",
      body: {
        name: "State Safety Master",
        email: "state-safety-master@example.com",
        password: masterPassword,
        currency: "USD",
        plan: "one_month",
      },
    });
    const masterLogin = await requestOk(baseUrl, "/api/auth/login", {
      method: "POST",
      body: { email: "state-safety-master@example.com", password: masterPassword },
    });
    const invite = await requestOk(baseUrl, "/api/invites", {
      cookie: masterLogin.cookie,
      method: "POST",
      body: { actorRole: "Broker", currency: "USD", workingCurrencies: [] },
    });
    const brokerSignup = await requestOk(baseUrl, "/api/auth/signup", {
      method: "POST",
      body: {
        name: "Safe Broker",
        email: "state-safety-broker@example.com",
        password: actorPassword,
        inviteCode: invite.data.invite.code,
        role: "Actor",
      },
    });

    const database = JSON.parse(await readFile(databasePath, "utf8"));
    const masterMembership = database.memberships.find((membership) =>
      membership.role === "Master" && membership.userId === database.users.find((user) => user.email === "state-safety-master@example.com")?.id
    );
    assert.ok(masterMembership);
    const workspaceId = masterMembership.workspaceId;
    const state = database.appStates[workspaceId] || {};
    const archiveA = {
      id: "ARC-IMMUTABLE-A",
      actor: "Historic Broker A",
      actorId: "ACT-ARCHIVE-OWNER-A",
      actorRole: "Broker",
      actorCurrency: "USD",
      closedAt: "2026-01-01T10:00:00.000Z",
      balances: { USD: 12_345 },
      orders: [archivedPaidOrder("ORD-ARCHIVE-A", "JRN-ARCHIVE-COLLISION", "ACT-ARCHIVE-BROKER", "Historic Broker A", "2026-01-01T09:00:00.000Z")],
      ledger: [{
        actorId: "ACT-ARCHIVE-LEDGER",
        journal: "JRN-ARCHIVE-A",
        source: "HISTORIC_NOTE",
        account: "Historic Broker A ACTOR_CLEARING",
        direction: "Debit",
        currency: "USD",
        amountMinor: 12_345,
        postedAt: "2026-01-01T09:00:00.000Z",
        exactHistoricMarker: { keep: ["byte", "for", "byte"] },
      }],
      receivables: [],
      transfers: [],
      exactHistoricMarker: "archive-a-must-not-change",
    };
    const archiveB = {
      id: "ARC-IMMUTABLE-B",
      actor: "Historic Broker B",
      actorId: "ACT-ARCHIVE-OWNER-B",
      actorRole: "Broker",
      actorCurrency: "USD",
      closedAt: "2026-01-02T10:00:00.000Z",
      balances: { USD: -12_345 },
      orders: [archivedPaidOrder("ORD-ARCHIVE-B", "JRN-ARCHIVE-COLLISION", "ACT-ARCHIVE-BROKER-B", "Historic Broker B", "2026-01-02T09:00:00.000Z")],
      ledger: [],
      receivables: [{
        id: "REC-ARCHIVE-HISTORY",
        borrowerActorId: "ACT-ARCHIVE-BORROWER",
        borrower: "Historic Archive Borrower",
      }],
      transfers: [{
        id: "TRF-ARCHIVE-HISTORY",
        fromActorId: "ACT-ARCHIVE-TRANSFER-FROM",
        from: "Historic Archive Sender",
        toActorId: "ACT-ARCHIVE-TRANSFER-TO",
        to: "Historic Archive Receiver",
      }],
      exactHistoricMarker: "collision-cleanup-must-not-rename-this-order",
    };
    state.deletedActorIds = [...new Set([...(state.deletedActorIds || []), "ACT-DELETED-HISTORY"])];
    state.orders = [{
      id: "ORD-LIVE-HISTORY",
      internalOrderId: "ORD-LIVE-HISTORY",
      brokerActorId: "ACT-LIVE-BROKER",
      broker: "Historic Live Broker",
      agentActorId: "ACT-LIVE-AGENT",
      agent: "Historic Live Agent",
      state: "Assigned",
      sourceCurrency: "USD",
      sourceAmountMinor: 500,
      payoutCurrency: "ETB",
      payoutAmountMinor: 100_000,
      createdAt: "2026-01-03T10:00:00.000Z",
      updatedAt: "2026-01-03T10:00:00.000Z",
    }];
    state.receivables = [{
      id: "REC-LIVE-HISTORY",
      borrowerActorId: "ACT-LIVE-BORROWER",
      borrower: "Historic Live Borrower",
    }];
    state.transfers = [{
      id: "TRF-LIVE-HISTORY",
      fromActorId: "ACT-LIVE-TRANSFER-FROM",
      from: "Historic Live Sender",
      toActorId: "ACT-LIVE-TRANSFER-TO",
      to: "Historic Live Receiver",
    }];
    state.actors = [...(state.actors || []), {
      id: "ACT-CURRENT-MANAGED",
      name: "Current Managed Actor",
      role: "Agent",
      currency: "ETB",
      active: true,
      managedByMaster: true,
    }];
    state.ledger = [{
      actorId: "ACT-LIVE-LEDGER",
      journal: "JRN-HISTORIC-LINE",
      source: "HISTORIC_NOTE",
      account: "Historic Ledger Actor ACTOR_CLEARING",
      direction: "Debit",
      currency: "USD",
      amountMinor: 777,
      postedAt: "2026-01-03T11:00:00.000Z",
    }];
    state.archives = [archiveA, archiveB];
    state.orderParticipantIdentityLinks = [{
      repairId: "HISTORIC-LINK",
      actorId: "ACT-LINK-CURRENT",
      legacyActorId: "ACT-LINK-LEGACY",
      sourceActorId: "ACT-LINK-SOURCE",
      targetActorId: "ACT-LINK-TARGET",
      journal: "JRN-HISTORIC-LINK",
      orderIds: ["ORD-HISTORIC-LINK"],
      role: "agent",
      actorName: "Historic Linked Actor",
      participantName: "Historic Linked Actor",
    }];
    state.settlements = [{ actor: "Safe Broker", currency: "USD", netMinor: 0 }];
    database.appStates[workspaceId] = state;
    await writeFile(databasePath, JSON.stringify(database, null, 2));

    for (const [query, expectedKind] of [
      ["ORD-LIVE-HISTORY", "order"],
      ["REC-LIVE-HISTORY", "receivable"],
      ["TRF-LIVE-HISTORY", "transfer"],
      ["JRN-HISTORIC-LINE", "ledger"],
      ["ARC-IMMUTABLE-A", "report"],
    ]) {
      const search = await requestOk(baseUrl, `/api/search?q=${encodeURIComponent(query)}&limit=10`, {
        cookie: masterLogin.cookie,
      });
      assert.equal(search.data.results.some((result) => result.kind === expectedKind), true, `${query} must be found as ${expectedKind}.`);
      assert.ok(search.data.results.length <= 10);
      if (expectedKind === "report") {
        const report = search.data.results.find((result) => result.kind === "report")?.record;
        assert.equal(Object.hasOwn(report || {}, "orders"), false, "Search must not return closed-report transaction bodies.");
        assert.equal(report?._reportDetailLoaded, false);
      }
    }
    const boundedSearch = await requestOk(baseUrl, "/api/search?q=Historic&limit=2", { cookie: masterLogin.cookie });
    assert.equal(boundedSearch.data.results.length, 2);
    assert.equal(boundedSearch.data.hasMore, true);
    const actorPrivateSearch = await requestOk(baseUrl, "/api/search?q=ORD-LIVE-HISTORY&limit=10", {
      cookie: brokerSignup.cookie,
    });
    assert.deepEqual(actorPrivateSearch.data.results, [], "An Actor must not search another participant's records.");

    const baseline = await requestOk(baseUrl, "/api/app-state", { cookie: masterLogin.cookie });
    const currentActorId = invite.data.invite.actorId;
    const reservedIds = [
      currentActorId,
      "ACT-CURRENT-MANAGED",
      "ACT-DELETED-HISTORY",
      "ACT-LIVE-BROKER",
      "ACT-LIVE-AGENT",
      "ACT-LIVE-BORROWER",
      "ACT-LIVE-TRANSFER-FROM",
      "ACT-LIVE-TRANSFER-TO",
      "ACT-LIVE-LEDGER",
      "ACT-ARCHIVE-OWNER-A",
      "ACT-ARCHIVE-BROKER",
      "ACT-ARCHIVE-AGENT",
      "ACT-ARCHIVE-BORROWER",
      "ACT-ARCHIVE-TRANSFER-FROM",
      "ACT-ARCHIVE-TRANSFER-TO",
      "ACT-ARCHIVE-LEDGER",
      "ACT-LINK-CURRENT",
      "ACT-LINK-LEGACY",
      "ACT-LINK-SOURCE",
      "ACT-LINK-TARGET",
    ];
    for (const [index, actorId] of reservedIds.entries()) {
      const attemptedState = structuredClone(baseline.data.state);
      attemptedState.actors.push({
        id: actorId,
        name: `New Managed Actor ${index}`,
        role: "Agent",
        currency: "ETB",
        active: true,
        managedByMaster: true,
      });
      const attempted = await request(baseUrl, "/api/app-state", {
        cookie: masterLogin.cookie,
        method: "PUT",
        body: { state: attemptedState, expectedRevision: baseline.data.revision },
      });
      assert.equal(attempted.response.status, 409, `Historical Actor ID ${actorId} must not be reusable.`);
      assert.match(attempted.data.error, /Actor (?:ID belongs|IDs must be unique|names cannot be changed)/i);
    }

    const staleInvite = await requestOk(baseUrl, "/api/invites", {
      cookie: masterLogin.cookie,
      method: "POST",
      body: { actorRole: "Agent", currency: "ETB", workingCurrencies: [] },
    });
    const databaseWithStaleInvite = JSON.parse(await readFile(databasePath, "utf8"));
    databaseWithStaleInvite.invites.find((item) => item.id === staleInvite.data.invite.id).actorId = "ACT-DELETED-HISTORY";
    await writeFile(databasePath, JSON.stringify(databaseWithStaleInvite, null, 2));
    const rejectedStaleInvite = await request(baseUrl, "/api/auth/signup", {
      method: "POST",
      body: {
        name: "Stale Invite Actor",
        email: "state-safety-stale-invite@example.com",
        password: crypto.randomBytes(14).toString("base64url"),
        inviteCode: staleInvite.data.invite.code,
        role: "Actor",
      },
    });
    assert.equal(rejectedStaleInvite.response.status, 409);
    assert.match(rejectedStaleInvite.data.error, /Actor ID belongs to earlier workspace history/i);

    const actorView = await requestOk(baseUrl, "/api/app-state", { cookie: brokerSignup.cookie });
    assert.deepEqual(actorView.data.state.orders, [], "An Actor must not download unrelated workspace orders.");
    assert.deepEqual(actorView.data.state.receivables, [], "An Actor must not download unrelated receivables.");
    assert.deepEqual(actorView.data.state.transfers, [], "An Actor must not download unrelated transfers.");
    assert.deepEqual(actorView.data.state.ledger, [], "An Actor must not download unrelated ledger lines.");
    assert.deepEqual(actorView.data.state.archives, [], "An Actor must not download another Actor's closed reports.");
    const spoofedPending = {
      id: "ORD-ACTOR-PENDING-SAFE",
      internalOrderId: "ORD-ACTOR-PENDING-SAFE",
      brokerActorId: currentActorId,
      broker: "Safe Broker",
      brokerOrderNumber: "FAKE999",
      agentActorId: "ACT-LIVE-AGENT",
      agent: "Historic Live Agent",
      agentOrderNumber: "999_FAKE999",
      agentOrderNumbers: { "Historic Live Agent": "999_FAKE999" },
      agentOrderNumberCycles: { "Historic Live Agent": 9 },
      state: "Pending Forward",
      sourceCurrency: "USD",
      sourceAmountMinor: 10_000,
      payoutCurrency: "ETB",
      payoutAmountMinor: 2_000_000,
      senderName: "Sender",
      receiverName: "Receiver",
      createdAt: "2026-08-22T12:00:00.000Z",
      updatedAt: "2026-08-22T12:00:00.000Z",
      assignedAt: "2026-08-22T12:01:00.000Z",
      assignedAgentUserId: "USR-SPOOFED-AGENT",
      payingAgent: "Historic Live Agent",
      payoutAgent: "Historic Live Agent",
      payoutAgentName: "Historic Live Agent",
      journal: "JRN-SPOOFED",
      paidJournalEntryId: "JNL-SPOOFED",
      paidAt: "2026-08-22T12:02:00.000Z",
      postedAt: "2026-08-22T12:02:00.000Z",
      paymentProof: { attachmentId: "fake", fileName: "fake.png" },
      voidableUntil: "2026-08-22T12:32:00.000Z",
      voidJournal: "JRN-SPOOFED-VOID",
      voidRequested: true,
      voidRequestedAt: "2026-08-22T12:03:00.000Z",
      voidedAt: "2026-08-22T12:04:00.000Z",
      excludedFromCalculations: true,
      returnedAt: "2026-08-22T12:05:00.000Z",
      cancelledAt: "2026-08-22T12:06:00.000Z",
      incomeProfitMinor: 999_999,
      forwardedPayoutDivider: 99,
      manualMasterRatePercent: 99,
      archivedAt: "2026-08-22T12:07:00.000Z",
      locked: true,
      lastReminderAt: "2026-08-22T12:08:00.000Z",
      lastReminderBy: "Fake Master",
    };
    const actorState = structuredClone(actorView.data.state);
    const actorSubmittedArchive = structuredClone(archiveA);
    actorSubmittedArchive.balances.USD = -1;
    actorSubmittedArchive.orders[0].journal = "JRN-ACTOR-TAMPERED";
    actorState.archives.push(actorSubmittedArchive);
    actorState.orders.push(spoofedPending);
    const actorSave = await requestOk(baseUrl, "/api/app-state", {
      cookie: brokerSignup.cookie,
      method: "PUT",
      body: { state: actorState, expectedRevision: actorView.data.revision },
    });
    const savedPending = actorSave.data.state.orders.find((order) => order.id === spoofedPending.id);
    assert.ok(savedPending);
    assert.equal(savedPending.state, "Pending Forward");
    assert.equal(savedPending.brokerActorId, currentActorId);
    assert.equal(savedPending.broker, "Safe Broker");
    assert.equal(savedPending.agent, "Unassigned");
    assert.equal(savedPending.agentActorId, "");
    assert.deepEqual(actorSave.data.state.archives, [], "An Actor save response must remain scoped to that Actor.");
    for (const field of [
      "assignedAgentUserId", "agentOrderNumber", "agentOrderNumbers", "agentOrderNumberCycles", "payingAgent",
      "payoutAgent", "payoutAgentName", "assignedAt", "journal", "paidJournalEntryId", "paidAt", "postedAt",
      "paymentProof", "voidableUntil", "voidJournal", "voidRequested", "voidRequestedAt", "voidedAt", "excludedFromCalculations",
      "returnedAt", "cancelledAt", "incomeProfitMinor", "forwardedPayoutDivider", "manualMasterRatePercent",
      "archivedAt", "locked", "lastReminderAt", "lastReminderBy",
    ]) {
      assert.equal(Object.prototype.hasOwnProperty.call(savedPending, field), false, `${field} must be server-owned on a new pending order.`);
    }

    const beforeArchiveSave = await requestOk(baseUrl, "/api/app-state", { cookie: masterLogin.cookie });
    assert.deepEqual(beforeArchiveSave.data.state.archives.find((archive) => archive.id === archiveA.id), archiveA);
    assert.deepEqual(beforeArchiveSave.data.state.archives.find((archive) => archive.id === archiveB.id), archiveB);
    const submitted = structuredClone(beforeArchiveSave.data.state);
    const submittedArchiveA = submitted.archives.find((archive) => archive.id === archiveA.id);
    submittedArchiveA.balances.USD = 999_999_999;
    submittedArchiveA.orders[0].journal = "JRN-TAMPERED";
    submittedArchiveA.exactHistoricMarker = "tampered";
    submitted.archives.unshift({
      id: "ARC-UNAUTHORIZED-ACTOR-REPORT",
      actor: "Fake Actor",
      actorRole: "Agent",
      closedAt: "2026-08-22T13:00:00.000Z",
      balances: { USD: 5_000 },
      orders: [],
      ledger: [],
      receivables: [],
      transfers: [],
    });
    const unauthorizedArchiveSave = await request(baseUrl, "/api/app-state", {
      cookie: masterLogin.cookie,
      method: "PUT",
      body: { state: submitted, expectedRevision: beforeArchiveSave.data.revision },
    });
    assert.equal(unauthorizedArchiveSave.response.status, 409);
    assert.match(unauthorizedArchiveSave.data.error, /protected balance-close action/i);
    submitted.archives = submitted.archives.filter(
      (archive) => archive.id !== "ARC-UNAUTHORIZED-ACTOR-REPORT",
    );
    const forgedMasterTransactionsArchive = {
      id: "MTR-FORGED-ORDER-EVIDENCE",
      kind: "master-transactions",
      actor: "Transfer Transactions",
      actorRole: "Master",
      actorCurrency: "USD",
      closedAt: "2026-08-22T13:03:00.000Z",
      balances: {},
      orders: [structuredClone(archiveA.orders[0])],
      ledger: [],
      receivables: [],
      transfers: [],
    };
    submitted.archives.unshift(forgedMasterTransactionsArchive);
    const forgedMasterArchiveSave = await request(baseUrl, "/api/app-state", {
      cookie: masterLogin.cookie,
      method: "PUT",
      body: { state: submitted, expectedRevision: beforeArchiveSave.data.revision },
    });
    assert.equal(forgedMasterArchiveSave.response.status, 409);
    assert.match(forgedMasterArchiveSave.data.error, /protected balance-close action/i);
    submitted.archives = submitted.archives.filter(
      (archive) => archive.id !== forgedMasterTransactionsArchive.id,
    );
    const masterTransactionClosedAt = "2026-08-22T13:05:00.000Z";
    const closedTransfer = {
      id: "TRF-SERVER-HARDENING",
      recordKey: "TRF-SERVER-HARDENING",
      masterTransactionCycle: 0,
      from: "Master",
      to: "Safe Broker",
      initiatedBy: "Master",
      sourceCurrency: "USD",
      sourceAmountMinor: 100,
      currency: "USD",
      amountMinor: 100,
      rate: "1",
      commissionPercent: 0,
      commissionMinor: 0,
      commissionLiability: "",
      remarks: "Server hardening transfer",
      state: "Approved",
      journal: "JRN-MTR-SERVER-HARDENING",
      reversalJournal: "",
      createdAt: "2026-08-22T13:04:00.000Z",
      sentAt: "2026-08-22T13:04:00.000Z",
      approvedAt: "2026-08-22T13:04:30.000Z",
      paidOutAt: "",
      reversedAt: "",
      reversedBy: "",
      masterTransactionClosedAt,
      masterTransactionArchiveId: "MTR-SERVER-HARDENING",
    };
    submitted.transfers = [closedTransfer, ...(submitted.transfers || [])];
    const closedTransferSnapshot = { ...closedTransfer };
    delete closedTransferSnapshot.masterTransactionArchiveId;
    const masterTransactionsArchive = {
      id: "MTR-SERVER-HARDENING",
      kind: "master-transactions",
      actor: "Transfer Transactions",
      actorRole: "Master",
      actorCurrency: "USD",
      closedAt: masterTransactionClosedAt,
      balances: {},
      orders: [],
      ledger: [],
      receivables: [],
      transfers: [{
        ...closedTransferSnapshot,
        actor: "Transfer Transactions",
        archivedAt: masterTransactionClosedAt,
      }],
      exactNewArchiveMarker: true,
    };
    submitted.archives.unshift(masterTransactionsArchive);
    const balancesBefore = structuredClone(beforeArchiveSave.data.state.settlements);
    const ledgerFinancialsBefore = beforeArchiveSave.data.state.ledger.map((line) => ({
      account: line.account,
      direction: line.direction,
      currency: line.currency,
      amountMinor: line.amountMinor,
    }));
    const archiveSave = await requestOk(baseUrl, "/api/app-state", {
      cookie: masterLogin.cookie,
      method: "PUT",
      body: { state: submitted, expectedRevision: beforeArchiveSave.data.revision },
    });

    assert.deepEqual(archiveSave.data.state.archives.find((archive) => archive.id === archiveA.id), archiveA);
    assert.deepEqual(archiveSave.data.state.archives.find((archive) => archive.id === archiveB.id), archiveB);
    assert.deepEqual(
      archiveSave.data.state.archives.find((archive) => archive.id === masterTransactionsArchive.id),
      masterTransactionsArchive,
    );
    assert.equal(archiveSave.data.state.archives.some((archive) => archive.id === "ARC-UNAUTHORIZED-ACTOR-REPORT"), false);
    assert.deepEqual(archiveSave.data.state.settlements, balancesBefore);
    assert.deepEqual(archiveSave.data.state.ledger.map((line) => ({
      account: line.account,
      direction: line.direction,
      currency: line.currency,
      amountMinor: line.amountMinor,
    })), ledgerFinancialsBefore);

    const persistedAfter = JSON.parse(await readFile(databasePath, "utf8"));
    assert.deepEqual(persistedAfter.appStates[workspaceId].archives.find((archive) => archive.id === archiveA.id), archiveA);
    assert.deepEqual(persistedAfter.appStates[workspaceId].archives.find((archive) => archive.id === archiveB.id), archiveB);
    assert.deepEqual(
      persistedAfter.appStates[workspaceId].archives.find((archive) => archive.id === masterTransactionsArchive.id),
      masterTransactionsArchive,
    );

    const manualSeedState = structuredClone(archiveSave.data.state);
    const manualPostedAt = "2026-08-22T13:10:00.000Z";
    const manualEntryId = "JNL-MTR-MARKER-REGRESSION";
    const manualJournal = "JRN-MTR-MARKER-REGRESSION";
    const manualLines = [
      {
        entryId: manualEntryId,
        journal: manualJournal,
        source: "JOURNAL",
        account: "MASTER_FX_CLEARING",
        direction: "Debit",
        currency: "USD",
        amountMinor: 55,
        masterTransactionCycle: 1,
        postedAt: manualPostedAt,
      },
      {
        entryId: manualEntryId,
        journal: manualJournal,
        source: "JOURNAL",
        account: "MASTER_BANK",
        direction: "Credit",
        currency: "USD",
        amountMinor: 55,
        masterTransactionCycle: 1,
        postedAt: manualPostedAt,
      },
    ];
    manualSeedState.ledger = [...manualLines, ...(manualSeedState.ledger || [])];
    const manualSeeded = await requestOk(baseUrl, "/api/app-state", {
      cookie: masterLogin.cookie,
      method: "PUT",
      body: { state: manualSeedState, expectedRevision: archiveSave.data.revision },
    });

    const markerArchiveId = "MTR-MARKER-REGRESSION";
    const markerClosedAt = "2026-08-22T13:11:00.000Z";
    const markerCloseState = structuredClone(manualSeeded.data.state);
    markerCloseState.ledger = markerCloseState.ledger.map((line) =>
      line.entryId === manualEntryId
        ? { ...line, masterTransactionArchiveId: markerArchiveId, masterTransactionClosedAt: markerClosedAt }
        : line
    );
    const markerLedgerSnapshots = markerCloseState.ledger
      .filter((line) => line.entryId === manualEntryId)
      .map((line) => ({ ...line, actor: "Transfer Transactions", archivedAt: markerClosedAt }));
    markerCloseState.archives.unshift({
      id: markerArchiveId,
      kind: "master-transactions",
      actor: "Transfer Transactions",
      actorRole: "Master",
      actorCurrency: "USD",
      closedAt: markerClosedAt,
      balances: {},
      orders: [],
      ledger: markerLedgerSnapshots,
      receivables: [],
      transfers: [],
    });
    const markerClosed = await requestOk(baseUrl, "/api/app-state", {
      cookie: masterLogin.cookie,
      method: "PUT",
      body: { state: markerCloseState, expectedRevision: manualSeeded.data.revision },
    });
    const markedLiveLines = markerClosed.data.state.ledger.filter((line) => line.entryId === manualEntryId);
    assert.equal(markedLiveLines.length, 2);
    assert.equal(markedLiveLines.every((line) =>
      line.masterTransactionArchiveId === markerArchiveId && line.masterTransactionClosedAt === markerClosedAt
    ), true, "Validated Master-transaction close markers must survive persisted-line canonicalization.");
    assert.equal(markerClosed.data.state.archives.filter((archive) => archive.id === markerArchiveId).length, 1);

    const markerRoundTrip = await requestOk(baseUrl, "/api/app-state", { cookie: masterLogin.cookie });
    assert.equal(markerRoundTrip.data.state.ledger
      .filter((line) => line.entryId === manualEntryId)
      .every((line) => line.masterTransactionClosedAt === markerClosedAt), true);
    assert.equal(markerRoundTrip.data.state.ledger
      .filter((line) => line.entryId === manualEntryId && !line.masterTransactionClosedAt).length, 0);

    const withdrawalEntryId = "WDL-MTR-MARKER-REGRESSION";
    const withdrawalJournal = "JRN-WDL-MTR-MARKER-REGRESSION";
    const withdrawalPostedAt = "2026-08-22T13:12:00.000Z";
    const withdrawalLines = [
      {
        entryId: withdrawalEntryId,
        actorLedgerNumber: "LGR-WDL-MTR-MARKER-REGRESSION",
        journal: withdrawalJournal,
        source: "WITHDRAWAL",
        account: "Safe Broker ACTOR_CLEARING",
        direction: "Credit",
        currency: "USD",
        amountMinor: 80,
        masterTransactionCycle: 2,
        postedAt: withdrawalPostedAt,
      },
      {
        entryId: withdrawalEntryId,
        journal: withdrawalJournal,
        source: "WITHDRAWAL",
        account: "MASTER_FX_CLEARING",
        direction: "Debit",
        currency: "USD",
        amountMinor: 80,
        masterTransactionCycle: 2,
        postedAt: withdrawalPostedAt,
      },
      {
        entryId: withdrawalEntryId,
        journal: withdrawalJournal,
        source: "WITHDRAWAL_COMMISSION",
        account: "MASTER_COMMISSION_EXPENSE",
        direction: "Debit",
        currency: "USD",
        amountMinor: 5,
        masterTransactionCycle: 2,
        postedAt: withdrawalPostedAt,
      },
      {
        entryId: withdrawalEntryId,
        journal: withdrawalJournal,
        source: "WITHDRAWAL_COMMISSION",
        account: "MASTER_FEE_REVENUE",
        direction: "Credit",
        currency: "USD",
        amountMinor: 5,
        masterTransactionCycle: 2,
        postedAt: withdrawalPostedAt,
      },
    ];
    const withdrawalSeedState = structuredClone(markerRoundTrip.data.state);
    withdrawalSeedState.ledger = [...withdrawalLines, ...(withdrawalSeedState.ledger || [])];
    const withdrawalSeeded = await requestOk(baseUrl, "/api/app-state", {
      cookie: masterLogin.cookie,
      method: "PUT",
      body: { state: withdrawalSeedState, expectedRevision: markerRoundTrip.data.revision },
    });

    const withdrawalArchiveId = "MTR-WDL-MARKER-REGRESSION";
    const withdrawalClosedAt = "2026-08-22T13:13:00.000Z";
    const withdrawalCloseState = structuredClone(withdrawalSeeded.data.state);
    withdrawalCloseState.ledger = withdrawalCloseState.ledger.map((line) =>
      line.entryId === withdrawalEntryId
        ? { ...line, masterTransactionArchiveId: withdrawalArchiveId, masterTransactionClosedAt: withdrawalClosedAt }
        : line
    );
    const actorWithdrawalSnapshot = withdrawalCloseState.ledger.find((line) =>
      line.entryId === withdrawalEntryId
      && line.source === "WITHDRAWAL"
      && line.account === "Safe Broker ACTOR_CLEARING"
    );
    withdrawalCloseState.archives.unshift({
      id: withdrawalArchiveId,
      kind: "master-transactions",
      actor: "Transfer Transactions",
      actorRole: "Master",
      actorCurrency: "USD",
      closedAt: withdrawalClosedAt,
      balances: {},
      orders: [],
      ledger: [{ ...actorWithdrawalSnapshot, actor: "Transfer Transactions", archivedAt: withdrawalClosedAt }],
      receivables: [],
      transfers: [],
    });
    const withdrawalClosed = await requestOk(baseUrl, "/api/app-state", {
      cookie: masterLogin.cookie,
      method: "PUT",
      body: { state: withdrawalCloseState, expectedRevision: withdrawalSeeded.data.revision },
    });
    const closedWithdrawalLines = withdrawalClosed.data.state.ledger.filter((line) => line.entryId === withdrawalEntryId);
    assert.equal(closedWithdrawalLines.length, 4);
    assert.equal(closedWithdrawalLines.every((line) =>
      line.masterTransactionArchiveId === withdrawalArchiveId
      && line.masterTransactionClosedAt === withdrawalClosedAt
    ), true, "All rows in a validated withdrawal group, including master-only commission counterparts, stay closed.");

    const withdrawalRoundTrip = await requestOk(baseUrl, "/api/app-state", { cookie: masterLogin.cookie });
    assert.equal(withdrawalRoundTrip.data.state.ledger
      .filter((line) => line.entryId === withdrawalEntryId && !line.masterTransactionClosedAt).length, 0);
  } finally {
    serverProcess.kill();
    await new Promise((resolve) => serverProcess.once("exit", resolve));
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
