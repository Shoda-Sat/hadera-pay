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
    if (serverProcess.exitCode !== null) throw new Error(`Test server stopped before startup.\n${readStderr()}`);
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // The isolated server is still starting.
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

async function mutatePersistedWorkspace(dataDirectory, workspaceId, mutate) {
  const databasePath = path.join(dataDirectory, "auth-db.json");
  const database = JSON.parse(await readFile(databasePath, "utf8"));
  const state = database.appStates?.[workspaceId];
  assert.ok(state, `Workspace ${workspaceId} was not persisted.`);
  mutate(state, database);
  state._syncRevision = `test-${Date.now().toString(36)}-${crypto.randomBytes(5).toString("hex")}`;
  await writeFile(databasePath, JSON.stringify(database, null, 2));
  return structuredClone(state);
}

async function createActorAccount(baseUrl, masterCookie, { name, email, password, actorRole, currency }) {
  const invite = await requestOk(baseUrl, "/api/invites", {
    cookie: masterCookie,
    method: "POST",
    body: { actorRole, currency, workingCurrencies: [currency] },
  });
  return requestOk(baseUrl, "/api/auth/signup", {
    method: "POST",
    body: { name, email, password, inviteCode: invite.data.invite.code, role: "Actor" },
  });
}

function pendingOrder({ id, brokerActorId, createdAt, suffix }) {
  return {
    id,
    brokerActorId,
    broker: "Atomic Broker",
    brokerOrderNumber: `TMP${suffix}`,
    brokerOrderNumberCycle: 0,
    agentActorId: "",
    agent: "Unassigned",
    sourceCurrency: "USD",
    payoutCurrency: "ETB",
    sourceAmountMinor: 12_500 + suffix,
    payoutAmountMinor: 2_500_000 + suffix,
    commissionMinor: 250,
    commissionPercent: 2,
    grossMinor: 12_750 + suffix,
    orderCommissionLiability: "Broker",
    rate: 200,
    senderName: `Atomic Sender ${suffix}`,
    receiverName: `Atomic Receiver ${suffix}`,
    accountNumber: `ATOMIC-ACCOUNT-${suffix}`,
    fundingType: "cash",
    state: "Pending Forward",
    journal: "",
    routingSubmissionId: `ROUTE-SEND-${id}`,
    createdAt,
    sentAt: createdAt,
    updatedAt: createdAt,
  };
}

function expectedOrderIdentity(order) {
  return Object.fromEntries([
    "id",
    "brokerActorId",
    "broker",
    "createdAt",
    "sentAt",
    "sourceCurrency",
    "sourceAmountMinor",
    "payoutCurrency",
    "payoutAmountMinor",
    "receiverName",
    "accountNumber",
    "phoneNumber",
  ].filter((field) => Object.prototype.hasOwnProperty.call(order, field)).map((field) => [field, order[field]]));
}

function forwardIntent(order, targetActorId, attemptId, expectedRevision, terms = {}) {
  return {
    orderId: order.id,
    targetActorId,
    attemptId,
    expectedRevision,
    expectedRoutingSubmissionId: order.routingSubmissionId || "",
    expectedOrderUpdatedAt: order.updatedAt || "",
    expectedOrder: expectedOrderIdentity(order),
    payoutDivider: terms.divider ?? null,
    payoutPercent: terms.percent ?? null,
    ...(terms.preferredChatId ? { preferredChatId: terms.preferredChatId } : {}),
  };
}

test("atomic Master forwarding preserves concurrent Broker work and is idempotent", { timeout: 30_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "haderapay-master-forward-"));
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const ownerPassword = crypto.randomBytes(18).toString("base64url");
  const masterPassword = crypto.randomBytes(14).toString("base64url");
  const brokerPassword = crypto.randomBytes(14).toString("base64url");
  const agentPassword = crypto.randomBytes(14).toString("base64url");
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
        name: "Atomic Master",
        email: "atomic-master@example.com",
        password: masterPassword,
        currency: "USD",
        plan: "one_month",
      },
    });
    const master = await requestOk(baseUrl, "/api/auth/login", {
      method: "POST",
      body: { email: "atomic-master@example.com", password: masterPassword },
    });
    const broker = await createActorAccount(baseUrl, master.cookie, {
      name: "Atomic Broker",
      email: "atomic-broker@example.com",
      password: brokerPassword,
      actorRole: "Broker",
      currency: "USD",
    });
    const payer = await createActorAccount(baseUrl, master.cookie, {
      name: "Atomic Payer",
      email: "atomic-payer@example.com",
      password: agentPassword,
      actorRole: "Agent",
      currency: "ETB",
    });
    const brokerActorId = broker.data.session.membership.actorId;
    const payerActorId = payer.data.session.membership.actorId;
    const workspaceId = master.data.session.workspace.id;

    const brokerView = await requestOk(baseUrl, "/api/app-state", { cookie: broker.cookie });
    const firstCreatedAt = new Date().toISOString();
    const firstOrder = pendingOrder({
      id: `ORD-ATOMIC-${crypto.randomBytes(6).toString("hex").toUpperCase()}`,
      brokerActorId,
      createdAt: firstCreatedAt,
      suffix: 1,
    });
    const firstReceivable = {
      id: `REC-ATOMIC-${crypto.randomBytes(6).toString("hex").toUpperCase()}`,
      orderId: firstOrder.id,
      brokerOrderNumber: firstOrder.brokerOrderNumber,
      agentOrderNumber: "",
      borrower: "Atomic Broker",
      borrowerActorId: brokerActorId,
      currency: "USD",
      principalMinor: firstOrder.sourceAmountMinor,
      payments: [],
      creditReminder: "initial reminder",
      createdAt: firstCreatedAt,
      updatedAt: firstCreatedAt,
    };
    const submittedState = structuredClone(brokerView.data.state);
    submittedState.orders = [firstOrder, ...(submittedState.orders || [])];
    submittedState.receivables = [firstReceivable, ...(submittedState.receivables || [])];
    await requestOk(baseUrl, "/api/app-state", {
      cookie: broker.cookie,
      method: "PUT",
      body: { state: submittedState, expectedRevision: brokerView.data.revision },
    });

    const staleMasterView = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    const storedFirst = staleMasterView.data.state.orders.find((order) => order.id === firstOrder.id);
    assert.ok(storedFirst);
    const untouchedLedger = structuredClone(staleMasterView.data.state.ledger || []);
    const untouchedArchives = structuredClone(staleMasterView.data.state.archives || []);
    const untouchedTransfers = structuredClone(staleMasterView.data.state.transfers || []);
    const untouchedSettlements = structuredClone(staleMasterView.data.state.settlements || []);
    const untouchedMasterBankEntries = structuredClone(staleMasterView.data.state.masterBankEntries || []);
    const originalFinancialFields = Object.fromEntries([
      "sourceCurrency",
      "payoutCurrency",
      "sourceAmountMinor",
      "payoutAmountMinor",
      "commissionMinor",
      "commissionPercent",
      "grossMinor",
      "rate",
      "routingSubmissionId",
    ].map((field) => [field, storedFirst[field]]));

    const missingIdentityIntent = forwardIntent(
      storedFirst,
      payerActorId,
      `ROUTE-FORWARD-MISSING-IDENTITY-${crypto.randomBytes(5).toString("hex")}`,
      staleMasterView.data.revision
    );
    delete missingIdentityIntent.expectedOrder;
    const missingIdentity = await request(baseUrl, "/api/app-state/forward-order", {
      cookie: master.cookie,
      method: "POST",
      body: missingIdentityIntent,
    });
    assert.equal(missingIdentity.response.status, 400, "Forwarding must require the exact reviewed order identity.");

    const missingTimestampIntent = forwardIntent(
      storedFirst,
      payerActorId,
      `ROUTE-FORWARD-MISSING-TIMESTAMP-${crypto.randomBytes(5).toString("hex")}`,
      staleMasterView.data.revision
    );
    delete missingTimestampIntent.expectedOrderUpdatedAt;
    const missingTimestamp = await request(baseUrl, "/api/app-state/forward-order", {
      cookie: master.cookie,
      method: "POST",
      body: missingTimestampIntent,
    });
    assert.equal(missingTimestamp.response.status, 400, "Forwarding must require the reviewed order timestamp.");

    const missingSubmissionIntent = forwardIntent(
      storedFirst,
      payerActorId,
      `ROUTE-FORWARD-MISSING-SUBMISSION-${crypto.randomBytes(5).toString("hex")}`,
      staleMasterView.data.revision
    );
    delete missingSubmissionIntent.expectedRoutingSubmissionId;
    const missingSubmission = await request(baseUrl, "/api/app-state/forward-order", {
      cookie: master.cookie,
      method: "POST",
      body: missingSubmissionIntent,
    });
    assert.equal(missingSubmission.response.status, 400, "Forwarding must require the reviewed Broker submission id.");

    const concurrentBrokerView = await requestOk(baseUrl, "/api/app-state", { cookie: broker.cookie });
    const secondCreatedAt = new Date(Date.now() + 1).toISOString();
    const secondOrder = pendingOrder({
      id: `ORD-ATOMIC-${crypto.randomBytes(6).toString("hex").toUpperCase()}`,
      brokerActorId,
      createdAt: secondCreatedAt,
      suffix: 2,
    });
    const concurrentState = structuredClone(concurrentBrokerView.data.state);
    concurrentState.orders = [secondOrder, ...(concurrentState.orders || [])];
    const concurrentReceivable = concurrentState.receivables.find((item) => item.orderId === firstOrder.id);
    assert.ok(concurrentReceivable);
    concurrentReceivable.creditReminder = "concurrent Broker reminder";
    concurrentState.chatConversations = [
      ...(concurrentState.chatConversations || []),
      {
        id: "CHAT-BROKER-CONCURRENT",
        type: "direct",
        name: "Atomic Broker",
        members: ["Atomic Master", "Atomic Broker"],
        messages: [{
          id: "MSG-BROKER-CONCURRENT",
          from: "Atomic Broker",
          text: "Concurrent Broker message",
          kind: "text",
          reactions: {},
          readBy: ["Atomic Broker"],
          createdAt: secondCreatedAt,
        }],
        createdAt: secondCreatedAt,
      },
    ];
    await requestOk(baseUrl, "/api/app-state", {
      cookie: broker.cookie,
      method: "PUT",
      body: { state: concurrentState, expectedRevision: concurrentBrokerView.data.revision },
    });

    const attemptId = `ROUTE-FORWARD-${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
    const staleForward = await requestOk(baseUrl, "/api/app-state/forward-order", {
      cookie: master.cookie,
      method: "POST",
      body: forwardIntent(storedFirst, payerActorId, attemptId, staleMasterView.data.revision, {
        divider: 2.5,
        percent: 1.75,
        preferredChatId: "CHAT-77",
      }),
    });
    assert.equal(staleForward.data.alreadyApplied, false);
    assert.ok(staleForward.data.state, "A stale caller should receive the concurrent server state in the same response.");
    assert.equal(staleForward.data.order.state, "Assigned");
    assert.equal(staleForward.data.order.routingForwardAttemptId, attemptId);
    assert.equal(staleForward.data.order.agentActorId, payerActorId);
    assert.equal(staleForward.data.order.forwardedPayoutDivider, 2.5);
    assert.equal(staleForward.data.order.forwardedPayoutPercent, 1.75);
    assert.ok(staleForward.data.order.agentOrderNumber);
    assert.equal(staleForward.data.receivable.agentOrderNumber, staleForward.data.order.agentOrderNumber);
    assert.equal(staleForward.data.message.id, `MSG-${attemptId}`);
    assert.equal(staleForward.data.message.orderNumber, staleForward.data.order.agentOrderNumber);
    assert.equal(staleForward.data.chat.id, "CHAT-77", "An unused valid optimistic chat id should be retained.");
    assert.ok(staleForward.data.chatCounter >= 77, "Accepting a preferred chat id must keep the counter monotonic.");
    assert.equal(staleForward.data.archived, false);

    const afterFirst = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    const assignedFirst = afterFirst.data.state.orders.find((order) => order.id === firstOrder.id);
    assert.deepEqual(
      Object.fromEntries(Object.keys(originalFinancialFields).map((field) => [field, assignedFirst[field]])),
      originalFinancialFields,
      "Forwarding must not change any financial order field."
    );
    assert.ok(afterFirst.data.state.orders.some((order) => order.id === secondOrder.id),
      "The simultaneous Broker order must survive forwarding.");
    assert.equal(
      afterFirst.data.state.receivables.find((item) => item.orderId === firstOrder.id).creditReminder,
      "concurrent Broker reminder"
    );
    assert.ok(afterFirst.data.state.chatConversations.some((chat) =>
      (chat.messages || []).some((message) => message.id === "MSG-BROKER-CONCURRENT")
    ));
    assert.deepEqual(afterFirst.data.state.ledger || [], untouchedLedger);
    assert.deepEqual(afterFirst.data.state.archives || [], untouchedArchives);
    assert.deepEqual(afterFirst.data.state.transfers || [], untouchedTransfers);
    assert.deepEqual(afterFirst.data.state.settlements || [], untouchedSettlements);
    assert.deepEqual(afterFirst.data.state.masterBankEntries || [], untouchedMasterBankEntries);
    assert.equal(afterFirst.data.state.receivables.find((item) => item.orderId === firstOrder.id).principalMinor, firstReceivable.principalMinor);
    assert.deepEqual(afterFirst.data.state.receivables.find((item) => item.orderId === firstOrder.id).payments, firstReceivable.payments);

    const replay = await requestOk(baseUrl, "/api/app-state/forward-order", {
      cookie: master.cookie,
      method: "POST",
      body: forwardIntent(storedFirst, payerActorId, attemptId, afterFirst.data.revision, {
        divider: 2.5,
        percent: 1.75,
      }),
    });
    assert.equal(replay.data.alreadyApplied, true);
    assert.equal(replay.data.revision, afterFirst.data.revision, "An exact replay must not change workspace revision.");
    assert.equal(Object.prototype.hasOwnProperty.call(replay.data, "state"), false,
      "A current caller should receive a compact forwarding acknowledgement.");

    const conflictingAttempt = await request(baseUrl, "/api/app-state/forward-order", {
      cookie: master.cookie,
      method: "POST",
      body: forwardIntent(storedFirst, payerActorId, `${attemptId}-OTHER`, afterFirst.data.revision, {
        divider: 2.5,
        percent: 1.75,
      }),
    });
    assert.equal(conflictingAttempt.response.status, 409);

    const actorAttempt = await request(baseUrl, "/api/app-state/forward-order", {
      cookie: broker.cookie,
      method: "POST",
      body: forwardIntent(storedFirst, payerActorId, attemptId, afterFirst.data.revision, {
        divider: 2.5,
        percent: 1.75,
      }),
    });
    assert.equal(actorAttempt.response.status, 403);

    const beforeSecond = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    const storedSecond = beforeSecond.data.state.orders.find((order) => order.id === secondOrder.id);
    assert.ok(storedSecond);

    await mutatePersistedWorkspace(dataDirectory, workspaceId, (persistedState) => {
      const persistedPayer = persistedState.actors.find((actor) => actor.id === payerActorId);
      assert.ok(persistedPayer);
      persistedPayer.active = false;
    });
    const inactivePayerAttempt = await request(baseUrl, "/api/app-state/forward-order", {
      cookie: master.cookie,
      method: "POST",
      body: forwardIntent(
        storedSecond,
        payerActorId,
        `ROUTE-FORWARD-INACTIVE-${crypto.randomBytes(5).toString("hex")}`,
        beforeSecond.data.revision
      ),
    });
    assert.equal(inactivePayerAttempt.response.status, 400,
      "Persisted inactive state must not be overwritten by the membership actor's active default.");

    await mutatePersistedWorkspace(dataDirectory, workspaceId, (persistedState) => {
      const persistedPayer = persistedState.actors.find((actor) => actor.id === payerActorId);
      assert.ok(persistedPayer);
      persistedPayer.active = true;
      persistedPayer.currency = "USD";
    });
    const changedCurrencyAttempt = await request(baseUrl, "/api/app-state/forward-order", {
      cookie: master.cookie,
      method: "POST",
      body: forwardIntent(
        storedSecond,
        payerActorId,
        `ROUTE-FORWARD-CURRENCY-${crypto.randomBytes(5).toString("hex")}`,
        beforeSecond.data.revision
      ),
    });
    assert.equal(changedCurrencyAttempt.response.status, 400,
      "The latest persisted payout configuration must win over stale membership defaults.");

    await mutatePersistedWorkspace(dataDirectory, workspaceId, (persistedState) => {
      const persistedPayer = persistedState.actors.find((actor) => actor.id === payerActorId);
      assert.ok(persistedPayer);
      persistedPayer.active = true;
      persistedPayer.currency = "ETB";
      persistedState.deletedActorIds = Array.from(new Set([...(persistedState.deletedActorIds || []), payerActorId]));
    });
    const deletedPayerAttempt = await request(baseUrl, "/api/app-state/forward-order", {
      cookie: master.cookie,
      method: "POST",
      body: forwardIntent(
        storedSecond,
        payerActorId,
        `ROUTE-FORWARD-DELETED-${crypto.randomBytes(5).toString("hex")}`,
        beforeSecond.data.revision
      ),
    });
    assert.equal(deletedPayerAttempt.response.status, 400, "A deleted Actor must not receive a forwarded order.");

    const foreignPayerId = "ACT-FOREIGN-PAYER";
    await mutatePersistedWorkspace(dataDirectory, workspaceId, (persistedState) => {
      persistedState.deletedActorIds = (persistedState.deletedActorIds || []).filter((actorId) => actorId !== payerActorId);
      persistedState.actors.push({
        id: foreignPayerId,
        name: "Foreign Payer",
        role: "Agent",
        currency: "ETB",
        active: true,
        managedByMaster: true,
        workspaceId: "ws-foreign",
      });
    });
    const foreignPayerAttempt = await request(baseUrl, "/api/app-state/forward-order", {
      cookie: master.cookie,
      method: "POST",
      body: forwardIntent(
        storedSecond,
        foreignPayerId,
        `ROUTE-FORWARD-FOREIGN-${crypto.randomBytes(5).toString("hex")}`,
        beforeSecond.data.revision
      ),
    });
    assert.equal(foreignPayerAttempt.response.status, 400, "A foreign-workspace Actor must not receive the order.");

    await mutatePersistedWorkspace(dataDirectory, workspaceId, (persistedState) => {
      persistedState.actors = persistedState.actors.filter((actor) => actor.id !== foreignPayerId);
    });
    const beforeCleanForward = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    const cleanStoredSecond = beforeCleanForward.data.state.orders.find((order) => order.id === secondOrder.id);
    assert.ok(cleanStoredSecond);
    const secondAttemptId = `ROUTE-FORWARD-${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
    const cleanForward = await requestOk(baseUrl, "/api/app-state/forward-order", {
      cookie: master.cookie,
      method: "POST",
      body: forwardIntent(cleanStoredSecond, payerActorId, secondAttemptId, beforeCleanForward.data.revision),
    });
    assert.equal(Object.prototype.hasOwnProperty.call(cleanForward.data, "state"), false,
      "The common forwarding path must return only its small authoritative delta.");
    assert.notEqual(cleanForward.data.order.agentOrderNumber, assignedFirst.agentOrderNumber,
      "Two queued forwards to the same payer must receive distinct numbers.");

    const simultaneousCreatedAt = new Date(Date.now() + 2).toISOString();
    const simultaneousOrders = [3, 4].map((suffix) => pendingOrder({
      id: `ORD-ATOMIC-${crypto.randomBytes(6).toString("hex").toUpperCase()}`,
      brokerActorId,
      createdAt: simultaneousCreatedAt,
      suffix,
    }));
    const beforeSimultaneous = await mutatePersistedWorkspace(dataDirectory, workspaceId, (persistedState) => {
      persistedState.orders.push(...structuredClone(simultaneousOrders));
    });
    const simultaneousAttempts = simultaneousOrders.map(() =>
      `ROUTE-FORWARD-${crypto.randomBytes(8).toString("hex").toUpperCase()}`
    );
    const simultaneousForwards = await Promise.all(simultaneousOrders.map((order, index) => requestOk(
      baseUrl,
      "/api/app-state/forward-order",
      {
        cookie: master.cookie,
        method: "POST",
        body: forwardIntent(order, payerActorId, simultaneousAttempts[index], beforeSimultaneous._syncRevision),
      }
    )));
    const simultaneousNumbers = simultaneousForwards.map((result) => result.data.order.agentOrderNumber);
    assert.equal(new Set(simultaneousNumbers).size, simultaneousNumbers.length,
      "Simultaneous forwards to one payer must allocate distinct order numbers atomically.");
    assert.ok(simultaneousForwards.every((result) => result.data.order.state === "Assigned"));

    const finalState = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    assert.equal(finalState.data.state.orders.filter((order) => order.id === firstOrder.id).length, 1);
    assert.equal(finalState.data.state.chatConversations.flatMap((chat) => chat.messages || [])
      .filter((message) => message.id === `MSG-${attemptId}`).length, 1);
    simultaneousOrders.forEach((order, index) => {
      const assigned = finalState.data.state.orders.find((candidate) => candidate.id === order.id);
      assert.equal(assigned?.routingForwardAttemptId, simultaneousAttempts[index]);
      assert.equal(finalState.data.state.chatConversations.flatMap((chat) => chat.messages || [])
        .filter((message) => message.id === `MSG-${simultaneousAttempts[index]}`).length, 1);
    });
    assert.deepEqual(finalState.data.state.ledger || [], untouchedLedger);
    assert.deepEqual(finalState.data.state.archives || [], untouchedArchives);
    assert.deepEqual(finalState.data.state.transfers || [], untouchedTransfers);
    assert.deepEqual(finalState.data.state.settlements || [], untouchedSettlements);
    assert.deepEqual(finalState.data.state.masterBankEntries || [], untouchedMasterBankEntries);

    const archivedOnlyReceivableState = await mutatePersistedWorkspace(dataDirectory, workspaceId, (persistedState) => {
      const receivable = persistedState.receivables.find((item) => item.orderId === firstOrder.id);
      assert.ok(receivable);
      persistedState.receivables = persistedState.receivables.filter((item) => item.id !== receivable.id);
      persistedState.archives.push({
        id: "ARC-ATOMIC-RECEIVABLE-ONLY",
        actor: "Atomic Broker",
        actorId: brokerActorId,
        actorRole: "Broker",
        closedAt: new Date().toISOString(),
        orders: [],
        receivables: [structuredClone(receivable)],
      });
    });
    const receivableOnlyArchives = structuredClone(archivedOnlyReceivableState.archives);
    const currentOrderReplay = await requestOk(baseUrl, "/api/app-state/forward-order", {
      cookie: master.cookie,
      method: "POST",
      body: forwardIntent(storedFirst, payerActorId, attemptId, archivedOnlyReceivableState._syncRevision, {
        divider: 2.5,
        percent: 1.75,
      }),
    });
    assert.equal(currentOrderReplay.data.archived, false);
    assert.equal(currentOrderReplay.data.receivable, null,
      "A live-order retry must not return a receivable that exists only inside a closed report.");
    const databaseAfterCurrentReplay = JSON.parse(await readFile(path.join(dataDirectory, "auth-db.json"), "utf8"));
    assert.equal(databaseAfterCurrentReplay.appStates[workspaceId].receivables.some((item) => item.orderId === firstOrder.id), false,
      "Retrying a shared current order must not resurrect its closed receivable into the live balance.");
    assert.deepEqual(databaseAfterCurrentReplay.appStates[workspaceId].archives, receivableOnlyArchives);

    const archivedPersistedState = await mutatePersistedWorkspace(dataDirectory, workspaceId, (persistedState) => {
      const orderToArchive = persistedState.orders.find((order) => order.id === firstOrder.id);
      const receivableToArchive = persistedState.receivables.find((receivable) => receivable.orderId === firstOrder.id);
      assert.ok(orderToArchive);
      const closedAt = new Date().toISOString();
      const archivedOrder = { ...structuredClone(orderToArchive), state: "Paid", paidAt: closedAt, archivedAt: closedAt };
      const archivedReceivables = receivableToArchive ? [structuredClone(receivableToArchive)] : [];
      persistedState.orders = persistedState.orders.filter((order) => order.id !== firstOrder.id);
      persistedState.receivables = persistedState.receivables.filter((receivable) => receivable.orderId !== firstOrder.id);
      persistedState.archives.push(
        {
          id: "ARC-ATOMIC-BROKER",
          actor: "Atomic Broker",
          actorId: brokerActorId,
          actorRole: "Broker",
          closedAt,
          orders: [structuredClone(archivedOrder)],
          receivables: structuredClone(archivedReceivables),
        },
        {
          id: "ARC-ATOMIC-PAYER",
          actor: "Atomic Payer",
          actorId: payerActorId,
          actorRole: "Agent",
          closedAt,
          orders: [structuredClone(archivedOrder)],
          receivables: structuredClone(archivedReceivables),
        }
      );
    });
    const archivesBeforeReplay = structuredClone(archivedPersistedState.archives);
    const ledgerBeforeArchivedReplay = structuredClone(archivedPersistedState.ledger || []);
    const archivedReplay = await requestOk(baseUrl, "/api/app-state/forward-order", {
      cookie: master.cookie,
      method: "POST",
      body: forwardIntent(storedFirst, payerActorId, attemptId, archivedPersistedState._syncRevision, {
        divider: 2.5,
        percent: 1.75,
      }),
    });
    assert.equal(archivedReplay.data.alreadyApplied, true);
    assert.equal(archivedReplay.data.archived, true, "A closed-order acknowledgement must be marked as archived.");
    assert.ok(archivedReplay.data.state, "Archived replay must return the full latest state for safe client cleanup.");
    assert.equal(archivedReplay.data.state.orders.some((order) => order.id === firstOrder.id), false,
      "Archived replay state must not resurrect the closed order.");
    assert.equal(archivedReplay.data.revision, archivedPersistedState._syncRevision,
      "Read-only archived replay must not advance the workspace revision.");
    const databaseAfterReplay = JSON.parse(await readFile(path.join(dataDirectory, "auth-db.json"), "utf8"));
    assert.deepEqual(databaseAfterReplay.appStates[workspaceId].archives, archivesBeforeReplay,
      "Archived replay must leave all closed reports byte-equivalent as data.");
    assert.deepEqual(databaseAfterReplay.appStates[workspaceId].ledger || [], ledgerBeforeArchivedReplay);

    const collisionState = await mutatePersistedWorkspace(dataDirectory, workspaceId, (persistedState) => {
      const closedAt = new Date().toISOString();
      persistedState.archives.push({
        id: "ARC-ATOMIC-ATTEMPT-COLLISION",
        actor: "Atomic Broker",
        actorId: brokerActorId,
        actorRole: "Broker",
        closedAt,
        orders: [{
          ...structuredClone(secondOrder),
          id: "ORD-OTHER-ATTEMPT-OWNER",
          collisionSourceOrderId: firstOrder.id,
          routingForwardAttemptId: attemptId,
          agent: "Atomic Payer",
          agentActorId: payerActorId,
          forwardedPayoutDivider: 2.5,
          forwardedPayoutPercent: 1.75,
          state: "Paid",
          archivedAt: closedAt,
        }],
        receivables: [],
      });
    });
    const collisionArchives = structuredClone(collisionState.archives);
    const conflictingArchivedOwner = await request(baseUrl, "/api/app-state/forward-order", {
      cookie: master.cookie,
      method: "POST",
      body: forwardIntent(storedFirst, payerActorId, attemptId, collisionState._syncRevision, {
        divider: 2.5,
        percent: 1.75,
      }),
    });
    assert.equal(conflictingArchivedOwner.response.status, 409,
      "An attempt id owned by a different logical archived order must be rejected.");
    const databaseAfterCollision = JSON.parse(await readFile(path.join(dataDirectory, "auth-db.json"), "utf8"));
    assert.deepEqual(databaseAfterCollision.appStates[workspaceId].archives, collisionArchives,
      "A rejected attempt collision must not modify closed reports.");
  } finally {
    if (serverProcess.exitCode === null) {
      serverProcess.kill();
      await new Promise((resolve) => serverProcess.once("exit", resolve));
    }
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
