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

async function waitForServer(baseUrl, process, stderr) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (process.exitCode !== null) throw new Error(`Server stopped during startup.\n${stderr()}`);
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start.\n${stderr()}`);
}

async function jsonRequest(baseUrl, pathname, { cookie = "", method = "GET", body, origin = "" } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      Accept: "application/json",
      "X-HaderaPay-Device-Id": "security-test-device",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(origin ? { Origin: origin } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  const setCookie = response.headers.get("set-cookie") || "";
  return { response, data, cookie: setCookie.split(";", 1)[0] || cookie, setCookie };
}

test("server authorization blocks Inspect-style tampering without breaking an assigned payment", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "haderapay-security-"));
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const ownerPassword = crypto.randomBytes(18).toString("base64url");
  const masterPassword = crypto.randomBytes(12).toString("base64url");
  const brokerPassword = crypto.randomBytes(12).toString("base64url");
  const payerPassword = crypto.randomBytes(12).toString("base64url");
  let stderr = "";
  const serverProcess = spawn(process.execPath, ["server.mjs"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      COOKIE_SECURE: "true",
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

    const blockedOrigin = await jsonRequest(baseUrl, "/api/auth/login", {
      method: "POST",
      origin: "https://attacker.example",
      body: { email: "Owner", password: ownerPassword },
    });
    assert.equal(blockedOrigin.response.status, 403);

    const ownerLogin = await jsonRequest(baseUrl, "/api/auth/login", {
      method: "POST",
      body: { email: "Owner", password: ownerPassword },
    });
    assert.equal(ownerLogin.response.ok, true, ownerLogin.data.error);
    assert.match(ownerLogin.setCookie, /HttpOnly/);
    assert.match(ownerLogin.setCookie, /SameSite=Strict/);
    assert.match(ownerLogin.setCookie, /Secure/);

    const masterCreated = await jsonRequest(baseUrl, "/api/owner/masters", {
      cookie: ownerLogin.cookie,
      method: "POST",
      body: { name: "Security Master", email: "security-master@example.com", password: masterPassword, currency: "USD", plan: "one_month" },
    });
    assert.equal(masterCreated.response.ok, true, masterCreated.data.error);
    const masterLogin = await jsonRequest(baseUrl, "/api/auth/login", {
      method: "POST",
      body: { email: "security-master@example.com", password: masterPassword },
    });
    assert.equal(masterLogin.response.ok, true, masterLogin.data.error);

    const createActor = async (name, email, password, actorRole) => {
      const invite = await jsonRequest(baseUrl, "/api/invites", {
        cookie: masterLogin.cookie,
        method: "POST",
        body: { actorRole, currency: "USD", workingCurrencies: [] },
      });
      assert.equal(invite.response.ok, true, invite.data.error);
      const signup = await jsonRequest(baseUrl, "/api/auth/signup", {
        method: "POST",
        body: { name, email, password, inviteCode: invite.data.invite.code, role: "Actor" },
      });
      assert.equal(signup.response.ok, true, signup.data.error);
      return signup;
    };

    const brokerSignup = await createActor("Security Broker", "security-broker@example.com", brokerPassword, "Broker");
    const payerSignup = await createActor("Security Payer", "security-payer@example.com", payerPassword, "Agent");
    const brokerId = brokerSignup.data.session.membership.actorId;
    const payerId = payerSignup.data.session.membership.actorId;

    const databasePath = path.join(dataDirectory, "auth-db.json");
    const legacyDatabase = JSON.parse(await readFile(databasePath, "utf8"));
    const legacyBroker = legacyDatabase.users.find((user) => user.email === "security-broker@example.com");
    assert.ok(legacyBroker);
    const legacySalt = crypto.randomBytes(16).toString("hex");
    const legacyHash = crypto.pbkdf2Sync(brokerPassword, legacySalt, 120000, 32, "sha256").toString("hex");
    legacyBroker.passwordHash = `${legacySalt}:${legacyHash}`;
    await writeFile(databasePath, JSON.stringify(legacyDatabase, null, 2));
    const legacyLogin = await jsonRequest(baseUrl, "/api/auth/login", {
      method: "POST",
      body: { email: "security-broker@example.com", password: brokerPassword },
    });
    assert.equal(legacyLogin.response.ok, true, legacyLogin.data.error);
    const upgradedDatabase = JSON.parse(await readFile(databasePath, "utf8"));
    assert.match(upgradedDatabase.users.find((user) => user.id === legacyBroker.id).passwordHash, /^pbkdf2-sha256\$600000\$/);

    const masterStateResponse = await jsonRequest(baseUrl, "/api/app-state", { cookie: masterLogin.cookie });
    assert.equal(masterStateResponse.response.ok, true, masterStateResponse.data.error);
    const state = masterStateResponse.data.state;
    const now = new Date().toISOString();
    const masterActor = state.actors.find((actor) => actor.role === "Master");
    state.orders = [
      {
        id: "ORD-1", brokerOrderNumber: "SEC001", brokerActorId: brokerId, broker: "Security Broker",
        agent: "Security Payer", agentActorId: payerId, sourceCurrency: "USD", payoutCurrency: "USD",
        sourceAmountMinor: 10000, payoutAmountMinor: 9000, commissionMinor: 100, grossMinor: 10100,
        moneyUnitVersion: 2, rate: 0.9, commissionPercent: 1, senderName: "Sender", receiverName: "Receiver",
        receiverCity: "City", accountNumber: "123", phoneNumber: "", remarks: "Authorized payment",
        amount: "USD100", fundingType: "cash", state: "Assigned", journal: "", createdAt: now, sentAt: now,
        assignedAt: now, paidAt: "", returnedBy: "", returnedReason: "", updatedAt: now,
      },
      {
        id: "ORD-2", brokerOrderNumber: "PRIVATE001", brokerActorId: masterActor.id, broker: masterActor.name,
        agent: masterActor.name, agentActorId: masterActor.id, sourceCurrency: "USD", payoutCurrency: "USD",
        sourceAmountMinor: 50000, payoutAmountMinor: 50000, commissionMinor: 0, grossMinor: 50000,
        moneyUnitVersion: 2, rate: 1, commissionPercent: 0, senderName: "Private Sender", receiverName: "Private Receiver",
        receiverCity: "Hidden", accountNumber: "SECRET", phoneNumber: "", remarks: "Must remain hidden",
        amount: "USD500", fundingType: "cash", state: "Assigned", journal: "", createdAt: now, sentAt: now,
        assignedAt: now, paidAt: "", returnedBy: "", returnedReason: "", updatedAt: now,
      },
    ];
    state.orderCounter = 2;
    state.chatConversations = [
      { id: "CHAT-1", type: "direct", name: "Security Payer", members: [masterActor.name, "Security Payer"], messages: [], createdAt: now },
      {
        id: "CHAT-2", type: "direct", name: "Security Broker", members: [masterActor.name, "Security Broker"], createdAt: now,
        messages: [{ id: "MSG-SECRET", from: masterActor.name, text: "Broker-only secret", kind: "text", reactions: {}, readBy: [masterActor.name], createdAt: now }],
      },
    ];
    state.chatCounter = 2;
    state.buyingRates = { eurToUsd: 1.1, usdToEtb: 150, usdToErn: 15, usdToSsp: 4000, usdToSdg: 2500, usdToLyd: 6 };
    const seeded = await jsonRequest(baseUrl, "/api/app-state", { cookie: masterLogin.cookie, method: "PUT", body: { state } });
    assert.equal(seeded.response.ok, true, seeded.data.error);

    const payerStateResponse = await jsonRequest(baseUrl, "/api/app-state", { cookie: payerSignup.cookie });
    assert.equal(payerStateResponse.response.ok, true, payerStateResponse.data.error);
    const payerState = payerStateResponse.data.state;
    assert.deepEqual(payerState.orders.map((order) => order.id), ["ORD-1"]);
    assert.equal(JSON.stringify(payerState).includes("Broker-only secret"), false);
    assert.equal(JSON.stringify(payerState).includes("PRIVATE001"), false);
    assert.equal(payerState.masterBankEntries.length, 0);

    const tamperedRates = structuredClone(payerState);
    tamperedRates.buyingRates.usdToEtb = 1;
    const blockedRates = await jsonRequest(baseUrl, "/api/app-state", {
      cookie: payerSignup.cookie,
      method: "PUT",
      body: { state: tamperedRates },
    });
    assert.equal(blockedRates.response.status, 403);

    const tamperedOtherOrder = structuredClone(payerState);
    tamperedOtherOrder.orders.push({ ...state.orders[1], state: "Paid", journal: "JRN-9999", paidAt: new Date(Date.now() + 1000).toISOString(), updatedAt: new Date(Date.now() + 1000).toISOString() });
    const blockedOtherOrder = await jsonRequest(baseUrl, "/api/app-state", {
      cookie: payerSignup.cookie,
      method: "PUT",
      body: { state: tamperedOtherOrder },
    });
    assert.equal(blockedOtherOrder.response.status, 403);

    const paymentState = structuredClone(payerState);
    Object.assign(paymentState.orders[0], {
      state: "Paid",
      journal: "JRN-9999",
      paidAt: new Date(Date.now() + 2000).toISOString(),
      updatedAt: new Date(Date.now() + 2000).toISOString(),
    });
    paymentState.ledger.unshift({
      journal: "JRN-9999", orderId: "ORD-1", source: "ORDER_PAYMENT", account: "Security Payer ACTOR_CLEARING",
      direction: "Credit", currency: "USD", amountMinor: 999999999, postedAt: new Date().toISOString(),
    });
    const paid = await jsonRequest(baseUrl, "/api/app-state", {
      cookie: payerSignup.cookie,
      method: "PUT",
      body: { state: paymentState },
    });
    assert.equal(paid.response.ok, true, paid.data.error);
    assert.equal(paid.data.state.orders[0].state, "Paid");
    assert.match(paid.data.state.orders[0].journal, /^JRN-\d+$/);
    assert.notEqual(paid.data.state.orders[0].journal, "JRN-9999");
    assert.equal(paid.data.state.ledger.some((line) => line.amountMinor === 999999999), false);
    assert.equal(paid.data.state.ledger.some((line) => line.account === "Security Payer ACTOR_CLEARING" && line.amountMinor === 9000), true);

    const masterAfterPayment = await jsonRequest(baseUrl, "/api/app-state", { cookie: masterLogin.cookie });
    assert.equal(masterAfterPayment.data.state.orders.find((order) => order.id === "ORD-1").state, "Paid");
    assert.equal(masterAfterPayment.data.state.orders.find((order) => order.id === "ORD-2").state, "Assigned");
    assert.equal(masterAfterPayment.data.state.ledger.some((line) => line.amountMinor === 999999999), false);

    const brokerStateResponse = await jsonRequest(baseUrl, "/api/app-state", { cookie: brokerSignup.cookie });
    assert.equal(brokerStateResponse.response.ok, true, brokerStateResponse.data.error);
    const brokerState = brokerStateResponse.data.state;
    const orderCreatedAt = new Date(Date.now() + 3000).toISOString();
    brokerState.orders.unshift({
      id: "ORD-3", brokerOrderNumber: "SEC002", brokerActorId: brokerId, broker: "Security Broker",
      agent: "Unassigned", agentActorId: "", sourceCurrency: "USD", payoutCurrency: "USD",
      sourceAmountMinor: 20000, payoutAmountMinor: 19000, commissionMinor: 0, grossMinor: 20000,
      moneyUnitVersion: 2, rate: 0.95, commissionPercent: 0, senderName: "Saved Sender", receiverName: "Saved Receiver",
      receiverCity: "New City", accountNumber: "456", phoneNumber: "", remarks: "Legitimate Actor order",
      amount: "USD200", fundingType: "cash", state: "Pending Forward", journal: "", createdAt: orderCreatedAt,
      sentAt: orderCreatedAt, paidAt: "", returnedBy: "", returnedReason: "", updatedAt: orderCreatedAt,
    });
    brokerState.orderCounter = 3;
    brokerState.savedCustomers.unshift(
      { id: "CUST-2", actorId: brokerId, kind: "receiver", name: "Saved Receiver", receiverCity: "New City", accountNumber: "456", phoneNumber: "", remarks: "Legitimate Actor order", updatedAt: orderCreatedAt },
      { id: "CUST-1", actorId: brokerId, kind: "sender", name: "Saved Sender", receiverCity: "", accountNumber: "", phoneNumber: "", remarks: "", updatedAt: orderCreatedAt },
    );
    brokerState.customerCounter = 2;
    const createdOrder = await jsonRequest(baseUrl, "/api/app-state", {
      cookie: brokerSignup.cookie,
      method: "PUT",
      body: { state: brokerState },
    });
    assert.equal(createdOrder.response.ok, true, createdOrder.data.error);
    assert.equal(createdOrder.data.state.orders.some((order) => order.id === "ORD-3" && order.state === "Pending Forward"), true);
    assert.deepEqual(createdOrder.data.state.savedCustomers.map((customer) => customer.id).sort(), ["CUST-1", "CUST-2"]);

    const transferState = structuredClone(createdOrder.data.state);
    const transferCreatedAt = new Date(Date.now() + 4000).toISOString();
    transferState.transfers.unshift({
      id: "TRF-1", from: "Security Broker", fromActorId: brokerId, to: masterActor.name, toActorId: masterActor.id,
      sourceCurrency: "USD", sourceAmountMinor: 5000, currency: "USD", amountMinor: 5000, rate: 1,
      commissionPercent: 1, commissionMinor: 50, commissionLiability: "Sender", remarks: "Legitimate transfer",
      state: "Pending Approval", initiatedBy: "Security Broker", createdAt: transferCreatedAt, sentAt: transferCreatedAt,
    });
    transferState.transferCounter = 1;
    const createdTransfer = await jsonRequest(baseUrl, "/api/app-state", {
      cookie: brokerSignup.cookie,
      method: "PUT",
      body: { state: transferState },
    });
    if (!createdTransfer.response.ok) {
      const diagnosticEvents = await jsonRequest(baseUrl, "/api/owner/security-events?limit=5", { cookie: ownerLogin.cookie });
      assert.fail(`${createdTransfer.data.error}\n${JSON.stringify(diagnosticEvents.data.events, null, 2)}`);
    }
    assert.equal(createdTransfer.data.state.transfers.some((transfer) => transfer.id === "TRF-1" && transfer.state === "Pending Approval"), true);

    const masterForForward = await jsonRequest(baseUrl, "/api/app-state", { cookie: masterLogin.cookie });
    const forwardedTransfer = masterForForward.data.state.transfers.find((transfer) => transfer.id === "TRF-1");
    assert.ok(forwardedTransfer);
    Object.assign(forwardedTransfer, {
      requestedTo: forwardedTransfer.to,
      requestedToActorId: forwardedTransfer.toActorId,
      requestedCurrency: forwardedTransfer.currency,
      requestedAmountMinor: forwardedTransfer.amountMinor,
      requestedRate: forwardedTransfer.rate,
      requestedCommissionPercent: forwardedTransfer.commissionPercent,
      requestedCommissionMinor: forwardedTransfer.commissionMinor,
      requestedCommissionLiability: forwardedTransfer.commissionLiability,
      to: "Security Payer",
      toActorId: payerId,
      state: "Pending Acceptance",
      forwardedBy: masterActor.name,
      forwardedAt: new Date(Date.now() + 5000).toISOString(),
      updatedAt: new Date(Date.now() + 5000).toISOString(),
    });
    const forwarded = await jsonRequest(baseUrl, "/api/app-state", {
      cookie: masterLogin.cookie,
      method: "PUT",
      body: { state: masterForForward.data.state },
    });
    assert.equal(forwarded.response.ok, true, forwarded.data.error);

    const payerForAcceptance = await jsonRequest(baseUrl, "/api/app-state", { cookie: payerSignup.cookie });
    const acceptanceState = payerForAcceptance.data.state;
    const acceptanceTransfer = acceptanceState.transfers.find((transfer) => transfer.id === "TRF-1");
    assert.ok(acceptanceTransfer);
    Object.assign(acceptanceTransfer, {
      state: "Approved",
      journal: "JRN-9998",
      acceptedBy: "Security Payer",
      acceptedAt: new Date(Date.now() + 6000).toISOString(),
      approvedAt: new Date(Date.now() + 6000).toISOString(),
      updatedAt: new Date(Date.now() + 6000).toISOString(),
    });
    acceptanceState.ledger.unshift({
      journal: "JRN-9998", transferId: "TRF-1", source: "TRANSFER", account: "Security Payer",
      direction: "Debit", currency: "USD", amountMinor: 888888888, postedAt: new Date().toISOString(),
    });
    const payerChat = acceptanceState.chatConversations.find((chat) => chat.members.includes("Security Payer"));
    assert.ok(payerChat);
    payerChat.messages.push({
      id: "MSG-CLIENT-1", from: "Security Payer", text: "Authorized chat message", kind: "text",
      replyTo: "", reactions: {}, readBy: ["Security Payer"], createdAt: new Date(Date.now() + 6000).toISOString(),
    });
    const accepted = await jsonRequest(baseUrl, "/api/app-state", {
      cookie: payerSignup.cookie,
      method: "PUT",
      body: { state: acceptanceState },
    });
    assert.equal(accepted.response.ok, true, accepted.data.error);
    assert.equal(accepted.data.state.transfers.find((transfer) => transfer.id === "TRF-1").state, "Approved");
    assert.equal(accepted.data.state.ledger.some((line) => line.amountMinor === 888888888), false);
    assert.equal(accepted.data.state.ledger.some((line) => line.transferId === "TRF-1" && line.account === "Security Payer" && line.amountMinor === 5000), true);
    assert.equal(accepted.data.state.chatConversations.some((chat) => chat.messages.some((message) => message.text === "Authorized chat message")), true);

    const securityEvents = await jsonRequest(baseUrl, "/api/owner/security-events?limit=20", { cookie: ownerLogin.cookie });
    assert.equal(securityEvents.response.ok, true, securityEvents.data.error);
    assert.equal(securityEvents.data.events.filter((event) => event.outcome === "blocked").length >= 2, true);
    assert.equal(securityEvents.data.events.some((event) => event.outcome === "allowed" && event.action.includes("paid order ORD-1")), true);

    const sourceRequest = await fetch(`${baseUrl}/server.mjs`);
    assert.equal(sourceRequest.status, 404);
    assert.equal(sourceRequest.headers.get("x-content-type-options"), "nosniff");
    const pageRequest = await fetch(`${baseUrl}/preview.html`);
    assert.equal(pageRequest.status, 200);
    assert.match(pageRequest.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);
  } finally {
    if (serverProcess.exitCode === null) {
      serverProcess.kill();
      await new Promise((resolve) => serverProcess.once("exit", resolve));
    }
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
