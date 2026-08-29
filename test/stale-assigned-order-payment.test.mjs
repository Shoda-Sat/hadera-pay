import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { recoveredOrderMatches } from "../src/orderIntegrity.mjs";

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
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (serverProcess.exitCode !== null) throw new Error(`Test server stopped before startup.\n${readStderr()}`);
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // The isolated test server is still starting.
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

async function createActor(baseUrl, masterCookie, { role, currency, name, email, password }) {
  const invite = await requestOk(baseUrl, "/api/invites", {
    cookie: masterCookie,
    method: "POST",
    body: { actorRole: role, currency, workingCurrencies: [] },
  });
  const signup = await requestOk(baseUrl, "/api/auth/signup", {
    method: "POST",
    body: { name, email, password, inviteCode: invite.data.invite.code, role: "Actor" },
  });
  return { invite: invite.data.invite, signup };
}

test("atomic Asmara payment survives a stale revision, reload, and exact retry", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "haderapay-stale-payment-"));
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const ownerPassword = crypto.randomBytes(18).toString("base64url");
  const masterPassword = crypto.randomBytes(14).toString("base64url");
  const brokerPassword = crypto.randomBytes(14).toString("base64url");
  const payerPassword = crypto.randomBytes(14).toString("base64url");
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
        name: "Stale Payment Master",
        email: "stale-payment-master@example.com",
        password: masterPassword,
        currency: "USD",
        plan: "one_month",
      },
    });
    const master = await requestOk(baseUrl, "/api/auth/login", {
      method: "POST",
      body: { email: "stale-payment-master@example.com", password: masterPassword },
    });
    const brokerAccount = await createActor(baseUrl, master.cookie, {
      role: "Broker",
      currency: "EUR",
      name: "PPP",
      email: "stale-payment-broker@example.com",
      password: brokerPassword,
    });
    const payerAccount = await createActor(baseUrl, master.cookie, {
      role: "Agent",
      currency: "ETB",
      name: "Asmara",
      email: "stale-payment-asmara@example.com",
      password: payerPassword,
    });

    const initial = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    const broker = initial.data.state.actors.find((actor) => actor.id === brokerAccount.invite.actorId);
    const payer = initial.data.state.actors.find((actor) => actor.id === payerAccount.invite.actorId);
    assert.ok(broker);
    assert.ok(payer);

    const orderId = "ORD-ASMARA-ORPHAN-JOURNAL";
    const concurrentOrderId = "ORD-ASMARA-CONCURRENT-PAYMENT";
    const createdAt = "2026-08-29T08:00:00.000Z";
    const seededState = structuredClone(initial.data.state);
    const assignedOrder = {
      id: orderId,
      internalOrderId: orderId,
      brokerActorId: broker.id,
      broker: broker.name,
      brokerOrderNumber: "PPP900",
      agentActorId: payer.id,
      agent: payer.name,
      sourceCurrency: "EUR",
      sourceAmountMinor: 50_000,
      payoutCurrency: "ETB",
      payoutAmountMinor: 98_500,
      commissionPercent: 0,
      commissionMinor: 0,
      grossMinor: 50_000,
      rate: 1.97,
      state: "Assigned",
      journal: "JRN-ORPHAN-ASMARA",
      createdAt,
      assignedAt: createdAt,
      updatedAt: createdAt,
    };
    const concurrentAssignedOrder = {
      ...assignedOrder,
      id: concurrentOrderId,
      internalOrderId: concurrentOrderId,
      brokerOrderNumber: "PPP901",
      journal: "",
      createdAt: "2026-08-29T08:01:00.000Z",
      assignedAt: "2026-08-29T08:01:00.000Z",
      updatedAt: "2026-08-29T08:01:00.000Z",
    };
    seededState.orders = [assignedOrder, concurrentAssignedOrder, ...(seededState.orders || [])];
    const seeded = await requestOk(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: { state: seededState, expectedRevision: initial.data.revision },
    });
    const storedAssigned = seeded.data.state.orders.find((order) => order.id === orderId);
    assert.equal(storedAssigned?.state, "Assigned");
    assert.equal(storedAssigned?.journal, "JRN-ORPHAN-ASMARA");
    assert.equal(String(storedAssigned?.paidAt || ""), "");
    assert.equal(seeded.data.state.ledger.some((line) => line.orderId === orderId), false);

    const actorView = await requestOk(baseUrl, "/api/app-state", { cookie: payerAccount.signup.cookie });
    const concurrent = await requestOk(baseUrl, "/api/app-state/pay-order", {
      cookie: payerAccount.signup.cookie,
      method: "POST",
      body: {
        orderId: concurrentOrderId,
        actingActorId: payer.id,
        attemptId: "PAY-ASMARA-CONCURRENT",
        expectedRevision: actorView.data.revision,
        expectedOrder: concurrentAssignedOrder,
        expectedOrderUpdatedAt: concurrentAssignedOrder.updatedAt,
        expectedRoutingForwardAttemptId: "",
        paymentProof: null,
      },
    });
    assert.notEqual(concurrent.data.revision, actorView.data.revision);
    assert.equal(concurrent.data.order.state, "Paid");

    const attemptId = "PAY-ASMARA-ORPHAN-ATOMIC";
    const paymentBody = {
      orderId,
      actingActorId: payer.id,
      attemptId,
      expectedRevision: actorView.data.revision,
      expectedOrder: storedAssigned,
      expectedOrderUpdatedAt: storedAssigned.updatedAt,
      expectedRoutingForwardAttemptId: storedAssigned.routingForwardAttemptId || "",
      paymentProof: null,
    };
    const forbidden = await request(baseUrl, "/api/app-state/pay-order", {
      cookie: brokerAccount.signup.cookie,
      method: "POST",
      body: { ...paymentBody, actingActorId: broker.id },
    });
    assert.equal(forbidden.response.status, 403);
    const beforePayment = await requestOk(baseUrl, "/api/app-state", { cookie: payerAccount.signup.cookie });
    const beforePaymentOrder = beforePayment.data.state.orders.find((order) => order.id === orderId);
    assert.equal(beforePaymentOrder?.state, "Assigned");
    assert.equal(beforePaymentOrder?.paymentPostingAttemptId, undefined);

    const saved = await requestOk(baseUrl, "/api/app-state/pay-order", {
      cookie: payerAccount.signup.cookie,
      method: "POST",
      body: paymentBody,
    });
    const savedOrder = saved.data.order;
    const savedLines = saved.data.ledgerLines;
    assert.equal(savedOrder?.state, "Paid");
    assert.notEqual(savedOrder?.journal, "JRN-ORPHAN-ASMARA");
    assert.equal(savedOrder?.paymentPostingAttemptId, attemptId);
    assert.equal(savedLines.length, 4);
    assert.equal(savedLines.every((line) => line.journal === savedOrder.journal), true);
    assert.equal(
      saved.data.state?.orders.find((order) => order.id === concurrentOrderId)?.state,
      "Paid",
      "stale caller receives the unrelated concurrent payment"
    );

    const replay = await requestOk(baseUrl, "/api/app-state/pay-order", {
      cookie: payerAccount.signup.cookie,
      method: "POST",
      body: paymentBody,
    });
    assert.equal(replay.data.alreadyApplied, true);
    assert.equal(replay.data.order.journal, savedOrder.journal);
    assert.equal(replay.data.ledgerLines.length, savedLines.length);

    const reloaded = await requestOk(baseUrl, "/api/app-state", { cookie: payerAccount.signup.cookie });
    const reloadedOrder = reloaded.data.state.orders.find((order) => order.id === orderId);
    const reloadedLines = reloaded.data.state.ledger.filter((line) => line.orderId === orderId && line.source === "ORDER_PAYMENT");
    assert.equal(reloadedOrder?.state, "Paid");
    assert.equal(reloadedOrder?.journal, savedOrder.journal);
    assert.deepEqual(reloadedLines, savedLines);
    assert.deepEqual(reloaded.data.state.archives, actorView.data.state.archives, "closed reports remain unchanged");
    assert.equal(reloadedLines.filter((line) => line.account === `${broker.name} ACTOR_CLEARING`).length, 1);
    assert.equal(reloadedLines.filter((line) => line.account === `${payer.name} ACTOR_CLEARING`).length, 1);
  } finally {
    serverProcess.kill();
    await new Promise((resolve) => serverProcess.once("exit", resolve));
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("payment distinguishes a current order from a different closed order with the same legacy ID", async () => {
  const server = await readFile(path.join(repositoryRoot, "server.mjs"), "utf8");
  const helperSource = server.match(/function orderPaymentHasMatchingClosedSnapshot\([\s\S]*?(?=\nfunction orderPaymentLinesForOrder\()/)?.[0] || "";
  const orderPaymentHasMatchingClosedSnapshot = Function(
    "masterForwardOrdersShareLogicalIdentity",
    `${helperSource}; return orderPaymentHasMatchingClosedSnapshot;`
  )((left, right) => {
    const identities = (order) => new Set([
      order?.id,
      order?.internalOrderId,
      order?.collisionSourceOrderId,
    ].map((value) => String(value || "").trim()).filter(Boolean));
    const leftIds = identities(left);
    const rightIds = identities(right);
    return recoveredOrderMatches(left, right) && [...leftIds].some((value) => rightIds.has(value));
  });
  const current = {
    id: "ORD-SHARED-LEGACY-ID",
    internalOrderId: "ORD-CURRENT-INTERNAL",
    brokerActorId: "ACT-PPP",
    agentActorId: "ACT-ASMARA",
    sourceCurrency: "EUR",
    sourceAmountMinor: 50_000,
    payoutCurrency: "ETB",
    payoutAmountMinor: 98_500,
    receiverName: "Current Receiver",
    accountNumber: "CURRENT-ACCOUNT",
    phoneNumber: "111",
    createdAt: "2026-08-29T08:00:00.000Z",
  };
  const historicalCollision = {
    ...current,
    internalOrderId: "ORD-CLOSED-INTERNAL",
    sourceAmountMinor: 75_000,
    receiverName: "Historical Receiver",
    accountNumber: "CLOSED-ACCOUNT",
    createdAt: "2026-08-01T08:00:00.000Z",
  };
  const archive = { id: "ARC-CLOSED", orders: [historicalCollision] };
  assert.equal(orderPaymentHasMatchingClosedSnapshot({ archives: [archive] }, current), false);
  assert.equal(orderPaymentHasMatchingClosedSnapshot({ archives: [{ ...archive, orders: [{ ...current }] }] }, current), true);
  assert.match(server, /"paymentPostingAttemptId",[\s\S]*function sanitizeActorCreatedPendingOrder/);
  assert.match(server, /nextOrder\.journalCollisionBase = journal\.replace/);
});

test("web and mobile post payment atomically before showing Paid", async () => {
  const [web, preview, mobile, mobileApi, server] = await Promise.all([
    readFile(path.join(repositoryRoot, "index.html"), "utf8"),
    readFile(path.join(repositoryRoot, "preview.html"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/domain/workspace.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/api/client.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "server.mjs"), "utf8"),
  ]);
  assert.equal(web, preview);
  const webPayment = web.match(/async function markOrderPaidFromButton\(payButton\) \{[\s\S]*?(?=\n    function viewFromLocation\()/)?.[0] || "";
  assert.match(webPayment, /saveOrderPaymentNow\(/);
  assert.match(webPayment, /payButton\.disabled = false;[\s\S]*Payment was not saved/);
  assert.match(web, /api\("\/api\/app-state\/pay-order"/);
  assert.doesNotMatch(webPayment, /postOrderPayment\(|finalizeOrderPaid\(|saveStateNow\(/);
  assert.match(web, /processingOrderIds\.size/);
  assert.match(mobile, /return await postOrderPaymentAtomic\(orderId, actorId, proof\)/);
  assert.match(mobileApi, /api<AtomicOrderPaymentResult>\("\/api\/app-state\/pay-order"/);
  assert.match(server, /mutateLatestWorkspaceStateAtLatest[\s\S]*applyAtomicOrderPayment/);
  assert.match(server, /collections = \["orders", "receivables", "ledger", "settlements"\]/);
});
