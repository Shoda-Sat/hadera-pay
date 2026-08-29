import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

function paymentLines(order, broker, payer) {
  const shared = {
    journal: order.journal,
    orderId: order.id,
    source: "ORDER_PAYMENT",
    postedAt: order.paidAt,
  };
  return [
    { ...shared, actorId: broker.id, participantRole: "broker", account: `${broker.name} ACTOR_CLEARING`, direction: "Debit", currency: "EUR", amountMinor: 50_000 },
    { ...shared, account: "MASTER_FX_CLEARING", direction: "Credit", currency: "EUR", amountMinor: 50_000 },
    { ...shared, account: "MASTER_FX_CLEARING", direction: "Debit", currency: "ETB", amountMinor: 98_500 },
    { ...shared, actorId: payer.id, participantRole: "agent", account: `${payer.name} ACTOR_CLEARING`, direction: "Credit", currency: "ETB", amountMinor: 98_500 },
  ];
}

test("Assigned orders with an orphan journal can save one complete payment that survives reload", async () => {
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
    const createdAt = "2026-08-29T08:00:00.000Z";
    const seededState = structuredClone(initial.data.state);
    seededState.orders = [{
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
    }, ...(seededState.orders || [])];
    const seeded = await requestOk(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: { state: seededState, expectedRevision: initial.data.revision },
    });
    const storedAssigned = seeded.data.state.orders.find((order) => order.id === orderId);
    assert.equal(storedAssigned?.state, "Assigned");
    assert.equal(storedAssigned?.journal, "JRN-ORPHAN-ASMARA");
    assert.equal(seeded.data.state.ledger.some((line) => line.orderId === orderId), false);

    const actorView = await requestOk(baseUrl, "/api/app-state", { cookie: payerAccount.signup.cookie });
    const paymentState = structuredClone(actorView.data.state);
    const paidOrder = paymentState.orders.find((order) => order.id === orderId);
    const paidAt = "2099-01-01T00:00:00.000Z";
    Object.assign(paidOrder, {
      state: "Paid",
      journal: "JRN-ASMARA-PAYMENT",
      paidAt,
      updatedAt: paidAt,
    });
    paymentState.ledger = [...paymentLines(paidOrder, broker, payer), ...(paymentState.ledger || [])];

    const saved = await requestOk(baseUrl, "/api/app-state", {
      cookie: payerAccount.signup.cookie,
      method: "PUT",
      body: { state: paymentState, expectedRevision: actorView.data.revision },
    });
    const savedOrder = saved.data.state.orders.find((order) => order.id === orderId);
    const savedLines = saved.data.state.ledger.filter((line) => line.orderId === orderId && line.source === "ORDER_PAYMENT");
    assert.equal(savedOrder?.state, "Paid");
    assert.equal(savedOrder?.journal, "JRN-ASMARA-PAYMENT");
    assert.equal(savedLines.length, 4);
    assert.equal(savedLines.every((line) => line.journal === savedOrder.journal), true);

    const reloaded = await requestOk(baseUrl, "/api/app-state", { cookie: payerAccount.signup.cookie });
    const reloadedOrder = reloaded.data.state.orders.find((order) => order.id === orderId);
    const reloadedLines = reloaded.data.state.ledger.filter((line) => line.orderId === orderId && line.source === "ORDER_PAYMENT");
    assert.equal(reloadedOrder?.state, "Paid");
    assert.equal(reloadedOrder?.journal, savedOrder.journal);
    assert.deepEqual(reloadedLines, savedLines);
  } finally {
    serverProcess.kill();
    await new Promise((resolve) => serverProcess.once("exit", resolve));
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("web and mobile replace an orphan Assigned journal and wait for acknowledgement", async () => {
  const [web, preview, mobile] = await Promise.all([
    readFile(path.join(repositoryRoot, "index.html"), "utf8"),
    readFile(path.join(repositoryRoot, "preview.html"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/domain/workspace.ts"), "utf8"),
  ]);
  assert.equal(web, preview);
  assert.doesNotMatch(web, /if \(order\.journal \|\| order\.state === "Paid"\) return false/);
  assert.doesNotMatch(web, /const posted = order\.journal \? true : postOrderPayment\(order\)/);
  assert.match(web, /const saved = await saveStateNow\(\)/);
  assert.match(web, /paymentSaveIsAcknowledged\(order\.id, order\.journal, saved\?\.state\)/);
  assert.match(web, /processingOrderIds\.size/);
  assert.doesNotMatch(mobile, /order\.state !== "Assigned" \|\| order\.journal/);
});
