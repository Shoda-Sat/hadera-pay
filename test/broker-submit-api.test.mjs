import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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

function pendingOrder({ brokerActorId, broker, suffix }) {
  const createdAt = new Date(Date.now() + suffix).toISOString();
  const id = "ORD-1";
  return {
    id,
    routingSubmissionId: "ROUTE-SEND-ORD-1-INITIAL",
    brokerActorId,
    broker,
    brokerOrderNumber: "TMP1",
    brokerOrderNumberCycle: 0,
    agentActorId: "",
    agent: "Unassigned",
    sourceCurrency: "USD",
    payoutCurrency: "ETB",
    sourceAmountMinor: 10_000 + suffix,
    payoutAmountMinor: 2_000_000 + suffix,
    commissionMinor: 200,
    commissionPercent: 2,
    grossMinor: 10_200 + suffix,
    orderCommissionLiability: "Broker",
    rate: 200,
    senderName: `Sender ${suffix}`,
    receiverName: `Receiver ${suffix}`,
    receiverCity: "Addis Ababa",
    accountNumber: `ACCOUNT-${suffix}`,
    phoneNumber: `09000000${suffix}`,
    remarks: "",
    fundingType: suffix === 1 ? "credit" : "cash",
    state: "Pending Forward",
    journal: "",
    createdAt,
    sentAt: createdAt,
    updatedAt: createdAt,
  };
}

function submitIntent(order, expectedRevision, suffix) {
  const customers = [
    {
      id: "CUST-1",
      actorId: order.brokerActorId,
      kind: "sender",
      name: order.senderName,
      receiverCity: "",
      accountNumber: "",
      phoneNumber: "",
      remarks: "",
      updatedAt: order.updatedAt,
    },
    {
      id: "CUST-2",
      actorId: order.brokerActorId,
      kind: "receiver",
      name: order.receiverName,
      receiverCity: order.receiverCity,
      accountNumber: order.accountNumber,
      phoneNumber: order.phoneNumber,
      remarks: order.remarks,
      updatedAt: order.updatedAt,
    },
  ];
  return {
    attemptId: order.routingSubmissionId,
    order,
    previousOrder: null,
    receivable: suffix === 1 ? {
      id: "REC-1",
      orderId: order.id,
      brokerOrderNumber: order.brokerOrderNumber,
      agentOrderNumber: "",
      borrower: order.broker,
      borrowerActorId: order.brokerActorId,
      currency: order.sourceCurrency,
      principalMinor: order.sourceAmountMinor,
      senderName: order.senderName,
      receiverName: order.receiverName,
      creditReminder: "Atomic reminder",
      payments: [],
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    } : null,
    removeReceivable: false,
    customers,
    orderCounter: 1,
    receivableCounter: suffix === 1 ? 1 : 0,
    customerCounter: 2,
    expectedRevision,
  };
}

test("atomic Broker Send accepts simultaneous colliding local IDs without losing either order", { timeout: 30_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "haderapay-broker-submit-"));
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const ownerPassword = crypto.randomBytes(18).toString("base64url");
  const masterPassword = crypto.randomBytes(14).toString("base64url");
  const firstBrokerPassword = crypto.randomBytes(14).toString("base64url");
  const secondBrokerPassword = crypto.randomBytes(14).toString("base64url");
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
    const owner = await requestOk(baseUrl, "/api/auth/login", {
      method: "POST",
      body: { email: "Owner", password: ownerPassword },
    });
    await requestOk(baseUrl, "/api/owner/masters", {
      cookie: owner.cookie,
      method: "POST",
      body: {
        name: "Broker Submit Master",
        email: "broker-submit-master@example.com",
        password: masterPassword,
        currency: "USD",
        plan: "one_month",
      },
    });
    const master = await requestOk(baseUrl, "/api/auth/login", {
      method: "POST",
      body: { email: "broker-submit-master@example.com", password: masterPassword },
    });
    const firstBroker = await createActorAccount(baseUrl, master.cookie, {
      name: "First Atomic Broker",
      email: "first-atomic-broker@example.com",
      password: firstBrokerPassword,
      actorRole: "Broker",
      currency: "USD",
    });
    const secondBroker = await createActorAccount(baseUrl, master.cookie, {
      name: "Second Atomic Broker",
      email: "second-atomic-broker@example.com",
      password: secondBrokerPassword,
      actorRole: "Broker",
      currency: "USD",
    });
    const agent = await createActorAccount(baseUrl, master.cookie, {
      name: "Non Broker Actor",
      email: "non-broker-actor@example.com",
      password: agentPassword,
      actorRole: "Agent",
      currency: "ETB",
    });

    const initialState = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    const managedBroker = {
      id: "ACT-MANAGED-BROKER",
      workspaceId: master.data.session.workspace.id,
      name: "Master Managed Broker",
      role: "Broker",
      currency: "USD",
      brokerCode: "MMB",
      active: true,
      managedByMaster: true,
      transferEnabled: true,
      transferMode: "master",
      workingCurrencies: [],
    };
    const stateWithManagedBroker = structuredClone(initialState.data.state);
    stateWithManagedBroker.actors.push(managedBroker);
    const fixedRateBroker = stateWithManagedBroker.actors.find((actor) =>
      actor.id === firstBroker.data.session.membership.actorId
    );
    fixedRateBroker.orderFixedRates = { ETB: { enabled: true, rate: 205 } };
    const baseline = await requestOk(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: { state: stateWithManagedBroker, expectedRevision: initialState.data.revision },
    });
    const untouchedLedger = structuredClone(baseline.data.state.ledger || []);
    const untouchedArchives = structuredClone(baseline.data.state.archives || []);
    const firstOrder = pendingOrder({
      brokerActorId: firstBroker.data.session.membership.actorId,
      broker: "First Atomic Broker",
      suffix: 1,
    });
    firstOrder.rate = 999;
    firstOrder.payoutAmountMinor = 9_990_000;
    const secondOrder = pendingOrder({
      brokerActorId: secondBroker.data.session.membership.actorId,
      broker: "Second Atomic Broker",
      suffix: 2,
    });
    const firstIntent = submitIntent(firstOrder, baseline.data.revision, 1);
    const secondIntent = submitIntent(secondOrder, baseline.data.revision, 2);

    const [firstResult, secondResult] = await Promise.all([
      requestOk(baseUrl, "/api/app-state/submit-order", {
        cookie: firstBroker.cookie,
        method: "POST",
        body: firstIntent,
      }),
      requestOk(baseUrl, "/api/app-state/submit-order", {
        cookie: secondBroker.cookie,
        method: "POST",
        body: secondIntent,
      }),
    ]);
    assert.equal([firstResult.data.state, secondResult.data.state].filter(Boolean).length, 1,
      "Only the request whose revision became stale should receive a full synchronization state.");
    assert.ok([firstResult.data, secondResult.data].some((data) => !data.state && JSON.stringify(data).length < 20_000),
      "A normal Broker send acknowledgement must stay a small delta response.");

    const stored = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    const submittedOrders = stored.data.state.orders.filter((order) =>
      order.routingSubmissionId === "ROUTE-SEND-ORD-1-INITIAL" &&
      [firstOrder.brokerActorId, secondOrder.brokerActorId].includes(order.brokerActorId)
    );
    assert.equal(submittedOrders.length, 2);
    assert.equal(new Set(submittedOrders.map((order) => order.id)).size, 2,
      "The server must remap the colliding local order ID instead of overwriting either Broker.");
    assert.deepEqual(new Set(submittedOrders.map((order) => order.brokerActorId)), new Set([firstOrder.brokerActorId, secondOrder.brokerActorId]));
    assert.ok(submittedOrders.every((order) => order.state === "Pending Forward"));
    assert.deepEqual(stored.data.state.ledger || [], untouchedLedger);
    assert.deepEqual(stored.data.state.archives || [], untouchedArchives);

    const submittedCustomers = stored.data.state.savedCustomers.filter((customer) =>
      [firstOrder.brokerActorId, secondOrder.brokerActorId].includes(customer.actorId)
    );
    assert.equal(submittedCustomers.length, 4);
    assert.equal(new Set(submittedCustomers.map((customer) => customer.id)).size, 4,
      "Simultaneous Brokers must not overwrite each other's locally numbered customers.");
    const storedReceivable = stored.data.state.receivables.find((receivable) => receivable.borrowerActorId === firstOrder.brokerActorId);
    const storedFirstOrder = submittedOrders.find((order) => order.brokerActorId === firstOrder.brokerActorId);
    assert.equal(storedFirstOrder.rate, 205);
    assert.equal(storedFirstOrder.payoutAmountMinor, 20_502);
    assert.equal(storedReceivable.orderId, storedFirstOrder.id);
    assert.equal(storedReceivable.creditReminder, "Atomic reminder");

    const revisionBeforeReplay = stored.data.revision;
    const replay = await requestOk(baseUrl, "/api/app-state/submit-order", {
      cookie: firstBroker.cookie,
      method: "POST",
      body: { ...firstIntent, expectedRevision: revisionBeforeReplay },
    });
    assert.equal(replay.data.alreadyApplied, true);
    assert.equal(replay.data.order.id, storedFirstOrder.id);
    assert.equal(replay.data.revision, revisionBeforeReplay);
    const afterReplay = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    assert.equal(afterReplay.data.revision, revisionBeforeReplay);
    assert.equal(afterReplay.data.state.orders.filter((order) =>
      order.brokerActorId === firstOrder.brokerActorId && order.routingSubmissionId === firstOrder.routingSubmissionId
    ).length, 1);

    const conflictingReplay = await request(baseUrl, "/api/app-state/submit-order", {
      cookie: firstBroker.cookie,
      method: "POST",
      body: {
        ...firstIntent,
        order: { ...firstOrder, receiverName: "Changed receiver" },
        expectedRevision: revisionBeforeReplay,
      },
    });
    assert.equal(conflictingReplay.response.status, 409);

    const forbidden = await request(baseUrl, "/api/app-state/submit-order", {
      cookie: agent.cookie,
      method: "POST",
      body: firstIntent,
    });
    assert.equal(forbidden.response.status, 403);

    const beforeManagedSend = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    const managedOrder = {
      ...pendingOrder({ brokerActorId: managedBroker.id, broker: managedBroker.name, suffix: 3 }),
      id: "ORD-MANAGED-1",
      routingSubmissionId: "ROUTE-SEND-MANAGED-BROKER-1",
      brokerOrderNumber: "MMB001",
    };
    const managedIntent = {
      ...submitIntent(managedOrder, "stale-master-revision", 3),
      actingActorId: managedBroker.id,
    };
    const managedResult = await requestOk(baseUrl, "/api/app-state/submit-order", {
      cookie: master.cookie,
      method: "POST",
      body: managedIntent,
    });
    assert.equal(managedResult.data.order.brokerActorId, managedBroker.id);
    assert.equal(managedResult.data.order.broker, managedBroker.name);
    assert.ok(managedResult.data.state?.actors.some((actor) => actor.id === firstBroker.data.session.membership.actorId),
      "A stale-revision response to Master must retain the full Master workspace view.");

    const unmanagedAttempt = await request(baseUrl, "/api/app-state/submit-order", {
      cookie: master.cookie,
      method: "POST",
      body: { ...managedIntent, actingActorId: firstBroker.data.session.membership.actorId },
    });
    assert.equal(unmanagedAttempt.response.status, 403,
      "Master must not submit through a Broker profile that has its own login.");

    const afterManagedSend = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    assert.deepEqual(afterManagedSend.data.state.ledger || [], untouchedLedger);
    assert.deepEqual(afterManagedSend.data.state.archives || [], untouchedArchives);
    assert.ok(afterManagedSend.data.state.orders.some((order) =>
      order.routingSubmissionId === managedOrder.routingSubmissionId && order.brokerActorId === managedBroker.id
    ));
  } finally {
    serverProcess.kill();
    await new Promise((resolve) => serverProcess.once("exit", resolve));
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
