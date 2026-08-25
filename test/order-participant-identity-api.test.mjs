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
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(baseUrl, processHandle, stderr) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (processHandle.exitCode !== null) throw new Error(`Test server stopped.\n${stderr()}`);
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Test server did not start.\n${stderr()}`);
}

async function request(baseUrl, pathname, { cookie = "", method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  return {
    ok: response.ok,
    status: response.status,
    data,
    cookie: (response.headers.get("set-cookie") || "").split(";", 1)[0] || cookie,
  };
}

async function requestOk(baseUrl, pathname, options = {}) {
  const response = await request(baseUrl, pathname, options);
  assert.equal(response.ok, true, response.data.error || `${options.method || "GET"} ${pathname} failed`);
  return response;
}

async function createActorInvite(baseUrl, masterCookie, role) {
  return requestOk(baseUrl, "/api/invites", {
    cookie: masterCookie,
    method: "POST",
    body: { actorRole: role, currency: role === "Agent" ? "ETB" : "USD", workingCurrencies: [] },
  });
}

async function createActor(baseUrl, masterCookie, { role, name, email, password }) {
  const invite = await createActorInvite(baseUrl, masterCookie, role);
  return requestOk(baseUrl, "/api/auth/signup", {
    method: "POST",
    body: { name, email, password, inviteCode: invite.data.invite.code, role: "Actor" },
  });
}

function orderFixture({ id, broker, agent, agentActorId }) {
  const createdAt = new Date().toISOString();
  return {
    id,
    internalOrderId: id,
    brokerActorId: broker.id,
    broker: broker.name,
    brokerOrderNumber: "CLIENT001",
    agentActorId,
    agent: agent.name,
    sourceCurrency: "USD",
    sourceAmountMinor: 1_000,
    payoutCurrency: "ETB",
    payoutAmountMinor: 20_000,
    commissionPercent: 0,
    commissionMinor: 0,
    grossMinor: 1_000,
    rate: 20,
    state: "Assigned",
    createdAt,
    assignedAt: createdAt,
    updatedAt: createdAt,
  };
}

function orderPaymentLines(order, broker, agent, { spoofIdentity = false, wrongActorAccount = "" } = {}) {
  const shared = {
    journal: order.journal,
    orderId: order.id,
    source: "ORDER_PAYMENT",
    postedAt: order.paidAt,
  };
  return [
    {
      ...shared,
      actorId: spoofIdentity ? "ACT-SPOOF" : broker.id,
      participantRole: spoofIdentity ? "agent" : "broker",
      account: wrongActorAccount || `${broker.name} ACTOR_CLEARING`,
      direction: "Debit",
      currency: order.sourceCurrency,
      amountMinor: order.sourceAmountMinor,
    },
    {
      ...shared,
      account: "MASTER_FX_CLEARING",
      direction: "Credit",
      currency: order.sourceCurrency,
      amountMinor: order.sourceAmountMinor,
    },
    {
      ...shared,
      account: "MASTER_FX_CLEARING",
      direction: "Debit",
      currency: order.payoutCurrency,
      amountMinor: order.payoutAmountMinor,
    },
    {
      ...shared,
      actorId: spoofIdentity ? "ACT-SPOOF" : agent.id,
      participantRole: spoofIdentity ? "broker" : "agent",
      account: `${agent.name} ACTOR_CLEARING`,
      direction: "Credit",
      currency: order.payoutCurrency,
      amountMinor: order.payoutAmountMinor,
    },
  ];
}

function brokerCommissionPaymentLines(order, broker, agent) {
  const [brokerPrincipal, masterPrincipal, masterPayout, agentPayout] = orderPaymentLines(order, broker, agent);
  const commissionMinor = Math.abs(Number(order.commissionMinor || 0));
  const masterPaysCommission = Number(order.commissionMinor || 0) < 0 || Number(order.commissionPercent || 0) < 0;
  return [
    brokerPrincipal,
    {
      ...brokerPrincipal,
      direction: masterPaysCommission ? "Credit" : "Debit",
      amountMinor: commissionMinor,
    },
    masterPrincipal,
    {
      journal: order.journal,
      orderId: order.id,
      source: "ORDER_PAYMENT",
      account: masterPaysCommission ? "MASTER_COMMISSION_EXPENSE" : "MASTER_FEE_REVENUE",
      direction: masterPaysCommission ? "Debit" : "Credit",
      currency: order.sourceCurrency,
      amountMinor: commissionMinor,
      postedAt: order.paidAt,
    },
    masterPayout,
    agentPayout,
  ];
}

function orderAccountingProjection(order) {
  const fields = [
    "id",
    "internalOrderId",
    "brokerActorId",
    "broker",
    "brokerOrderNumber",
    "brokerOrderNumberCycle",
    "agentActorId",
    "agent",
    "sourceCurrency",
    "sourceAmountMinor",
    "payoutCurrency",
    "payoutAmountMinor",
    "commissionPercent",
    "commissionMinor",
    "grossMinor",
    "rate",
    "journal",
    "paidAt",
    "incomeBaseCurrency",
    "incomeBaseAmountMinor",
    "incomeCollectedCurrency",
    "incomeCollectedOriginalMinor",
    "incomeCollectedEurMinor",
    "incomeCollectedUsdMinor",
    "incomeProfitMinor",
    "incomeSnapshotAt",
    "incomeMasterRateSnapshot",
    "incomeUsdAgentRateSnapshot",
  ];
  return Object.fromEntries(fields.map((field) => [field, structuredClone(order?.[field]) ]));
}

function accountingStateProjection(state) {
  return {
    ledger: structuredClone(state.ledger || []),
    settlements: structuredClone(state.settlements || []),
    masterBankEntries: structuredClone(state.masterBankEntries || []),
  };
}

test("web and Android stamp future payment rows with the Broker or Agent identity", async () => {
  const [web, preview, mobile] = await Promise.all([
    readFile(path.join(repositoryRoot, "index.html"), "utf8"),
    readFile(path.join(repositoryRoot, "preview.html"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/domain/workspace.ts"), "utf8"),
  ]);
  assert.equal(web, preview);
  for (const source of [web, mobile]) {
    assert.match(source, /actorId: order\.brokerActorId \|\| "", participantRole: "broker"/);
    assert.match(source, /actorId: order\.agentActorId \|\| "", participantRole: "agent"/);
  }
});

test("a payment row with a nonempty unmatched orderId never falls back to a shared journal", async () => {
  const server = await readFile(path.join(repositoryRoot, "server.mjs"), "utf8");
  const resolver = server.match(/function orderForPaymentLedgerLine\(line, orders\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(resolver, /if \(orderId\) \{[\s\S]*?if \(byId\.length === 1\) return byId\[0\];[\s\S]*?return null;[\s\S]*?\}/);
  assert.match(resolver, /const journal = [\s\S]*?return byJournal\.length === 1 \? byJournal\[0\] : null;/);
});

test("payment ledger merge identity includes orderId and paymentComponent", async () => {
  const server = await readFile(path.join(repositoryRoot, "server.mjs"), "utf8");
  const keyFunction = server.match(/function workspaceLedgerLineKey\(line = \{\}\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(keyFunction, /line\.orderId/);
  assert.match(keyFunction, /line\.paymentComponent/);
});

test("server freezes future order participants and stamps payment lines with canonical Actor identity", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "haderapay-order-identity-"));
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const ownerPassword = crypto.randomBytes(18).toString("base64url");
  const masterPassword = crypto.randomBytes(14).toString("base64url");
  let stderr = "";
  const processHandle = spawn(process.execPath, ["server.mjs"], {
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
  processHandle.stderr.setEncoding("utf8");
  processHandle.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    await waitForServer(baseUrl, processHandle, () => stderr);
    const owner = await requestOk(baseUrl, "/api/auth/login", {
      method: "POST",
      body: { email: "Owner", password: ownerPassword },
    });
    await requestOk(baseUrl, "/api/owner/masters", {
      cookie: owner.cookie,
      method: "POST",
      body: {
        name: "Identity Test Master",
        email: "identity-master@example.com",
        password: masterPassword,
        currency: "USD",
        plan: "one_month",
      },
    });
    const master = await requestOk(baseUrl, "/api/auth/login", {
      method: "POST",
      body: { email: "identity-master@example.com", password: masterPassword },
    });
    const brokerSignup = await createActor(baseUrl, master.cookie, {
      role: "Broker",
      name: "Identity Broker",
      email: "identity-broker@example.com",
      password: crypto.randomBytes(12).toString("base64url"),
    });
    const otherBrokerSignup = await createActor(baseUrl, master.cookie, {
      role: "Broker",
      name: "Other Broker",
      email: "other-identity-broker@example.com",
      password: crypto.randomBytes(12).toString("base64url"),
    });
    const agentSignup = await createActor(baseUrl, master.cookie, {
      role: "Agent",
      name: "Identity Agent",
      email: "identity-agent@example.com",
      password: crypto.randomBytes(12).toString("base64url"),
    });
    const otherAgentSignup = await createActor(baseUrl, master.cookie, {
      role: "Agent",
      name: "Other Agent",
      email: "other-identity-agent@example.com",
      password: crypto.randomBytes(12).toString("base64url"),
    });

    const initial = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    const broker = initial.data.state.actors.find((actor) => actor.id === brokerSignup.data.session.membership.actorId);
    const otherBroker = initial.data.state.actors.find((actor) => actor.id === otherBrokerSignup.data.session.membership.actorId);
    const agent = initial.data.state.actors.find((actor) => actor.id === agentSignup.data.session.membership.actorId);
    const otherAgent = initial.data.state.actors.find((actor) => actor.id === otherAgentSignup.data.session.membership.actorId);
    assert.ok(broker && otherBroker && agent && otherAgent);

    const duplicateSignupInvite = await createActorInvite(baseUrl, master.cookie, "Agent");
    const duplicateSignup = await request(baseUrl, "/api/auth/signup", {
      method: "POST",
      body: {
        name: `  ${agent.name.toLocaleUpperCase()}  `,
        email: "duplicate-identity-agent@example.com",
        password: crypto.randomBytes(12).toString("base64url"),
        inviteCode: duplicateSignupInvite.data.invite.code,
        role: "Actor",
      },
    });
    assert.equal(duplicateSignup.status, 409);
    assert.match(duplicateSignup.data.error, /name has already been used/i);

    const managedActorState = structuredClone(initial.data.state);
    managedActorState.actors.push({
      id: "ACT-MANAGED-IDENTITY",
      name: "Managed Identity Reserve",
      role: "Agent",
      currency: "ETB",
      workingCurrencies: [],
      active: true,
      transferEnabled: true,
      transferMode: "master",
    });
    const managedActorSaved = await requestOk(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: { state: managedActorState, expectedRevision: initial.data.revision },
    });
    const managedActor = managedActorSaved.data.state.actors.find((actor) => actor.id === "ACT-MANAGED-IDENTITY");
    assert.equal(managedActor?.managedByMaster, true);

    const duplicateManagedState = structuredClone(managedActorSaved.data.state);
    duplicateManagedState.actors.push({
      ...managedActor,
      id: "ACT-MANAGED-IDENTITY-DUPLICATE",
      name: ` ${managedActor.name.toLocaleUpperCase()} `,
    });
    const duplicateManaged = await request(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: { state: duplicateManagedState, expectedRevision: managedActorSaved.data.revision },
    });
    assert.equal(duplicateManaged.status, 409);
    assert.match(duplicateManaged.data.error, /name has already been used|names must be unique/i);

    const reusedManagedNameInvite = await createActorInvite(baseUrl, master.cookie, "Agent");
    const reusedManagedNameSignup = await request(baseUrl, "/api/auth/signup", {
      method: "POST",
      body: {
        name: managedActor.name,
        email: "reused-managed-name@example.com",
        password: crypto.randomBytes(12).toString("base64url"),
        inviteCode: reusedManagedNameInvite.data.invite.code,
        role: "Actor",
      },
    });
    assert.equal(reusedManagedNameSignup.status, 409);
    assert.match(reusedManagedNameSignup.data.error, /name has already been used/i);

    const identityBaseline = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    assert.equal(identityBaseline.data.revision, managedActorSaved.data.revision, "Rejected Actor-name reuse is atomic.");

    const assignedState = structuredClone(identityBaseline.data.state);
    assignedState.orders = [
      orderFixture({ id: "ORD-IDENTITY-1", broker, agent, agentActorId: agent.id }),
      ...(assignedState.orders || []),
    ];
    const assigned = await requestOk(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: { state: assignedState, expectedRevision: identityBaseline.data.revision },
    });
    const storedAssigned = assigned.data.state.orders.find((order) => order.id === "ORD-IDENTITY-1");
    assert.equal(storedAssigned.agentActorId, agent.id);
    assert.equal(storedAssigned.agent, agent.name);

    const contradictoryState = structuredClone(assigned.data.state);
    const contradictoryOrder = contradictoryState.orders.find((order) => order.id === "ORD-IDENTITY-1");
    contradictoryOrder.agentActorId = agent.id;
    contradictoryOrder.agent = otherAgent.name;
    const contradictory = await request(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: { state: contradictoryState, expectedRevision: assigned.data.revision },
    });
    assert.equal(contradictory.status, 409);
    assert.match(contradictory.data.error, /identity conflicts/i);

    const afterContradiction = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    assert.equal(afterContradiction.data.revision, assigned.data.revision, "The rejected mismatch is atomic.");
    assert.equal(afterContradiction.data.state.orders.find((order) => order.id === "ORD-IDENTITY-1").agent, agent.name);

    const unknownIdentityState = structuredClone(afterContradiction.data.state);
    unknownIdentityState.orders.unshift(orderFixture({
      id: "ORD-IDENTITY-UNKNOWN",
      broker,
      agent,
      agentActorId: "ACT-UNKNOWN",
    }));
    const unknownIdentity = await request(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: { state: unknownIdentityState, expectedRevision: afterContradiction.data.revision },
    });
    assert.equal(unknownIdentity.status, 409);
    assert.match(unknownIdentity.data.error, /no longer available/i);

    const unknownBlankAgentState = structuredClone(afterContradiction.data.state);
    unknownBlankAgentState.orders.unshift(orderFixture({
      id: "ORD-IDENTITY-UNKNOWN-NAME",
      broker,
      agent: { ...agent, name: "Missing Agent" },
      agentActorId: "",
    }));
    const unknownBlankAgent = await request(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: { state: unknownBlankAgentState, expectedRevision: afterContradiction.data.revision },
    });
    assert.equal(unknownBlankAgent.status, 409);
    assert.match(unknownBlankAgent.data.error, /Actor is no longer available/i);

    const unknownBrokerState = structuredClone(afterContradiction.data.state);
    unknownBrokerState.orders.unshift({
      ...orderFixture({ id: "ORD-BROKER-UNKNOWN", broker, agent, agentActorId: agent.id }),
      brokerActorId: "ACT-UNKNOWN-BROKER",
    });
    const unknownBrokerIdentity = await request(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: { state: unknownBrokerState, expectedRevision: afterContradiction.data.revision },
    });
    assert.equal(unknownBrokerIdentity.status, 409);
    assert.match(unknownBrokerIdentity.data.error, /Broker is no longer available/i);

    const contradictoryBrokerState = structuredClone(afterContradiction.data.state);
    contradictoryBrokerState.orders.unshift({
      ...orderFixture({ id: "ORD-BROKER-CONTRADICTORY", broker, agent, agentActorId: agent.id }),
      broker: otherBroker.name,
    });
    const contradictoryBrokerIdentity = await request(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: { state: contradictoryBrokerState, expectedRevision: afterContradiction.data.revision },
    });
    assert.equal(contradictoryBrokerIdentity.status, 409);
    assert.match(contradictoryBrokerIdentity.data.error, /Broker identity conflicts/i);

    const brokerAsPayerState = structuredClone(afterContradiction.data.state);
    brokerAsPayerState.orders.unshift(orderFixture({
      id: "ORD-PLAIN-BROKER-AS-PAYER",
      broker,
      agent: otherBroker,
      agentActorId: otherBroker.id,
    }));
    const brokerAsPayer = await request(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: { state: brokerAsPayerState, expectedRevision: afterContradiction.data.revision },
    });
    assert.equal(brokerAsPayer.status, 409);
    assert.match(brokerAsPayer.data.error, /Actor is no longer available|assigned payer/i);

    const afterIdentityRejections = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    assert.equal(afterIdentityRejections.data.revision, afterContradiction.data.revision, "Rejected Agent and Broker identities are atomic.");

    const blankIdentityState = structuredClone(afterIdentityRejections.data.state);
    blankIdentityState.orders.unshift(orderFixture({
      id: "ORD-IDENTITY-BLANK",
      broker,
      agent,
      agentActorId: "",
    }));
    Object.assign(blankIdentityState.orders[0], {
      sourceAmountMinor: 1_500,
      payoutAmountMinor: 30_000,
      grossMinor: 1_500,
    });
    const blankIdentity = await requestOk(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: { state: blankIdentityState, expectedRevision: afterIdentityRejections.data.revision },
    });
    assert.equal(blankIdentity.data.state.orders.find((order) => order.id === "ORD-IDENTITY-BLANK").agentActorId, agent.id);

    const forgedForwardView = await requestOk(baseUrl, "/api/app-state", { cookie: brokerSignup.cookie });
    const forgedForwardState = structuredClone(forgedForwardView.data.state);
    const forgedForwardOrder = {
      ...orderFixture({ id: "ORD-FORGED-FORWARD", broker, agent, agentActorId: agent.id }),
      state: "Pending Forward",
      journal: "JRN-FORGED-FORWARD",
      paidAt: new Date(Date.now() + 500).toISOString(),
      voidRequested: true,
      voidRequestedAt: new Date(Date.now() + 600).toISOString(),
      voidJournal: "JRN-FORGED-VOID",
      voidedAt: new Date(Date.now() + 700).toISOString(),
      cancelledAt: new Date(Date.now() + 800).toISOString(),
      excludedFromCalculations: true,
      journalCollisionBase: "JRN-FORGED-FORWARD",
      paymentProof: { name: "forged-proof.jpg", type: "image/jpeg" },
    };
    forgedForwardState.orders.unshift(forgedForwardOrder);
    const forgedForwardSaved = await requestOk(baseUrl, "/api/app-state", {
      cookie: brokerSignup.cookie,
      method: "PUT",
      body: { state: forgedForwardState, expectedRevision: forgedForwardView.data.revision },
    });
    const sanitizedForwardOrder = forgedForwardSaved.data.state.orders.find((order) => order.id === forgedForwardOrder.id);
    assert.equal(sanitizedForwardOrder.state, "Pending Forward");
    assert.equal(sanitizedForwardOrder.agent, "Unassigned");
    assert.equal(sanitizedForwardOrder.agentActorId || "", "");
    for (const field of [
      "journal",
      "paidAt",
      "voidRequestedAt",
      "voidJournal",
      "voidedAt",
      "cancelledAt",
      "journalCollisionBase",
      "paymentProof",
    ]) {
      assert.equal(sanitizedForwardOrder[field], undefined, `Broker-controlled ${field} must be stripped from a new forward.`);
    }
    assert.notEqual(sanitizedForwardOrder.voidRequested, true);
    assert.notEqual(sanitizedForwardOrder.excludedFromCalculations, true);

    const securityBaseline = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    const assignedAccounting = accountingStateProjection(securityBaseline.data.state);
    const unauthorizedPaidView = await requestOk(baseUrl, "/api/app-state", { cookie: otherAgentSignup.cookie });
    const unauthorizedPaidState = structuredClone(unauthorizedPaidView.data.state);
    assert.equal(
      unauthorizedPaidState.orders.some((order) => order.id === "ORD-IDENTITY-1"),
      false,
      "An unrelated Actor must not download the assigned order.",
    );
    const unauthorizedPaidOrder = structuredClone(
      securityBaseline.data.state.orders.find((order) => order.id === "ORD-IDENTITY-1"),
    );
    const unauthorizedPaidAt = new Date(Date.now() + 1_000).toISOString();
    Object.assign(unauthorizedPaidOrder, {
      state: "Paid",
      journal: "JRN-UNAUTHORIZED-PAID",
      paidAt: unauthorizedPaidAt,
      updatedAt: unauthorizedPaidAt,
    });
    unauthorizedPaidState.orders.unshift(unauthorizedPaidOrder);
    unauthorizedPaidState.ledger = [
      ...orderPaymentLines(unauthorizedPaidOrder, broker, agent),
      ...(unauthorizedPaidState.ledger || []),
    ];
    const unauthorizedPaid = await request(baseUrl, "/api/app-state", {
      cookie: otherAgentSignup.cookie,
      method: "PUT",
      body: { state: unauthorizedPaidState, expectedRevision: unauthorizedPaidView.data.revision },
    });
    assert.equal(unauthorizedPaid.status, 403);
    assert.match(unauthorizedPaid.data.error, /assigned payer/i);

    const afterUnauthorizedPaid = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    assert.equal(afterUnauthorizedPaid.data.revision, securityBaseline.data.revision);
    assert.equal(afterUnauthorizedPaid.data.state.orders.find((order) => order.id === "ORD-IDENTITY-1").state, "Assigned");
    assert.deepEqual(accountingStateProjection(afterUnauthorizedPaid.data.state), assignedAccounting);

    const unauthorizedVoidView = await requestOk(baseUrl, "/api/app-state", { cookie: otherAgentSignup.cookie });
    const unauthorizedVoidState = structuredClone(unauthorizedVoidView.data.state);
    const unauthorizedVoidOrder = structuredClone(
      securityBaseline.data.state.orders.find((order) => order.id === "ORD-IDENTITY-1"),
    );
    Object.assign(unauthorizedVoidOrder, {
      state: "Voided",
      paidAt: new Date(Date.now() + 2_000).toISOString(),
      voidJournal: "JRN-UNAUTHORIZED-VOID",
      voidedAt: new Date(Date.now() + 3_000).toISOString(),
      excludedFromCalculations: true,
    });
    unauthorizedVoidState.orders.unshift(unauthorizedVoidOrder);
    unauthorizedVoidState.ledger = [];
    const unauthorizedVoid = await request(baseUrl, "/api/app-state", {
      cookie: otherAgentSignup.cookie,
      method: "PUT",
      body: { state: unauthorizedVoidState, expectedRevision: unauthorizedVoidView.data.revision },
    });
    assert.equal(unauthorizedVoid.status, 403);
    assert.match(unauthorizedVoid.data.error, /assigned payer/i);

    const afterUnauthorizedVoid = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    assert.equal(afterUnauthorizedVoid.data.revision, securityBaseline.data.revision);
    assert.equal(afterUnauthorizedVoid.data.state.orders.find((order) => order.id === "ORD-IDENTITY-1").state, "Assigned");
    assert.deepEqual(accountingStateProjection(afterUnauthorizedVoid.data.state), assignedAccounting);

    const partialPaymentView = await requestOk(baseUrl, "/api/app-state", { cookie: agentSignup.cookie });
    const partialPaidOrder = structuredClone(partialPaymentView.data.state.orders.find((order) => order.id === "ORD-IDENTITY-1"));
    const partialPaidAt = new Date(Date.now() + 3_500).toISOString();
    Object.assign(partialPaidOrder, {
      state: "Paid",
      journal: "JRN-PARTIAL-NO-LEDGER",
      paidAt: partialPaidAt,
      updatedAt: partialPaidAt,
    });
    const partialPayment = await request(baseUrl, "/api/app-state", {
      cookie: agentSignup.cookie,
      method: "PUT",
      body: {
        state: { orders: [partialPaidOrder] },
        expectedRevision: partialPaymentView.data.revision,
      },
    });
    assert.equal(partialPayment.status, 409);
    assert.match(partialPayment.data.error, /incomplete or unbalanced|payment.*ledger/i);

    const afterPartialPayment = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    assert.equal(afterPartialPayment.data.revision, securityBaseline.data.revision);
    assert.equal(afterPartialPayment.data.state.orders.find((order) => order.id === "ORD-IDENTITY-1").state, "Assigned");
    assert.deepEqual(accountingStateProjection(afterPartialPayment.data.state), assignedAccounting);

    const extraRowsView = await requestOk(baseUrl, "/api/app-state", { cookie: agentSignup.cookie });
    const extraRowsState = structuredClone(extraRowsView.data.state);
    const extraRowsOrder = extraRowsState.orders.find((order) => order.id === "ORD-IDENTITY-1");
    const extraRowsPaidAt = new Date(Date.now() + 3_750).toISOString();
    Object.assign(extraRowsOrder, {
      state: "Paid",
      journal: "JRN-EXTRA-BALANCED-ROWS",
      paidAt: extraRowsPaidAt,
      updatedAt: extraRowsPaidAt,
    });
    extraRowsState.ledger = [
      ...orderPaymentLines(extraRowsOrder, broker, agent),
      {
        journal: extraRowsOrder.journal,
        orderId: extraRowsOrder.id,
        source: "ORDER_PAYMENT",
        account: "MASTER_FX_CLEARING",
        direction: "Debit",
        currency: "USD",
        amountMinor: 333,
        postedAt: extraRowsPaidAt,
      },
      {
        journal: extraRowsOrder.journal,
        orderId: extraRowsOrder.id,
        source: "ORDER_PAYMENT",
        account: "MASTER_FX_CLEARING",
        direction: "Credit",
        currency: "USD",
        amountMinor: 333,
        postedAt: extraRowsPaidAt,
      },
      ...(extraRowsState.ledger || []),
    ];
    const extraRowsPayment = await request(baseUrl, "/api/app-state", {
      cookie: agentSignup.cookie,
      method: "PUT",
      body: { state: extraRowsState, expectedRevision: extraRowsView.data.revision },
    });
    assert.equal(extraRowsPayment.status, 409);
    assert.match(extraRowsPayment.data.error, /incomplete or unbalanced|exact|unexpected|canonical/i);

    const afterExtraRows = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    assert.equal(afterExtraRows.data.revision, securityBaseline.data.revision);
    assert.deepEqual(accountingStateProjection(afterExtraRows.data.state), assignedAccounting);

    const wrongClearingView = await requestOk(baseUrl, "/api/app-state", { cookie: agentSignup.cookie });
    const wrongClearingState = structuredClone(wrongClearingView.data.state);
    const wrongClearingOrder = wrongClearingState.orders.find((order) => order.id === "ORD-IDENTITY-1");
    const wrongClearingPaidAt = new Date(Date.now() + 4_000).toISOString();
    Object.assign(wrongClearingOrder, {
      state: "Paid",
      journal: "JRN-WRONG-CLEARING",
      paidAt: wrongClearingPaidAt,
      updatedAt: wrongClearingPaidAt,
    });
    wrongClearingState.ledger = [
      ...orderPaymentLines(wrongClearingOrder, broker, agent, { wrongActorAccount: `${otherAgent.name} ACTOR_CLEARING` }),
      ...(wrongClearingState.ledger || []),
    ];
    const wrongClearing = await request(baseUrl, "/api/app-state", {
      cookie: agentSignup.cookie,
      method: "PUT",
      body: { state: wrongClearingState, expectedRevision: wrongClearingView.data.revision },
    });
    assert.equal(wrongClearing.status, 409);
    assert.match(wrongClearing.data.error, /Actor account does not match/i);

    const afterWrongClearing = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    assert.equal(afterWrongClearing.data.revision, securityBaseline.data.revision);
    assert.deepEqual(accountingStateProjection(afterWrongClearing.data.state), assignedAccounting);

    const orphanState = structuredClone(afterWrongClearing.data.state);
    orphanState.ledger = [
      {
        journal: "JRN-ORPHAN-PAYMENT",
        orderId: "ORD-NOT-FOUND",
        source: "ORDER_PAYMENT",
        account: `${broker.name} ACTOR_CLEARING`,
        direction: "Debit",
        currency: "USD",
        amountMinor: 777,
        postedAt: new Date(Date.now() + 5_000).toISOString(),
      },
      ...(orphanState.ledger || []),
    ];
    const orphanPayment = await request(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: { state: orphanState, expectedRevision: afterWrongClearing.data.revision },
    });
    assert.equal(orphanPayment.status, 409);
    assert.match(orphanPayment.data.error, /no unique order record/i);

    const afterOrphan = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    assert.equal(afterOrphan.data.revision, securityBaseline.data.revision);
    assert.deepEqual(accountingStateProjection(afterOrphan.data.state), assignedAccounting);

    const archivedOrphanState = structuredClone(afterOrphan.data.state);
    archivedOrphanState.archives = [
      {
        id: "ARC-ORPHAN-PAYMENT-INJECTION",
        actor: broker.name,
        actorId: broker.id,
        actorRole: broker.role,
        actorCurrency: broker.currency,
        closedAt: new Date(Date.now() + 5_500).toISOString(),
        ledger: [{
          journal: "JRN-ARCHIVED-ORPHAN",
          orderId: "ORD-ARCHIVED-NOT-FOUND",
          source: "ORDER_PAYMENT",
          account: `${broker.name} ACTOR_CLEARING`,
          direction: "Debit",
          currency: "USD",
          amountMinor: 888,
          postedAt: new Date(Date.now() + 5_500).toISOString(),
          archived: true,
        }],
        orders: [],
        transfers: [],
        receivables: [],
      },
      ...(archivedOrphanState.archives || []),
    ];
    const archivedOrphan = await request(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: { state: archivedOrphanState, expectedRevision: afterOrphan.data.revision },
    });
    assert.equal(archivedOrphan.status, 409);
    assert.match(archivedOrphan.data.error, /archived|no unique order|orphan/i);

    const afterArchivedOrphan = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    assert.equal(afterArchivedOrphan.data.revision, securityBaseline.data.revision);
    assert.equal((afterArchivedOrphan.data.state.archives || []).some((archive) => archive.id === "ARC-ORPHAN-PAYMENT-INJECTION"), false);
    assert.deepEqual(accountingStateProjection(afterArchivedOrphan.data.state), assignedAccounting);

    const paymentView = await requestOk(baseUrl, "/api/app-state", { cookie: agentSignup.cookie });
    const paymentState = structuredClone(paymentView.data.state);
    const paidOrder = paymentState.orders.find((order) => order.id === "ORD-IDENTITY-1");
    const assignedOrderBeforePayment = structuredClone(paidOrder);
    const paidAt = "2099-01-01T00:00:00.000Z";
    Object.assign(paidOrder, {
      state: "Paid",
      journal: "JRN-IDENTITY-FUTURE",
      paidAt,
      updatedAt: paidAt,
      incomeBaseCurrency: "USD",
      incomeBaseAmountMinor: 1_000,
      incomeCollectedCurrency: "ETB",
      incomeCollectedOriginalMinor: 20_000,
      incomeProfitMinor: 987_654_321,
      incomeSnapshotAt: paidAt,
    });
    paymentState.ledger = [
      ...orderPaymentLines(paidOrder, broker, agent, { spoofIdentity: true }),
      ...(paymentState.ledger || []),
    ];
    const paid = await requestOk(baseUrl, "/api/app-state", {
      cookie: agentSignup.cookie,
      method: "PUT",
      body: { state: paymentState, expectedRevision: paymentView.data.revision },
    });
    const serverPaidOrder = paid.data.state.orders.find((order) => order.id === paidOrder.id);
    assert.notEqual(serverPaidOrder.incomeProfitMinor, 987_654_321, "Client-submitted income profit must not become accounting truth.");
    assert.notEqual(serverPaidOrder.paidAt, paidAt, "The server must replace a forged client payment timestamp.");
    assert.equal(serverPaidOrder.updatedAt, serverPaidOrder.paidAt);
    assert.ok(
      new Date(serverPaidOrder.paidAt).getTime() > Math.max(
        new Date(assignedOrderBeforePayment.assignedAt || 0).getTime(),
        new Date(assignedOrderBeforePayment.updatedAt || 0).getTime(),
      ),
    );
    assert.equal(paid.data.state.ledger
      .filter((line) => line.orderId === paidOrder.id && line.source === "ORDER_PAYMENT")
      .every((line) => line.postedAt === serverPaidOrder.paidAt), true);
    const brokerLine = paid.data.state.ledger.find((line) =>
      line.journal === paidOrder.journal && line.account === `${broker.name} ACTOR_CLEARING`
    );
    const agentLine = paid.data.state.ledger.find((line) =>
      line.journal === paidOrder.journal && line.account === `${agent.name} ACTOR_CLEARING`
    );
    assert.deepEqual({ actorId: brokerLine.actorId, role: brokerLine.participantRole }, { actorId: broker.id, role: "broker" });
    assert.deepEqual({ actorId: agentLine.actorId, role: agentLine.participantRole }, { actorId: agent.id, role: "agent" });

    const staleActorStateResponse = await requestOk(baseUrl, "/api/app-state", { cookie: brokerSignup.cookie });
    const staleActorState = structuredClone(staleActorStateResponse.data.state);
    const staleOrder = staleActorState.orders.find((order) => order.id === "ORD-IDENTITY-1");
    staleOrder.agentActorId = otherAgent.id;
    staleOrder.agent = otherAgent.name;
    staleOrder.journal = "JRN-SPOOFED-FUTURE";
    staleActorState.orderParticipantIdentityLinks = [{ repairId: "FAKE-LINK", actorId: otherAgent.id }];
    staleActorState.ledger
      .filter((line) => line.orderId === staleOrder.id)
      .forEach((line) => {
        line.journal = "JRN-SPOOFED-FUTURE";
        line.actorId = "ACT-SPOOF";
        line.participantRole = line.participantRole === "broker" ? "agent" : "broker";
        line.postedAt = new Date(Date.now() + 5_000).toISOString();
      });
    const staleSave = await requestOk(baseUrl, "/api/app-state", {
      cookie: brokerSignup.cookie,
      method: "PUT",
      body: { state: staleActorState, expectedRevision: staleActorStateResponse.data.revision },
    });
    const protectedPaidOrder = staleSave.data.state.orders.find((order) => order.id === "ORD-IDENTITY-1");
    assert.equal(protectedPaidOrder.agentActorId, agent.id);
    assert.equal(protectedPaidOrder.agent, agent.name);
    assert.equal(protectedPaidOrder.journal, "JRN-IDENTITY-FUTURE");
    assert.equal(staleSave.data.state.ledger.some((line) => line.journal === "JRN-SPOOFED-FUTURE"), false);
    assert.equal(staleSave.data.state.orderParticipantIdentityLinks?.length || 0, 0);
    const protectedAgentLine = staleSave.data.state.ledger.find((line) =>
      line.journal === "JRN-IDENTITY-FUTURE" && line.account === `${agent.name} ACTOR_CLEARING`
    );
    assert.deepEqual({ actorId: protectedAgentLine.actorId, role: protectedAgentLine.participantRole }, { actorId: agent.id, role: "agent" });

    const sharedJournalPaymentView = await requestOk(baseUrl, "/api/app-state", { cookie: agentSignup.cookie });
    const sharedJournalPaymentState = structuredClone(sharedJournalPaymentView.data.state);
    const sharedJournalOrder = sharedJournalPaymentState.orders.find((order) => order.id === "ORD-IDENTITY-BLANK");
    const sharedJournalPaidAt = new Date(Date.now() + 6_500).toISOString();
    Object.assign(sharedJournalOrder, {
      state: "Paid",
      journal: "JRN-IDENTITY-FUTURE",
      paidAt: sharedJournalPaidAt,
      updatedAt: sharedJournalPaidAt,
      incomeProfitMinor: 0,
    });
    sharedJournalPaymentState.ledger = [
      ...orderPaymentLines(sharedJournalOrder, broker, agent),
      ...(sharedJournalPaymentState.ledger || []),
    ];
    const sharedJournalPaid = await requestOk(baseUrl, "/api/app-state", {
      cookie: agentSignup.cookie,
      method: "PUT",
      body: { state: sharedJournalPaymentState, expectedRevision: sharedJournalPaymentView.data.revision },
    });
    const collisionRenamedOrder = sharedJournalPaid.data.state.orders.find((order) => order.id === sharedJournalOrder.id);
    assert.equal(collisionRenamedOrder.state, "Paid");
    assert.equal(collisionRenamedOrder.journal, `${protectedPaidOrder.journal} (1)`);
    const storedSharedJournalOrder = collisionRenamedOrder;
    const sharedOrderAccounting = orderAccountingProjection(storedSharedJournalOrder);
    const sharedOrderPaidLines = sharedJournalPaid.data.state.ledger
      .filter((line) => line.orderId === storedSharedJournalOrder.id && line.source === "ORDER_PAYMENT")
      .map((line) => structuredClone(line));
    assert.equal(sharedOrderPaidLines.length, 4);

    const currentProtectedPaidOrder = sharedJournalPaid.data.state.orders.find((order) => order.id === protectedPaidOrder.id);
    const paidAccounting = orderAccountingProjection(currentProtectedPaidOrder);
    const originalPaidLines = sharedJournalPaid.data.state.ledger
      .filter((line) => line.orderId === protectedPaidOrder.id && line.source === "ORDER_PAYMENT")
      .map((line) => structuredClone(line));
    assert.equal(originalPaidLines.length, 4);

    const firstVoidRequestView = await requestOk(baseUrl, "/api/app-state", { cookie: agentSignup.cookie });
    const firstVoidRequestState = structuredClone(firstVoidRequestView.data.state);
    const firstVoidRequestOrder = firstVoidRequestState.orders.find((order) => order.id === protectedPaidOrder.id);
    firstVoidRequestOrder.state = "Void Requested";
    firstVoidRequestOrder.voidRequested = true;
    const firstVoidRequest = await requestOk(baseUrl, "/api/app-state", {
      cookie: agentSignup.cookie,
      method: "PUT",
      body: { state: firstVoidRequestState, expectedRevision: firstVoidRequestView.data.revision },
    });
    const firstRequestedOrder = firstVoidRequest.data.state.orders.find((order) => order.id === protectedPaidOrder.id);
    assert.equal(firstRequestedOrder.state, "Void Requested");
    assert.equal(firstRequestedOrder.voidRequested, true);
    assert.equal(firstRequestedOrder.voidRequestedBy, agent.name);
    assert.deepEqual(orderAccountingProjection(firstRequestedOrder), paidAccounting);

    const rejectView = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    const rejectState = structuredClone(rejectView.data.state);
    const rejectOrder = rejectState.orders.find((order) => order.id === protectedPaidOrder.id);
    rejectOrder.state = "Paid";
    rejectOrder.voidRequested = false;
    const rejected = await requestOk(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: { state: rejectState, expectedRevision: rejectView.data.revision },
    });
    const rejectedOrder = rejected.data.state.orders.find((order) => order.id === protectedPaidOrder.id);
    assert.equal(rejectedOrder.state, "Paid");
    assert.equal(rejectedOrder.voidRequested, false);
    assert.equal(rejectedOrder.voidRejectedBy, "Master");
    assert.ok(rejectedOrder.voidRejectedAt);
    assert.ok(new Date(rejectedOrder.voidRejectedAt).getTime() > new Date(firstRequestedOrder.voidRequestedAt).getTime());
    assert.deepEqual(orderAccountingProjection(rejectedOrder), paidAccounting);
    assert.deepEqual(
      rejected.data.state.ledger.filter((line) => line.orderId === protectedPaidOrder.id && line.source === "ORDER_PAYMENT"),
      originalPaidLines,
      "Rejecting a void request must not rewrite the payment journal.",
    );

    const secondVoidRequestView = await requestOk(baseUrl, "/api/app-state", { cookie: agentSignup.cookie });
    const secondVoidRequestState = structuredClone(secondVoidRequestView.data.state);
    const secondVoidRequestOrder = secondVoidRequestState.orders.find((order) => order.id === protectedPaidOrder.id);
    secondVoidRequestOrder.state = "Void Requested";
    secondVoidRequestOrder.voidRequested = true;
    const secondVoidRequest = await requestOk(baseUrl, "/api/app-state", {
      cookie: agentSignup.cookie,
      method: "PUT",
      body: { state: secondVoidRequestState, expectedRevision: secondVoidRequestView.data.revision },
    });
    const secondRequestedOrder = secondVoidRequest.data.state.orders.find((order) => order.id === protectedPaidOrder.id);
    assert.equal(secondRequestedOrder.state, "Void Requested");
    assert.ok(new Date(secondRequestedOrder.voidRequestedAt).getTime() > new Date(rejectedOrder.voidRejectedAt).getTime());
    assert.deepEqual(orderAccountingProjection(secondRequestedOrder), paidAccounting);

    const approvalView = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    const approvalState = structuredClone(approvalView.data.state);
    const approvalOrder = approvalState.orders.find((order) => order.id === protectedPaidOrder.id);
    const voidJournal = "JRN-IDENTITY-VOID";
    approvalOrder.state = "Voided";
    approvalOrder.voidJournal = voidJournal;
    approvalOrder.voidRequested = false;
    const submittedReversals = approvalState.ledger
      .filter((line) => line.orderId === protectedPaidOrder.id && line.source === "ORDER_PAYMENT")
      .map((line) => ({
        ...line,
        journal: voidJournal,
        source: "ORDER_VOID",
        direction: line.direction === "Debit" ? "Credit" : "Debit",
        details: `Void of ${protectedPaidOrder.brokerOrderNumber}`,
        postedAt: new Date(Date.now() + 7_000).toISOString(),
      }));
    approvalState.ledger.push(...submittedReversals);
    const approved = await requestOk(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: { state: approvalState, expectedRevision: approvalView.data.revision },
    });
    const voidedOrder = approved.data.state.orders.find((order) => order.id === protectedPaidOrder.id);
    assert.equal(voidedOrder.state, "Voided");
    assert.equal(voidedOrder.voidJournal, voidJournal);
    assert.equal(voidedOrder.voidedBy, "Master");
    assert.equal(voidedOrder.excludedFromCalculations, true);
    assert.ok(new Date(voidedOrder.voidedAt).getTime() > new Date(secondRequestedOrder.voidRequestedAt).getTime());
    assert.deepEqual(orderAccountingProjection(voidedOrder), paidAccounting);

    const voidedPaymentLines = approved.data.state.ledger
      .filter((line) => line.orderId === protectedPaidOrder.id && line.source === "ORDER_PAYMENT");
    const reversalLines = approved.data.state.ledger
      .filter((line) => line.orderId === protectedPaidOrder.id && line.source === "ORDER_VOID");
    assert.equal(voidedPaymentLines.length, originalPaidLines.length);
    assert.equal(reversalLines.length, originalPaidLines.length);
    for (const original of originalPaidLines) {
      const voidedPayment = voidedPaymentLines.find((line) =>
        line.account === original.account
        && line.direction === original.direction
        && line.currency === original.currency
        && line.amountMinor === original.amountMinor
        && line.journal === original.journal
        && line.postedAt === original.postedAt
      );
      assert.ok(voidedPayment, `Original payment row for ${original.account} must remain exact.`);
      assert.equal(voidedPayment.voided, true);
      assert.equal(voidedPayment.excludedFromCalculations, true);
      const reversal = reversalLines.find((line) =>
        line.account === original.account
        && line.direction === (original.direction === "Debit" ? "Credit" : "Debit")
        && line.currency === original.currency
        && line.amountMinor === original.amountMinor
        && line.journal === voidJournal
      );
      assert.ok(reversal, `Exact reversal for ${original.account} ${original.currency} must exist.`);
      assert.equal(reversal.actorId, original.actorId);
      assert.equal(reversal.participantRole, original.participantRole);
      assert.equal(reversal.voided, true);
      assert.equal(reversal.excludedFromCalculations, true);
      assert.equal(reversal.postedAt, voidedOrder.voidedAt);
    }
    const untouchedSharedJournalOrder = approved.data.state.orders.find((order) => order.id === storedSharedJournalOrder.id);
    assert.equal(untouchedSharedJournalOrder.state, "Paid");
    assert.equal(untouchedSharedJournalOrder.voidJournal || "", "");
    assert.deepEqual(orderAccountingProjection(untouchedSharedJournalOrder), sharedOrderAccounting);
    assert.deepEqual(
      approved.data.state.ledger.filter((line) => line.orderId === storedSharedJournalOrder.id && line.source === "ORDER_PAYMENT"),
      sharedOrderPaidLines,
      "Voiding one order must not rewrite the adjacent collision-renamed order.",
    );
    assert.equal(
      approved.data.state.ledger.some((line) => line.orderId === storedSharedJournalOrder.id && line.source === "ORDER_VOID"),
      false,
      "No reversal may be attached to the other order in the journal-collision group.",
    );
    assert.equal(
      approved.data.state.ledger.some((line) =>
        line.orderId === protectedPaidOrder.id
        && ["ORDER_PAYMENT", "ORDER_VOID"].includes(line.source)
        && line.excludedFromCalculations !== true
      ),
      false,
      "A completed void leaves no payment amount contributing to either Actor balance.",
    );

    const legacySeedView = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    const legacySeedState = structuredClone(legacySeedView.data.state);
    const legacyOrder = {
      ...orderFixture({ id: "ORD-LEGACY-BROKER-NAME", broker, agent, agentActorId: agent.id }),
      sourceAmountMinor: 2_300,
      payoutAmountMinor: 46_000,
      grossMinor: 2_300,
    };
    legacySeedState.orders.unshift(legacyOrder);
    const legacySeeded = await requestOk(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: { state: legacySeedState, expectedRevision: legacySeedView.data.revision },
    });

    const databasePath = path.join(dataDirectory, "auth-db.json");
    const persistedDatabase = JSON.parse(await readFile(databasePath, "utf8"));
    const workspaceId = master.data.session.workspace.id;
    const persistedLegacyOrder = persistedDatabase.appStates[workspaceId].orders
      .find((order) => order.id === legacyOrder.id);
    assert.ok(persistedLegacyOrder);
    persistedLegacyOrder.brokerActorId = "";
    await writeFile(databasePath, JSON.stringify(persistedDatabase, null, 2));

    const legacyPaymentView = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    assert.equal(legacyPaymentView.data.revision, legacySeeded.data.revision);
    const legacyPaymentState = structuredClone(legacyPaymentView.data.state);
    const legacyPaidOrder = legacyPaymentState.orders.find((order) => order.id === legacyOrder.id);
    assert.equal(legacyPaidOrder.brokerActorId || "", "");
    const legacyPaidAt = new Date(Date.now() + 8_000).toISOString();
    Object.assign(legacyPaidOrder, {
      state: "Paid",
      journal: "JRN-LEGACY-BROKER-NAME",
      paidAt: legacyPaidAt,
      updatedAt: legacyPaidAt,
    });
    legacyPaymentState.ledger = [
      ...orderPaymentLines(legacyPaidOrder, broker, agent),
      ...(legacyPaymentState.ledger || []),
    ];
    const legacyPaid = await requestOk(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: { state: legacyPaymentState, expectedRevision: legacyPaymentView.data.revision },
    });
    const legacyBrokerLine = legacyPaid.data.state.ledger.find((line) =>
      line.orderId === legacyOrder.id
      && line.source === "ORDER_PAYMENT"
      && line.account === `${broker.name} ACTOR_CLEARING`
    );
    assert.deepEqual(
      { actorId: legacyBrokerLine?.actorId, role: legacyBrokerLine?.participantRole },
      { actorId: broker.id, role: "broker" },
      "A legacy name-only Broker order must still post to the correct stable Broker identity.",
    );

    const sentinelArchive = {
      id: "ARC-CLOSED-SENTINEL",
      actor: otherBroker.name,
      actorId: otherBroker.id,
      actorRole: otherBroker.role,
      actorCurrency: otherBroker.currency,
      closedAt: "2026-01-01T00:00:00.000Z",
      ledger: [],
      orders: [],
      transfers: [],
      receivables: [],
    };
    const archiveSeedDatabase = JSON.parse(await readFile(databasePath, "utf8"));
    archiveSeedDatabase.appStates[workspaceId].archives = [
      sentinelArchive,
      ...(archiveSeedDatabase.appStates[workspaceId].archives || []),
    ];
    await writeFile(databasePath, JSON.stringify(archiveSeedDatabase, null, 2));

    const managedSeedView = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    assert.equal(managedSeedView.data.revision, legacyPaid.data.revision);
    const managedSeedState = structuredClone(managedSeedView.data.state);
    const managedOrder = {
      ...orderFixture({
        id: "ORD-MANAGED-MASTER-WORKFLOW",
        broker,
        agent: managedActor,
        agentActorId: managedActor.id,
      }),
      sourceAmountMinor: 3_400,
      payoutAmountMinor: 68_000,
      grossMinor: 3_400,
    };
    managedSeedState.orders.unshift(managedOrder);
    const managedSeeded = await requestOk(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: { state: managedSeedState, expectedRevision: managedSeedView.data.revision },
    });
    const closedArchivesBeforeManagedWorkflow = structuredClone(managedSeeded.data.state.archives || []);

    const managedPaymentState = structuredClone(managedSeeded.data.state);
    const managedPaidOrderInput = managedPaymentState.orders.find((order) => order.id === managedOrder.id);
    const managedPaidAt = new Date(Date.now() + 9_000).toISOString();
    Object.assign(managedPaidOrderInput, {
      state: "Paid",
      journal: "JRN-MANAGED-MASTER-PAY",
      paidAt: managedPaidAt,
      updatedAt: managedPaidAt,
      incomeProfitMinor: 0,
    });
    managedPaymentState.ledger = [
      ...orderPaymentLines(managedPaidOrderInput, broker, managedActor),
      ...(managedPaymentState.ledger || []),
    ];
    const managedPaid = await requestOk(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: { state: managedPaymentState, expectedRevision: managedSeeded.data.revision },
    });
    const managedPaidOrder = managedPaid.data.state.orders.find((order) => order.id === managedOrder.id);
    const managedAccounting = orderAccountingProjection(managedPaidOrder);
    const managedOriginalLines = managedPaid.data.state.ledger
      .filter((line) => line.orderId === managedOrder.id && line.source === "ORDER_PAYMENT")
      .map((line) => structuredClone(line));
    assert.equal(managedPaidOrder.state, "Paid");
    assert.equal(managedOriginalLines.length, 4);

    const managedRequestState = structuredClone(managedPaid.data.state);
    const managedRequestOrder = managedRequestState.orders.find((order) => order.id === managedOrder.id);
    managedRequestOrder.state = "Void Requested";
    managedRequestOrder.voidRequested = true;
    const managedRequested = await requestOk(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: { state: managedRequestState, expectedRevision: managedPaid.data.revision },
    });
    const managedRequestedOrder = managedRequested.data.state.orders.find((order) => order.id === managedOrder.id);
    assert.equal(managedRequestedOrder.state, "Void Requested");
    assert.equal(managedRequestedOrder.voidRequestedBy, managedActor.name);
    assert.deepEqual(orderAccountingProjection(managedRequestedOrder), managedAccounting);

    const managedRejectState = structuredClone(managedRequested.data.state);
    const managedRejectOrder = managedRejectState.orders.find((order) => order.id === managedOrder.id);
    managedRejectOrder.state = "Paid";
    managedRejectOrder.voidRequested = false;
    const managedRejected = await requestOk(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: { state: managedRejectState, expectedRevision: managedRequested.data.revision },
    });
    const managedRejectedOrder = managedRejected.data.state.orders.find((order) => order.id === managedOrder.id);
    assert.equal(managedRejectedOrder.state, "Paid");
    assert.ok(managedRejectedOrder.voidRejectedAt);
    assert.deepEqual(orderAccountingProjection(managedRejectedOrder), managedAccounting);
    assert.deepEqual(
      managedRejected.data.state.ledger.filter((line) => line.orderId === managedOrder.id && line.source === "ORDER_PAYMENT"),
      managedOriginalLines,
    );

    const managedSecondRequestState = structuredClone(managedRejected.data.state);
    const managedSecondRequestOrder = managedSecondRequestState.orders.find((order) => order.id === managedOrder.id);
    managedSecondRequestOrder.state = "Void Requested";
    managedSecondRequestOrder.voidRequested = true;
    const managedSecondRequested = await requestOk(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: { state: managedSecondRequestState, expectedRevision: managedRejected.data.revision },
    });

    const duplicateVoidApprovalState = structuredClone(managedSecondRequested.data.state);
    const duplicateVoidApprovalOrder = duplicateVoidApprovalState.orders.find((order) => order.id === managedOrder.id);
    duplicateVoidApprovalOrder.state = "Voided";
    duplicateVoidApprovalOrder.voidJournal = voidJournal;
    duplicateVoidApprovalOrder.voidRequested = false;
    duplicateVoidApprovalState.ledger.push(...duplicateVoidApprovalState.ledger
      .filter((line) => line.orderId === managedOrder.id && line.source === "ORDER_PAYMENT")
      .map((line) => ({
        ...line,
        journal: voidJournal,
        source: "ORDER_VOID",
        direction: line.direction === "Debit" ? "Credit" : "Debit",
        postedAt: new Date(Date.now() + 9_500).toISOString(),
      })));
    const duplicateVoidApproval = await request(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: { state: duplicateVoidApprovalState, expectedRevision: managedSecondRequested.data.revision },
    });
    assert.equal(duplicateVoidApproval.status, 409);
    assert.match(duplicateVoidApproval.data.error, /void.*journal|journal.*use|unique/i);

    const afterDuplicateVoidJournal = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    assert.equal(afterDuplicateVoidJournal.data.revision, managedSecondRequested.data.revision);
    assert.equal(afterDuplicateVoidJournal.data.state.orders.find((order) => order.id === managedOrder.id).state, "Void Requested");
    assert.deepEqual(afterDuplicateVoidJournal.data.state.archives || [], closedArchivesBeforeManagedWorkflow);

    const managedApprovalState = structuredClone(afterDuplicateVoidJournal.data.state);
    const managedApprovalOrder = managedApprovalState.orders.find((order) => order.id === managedOrder.id);
    managedApprovalOrder.state = "Voided";
    managedApprovalOrder.voidJournal = "JRN-MANAGED-MASTER-VOID";
    managedApprovalOrder.voidRequested = false;
    managedApprovalState.ledger.push(...managedApprovalState.ledger
      .filter((line) => line.orderId === managedOrder.id && line.source === "ORDER_PAYMENT")
      .map((line) => ({
        ...line,
        journal: managedApprovalOrder.voidJournal,
        source: "ORDER_VOID",
        direction: line.direction === "Debit" ? "Credit" : "Debit",
        details: `Void of ${managedPaidOrder.brokerOrderNumber}`,
        postedAt: new Date(Date.now() + 10_000).toISOString(),
      })));
    const managedApproved = await requestOk(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: { state: managedApprovalState, expectedRevision: afterDuplicateVoidJournal.data.revision },
    });
    const managedVoidedOrder = managedApproved.data.state.orders.find((order) => order.id === managedOrder.id);
    assert.equal(managedVoidedOrder.state, "Voided");
    assert.deepEqual(orderAccountingProjection(managedVoidedOrder), managedAccounting);
    const managedVoidedPayments = managedApproved.data.state.ledger
      .filter((line) => line.orderId === managedOrder.id && line.source === "ORDER_PAYMENT");
    const managedReversals = managedApproved.data.state.ledger
      .filter((line) => line.orderId === managedOrder.id && line.source === "ORDER_VOID");
    assert.equal(managedVoidedPayments.length, managedOriginalLines.length);
    assert.equal(managedReversals.length, managedOriginalLines.length);
    for (const original of managedOriginalLines) {
      assert.ok(managedReversals.some((line) =>
        line.account === original.account
        && line.currency === original.currency
        && line.amountMinor === original.amountMinor
        && line.direction === (original.direction === "Debit" ? "Credit" : "Debit")
      ));
    }
    assert.deepEqual(managedApproved.data.state.archives || [], closedArchivesBeforeManagedWorkflow);

    const commissionSeedState = structuredClone(managedApproved.data.state);
    const commissionOrder = {
      ...orderFixture({ id: "ORD-BROKER-COMMISSION-100", broker, agent, agentActorId: agent.id }),
      sourceAmountMinor: 4_100,
      payoutAmountMinor: 82_000,
      commissionPercent: 100,
      commissionMinor: 4_100,
      grossMinor: 8_200,
      orderCommissionLiability: "Broker",
    };
    commissionSeedState.orders.unshift(commissionOrder);
    const commissionSeeded = await requestOk(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: { state: commissionSeedState, expectedRevision: managedApproved.data.revision },
    });

    const commissionPaymentView = await requestOk(baseUrl, "/api/app-state", { cookie: agentSignup.cookie });
    const commissionPaymentState = structuredClone(commissionPaymentView.data.state);
    const commissionPaidOrderInput = commissionPaymentState.orders.find((order) => order.id === commissionOrder.id);
    const commissionPaidAt = new Date(Date.now() + 11_000).toISOString();
    Object.assign(commissionPaidOrderInput, {
      state: "Paid",
      journal: "JRN-BROKER-COMMISSION-100",
      paidAt: commissionPaidAt,
      updatedAt: commissionPaidAt,
    });
    const [brokerPrincipal, masterPrincipal, masterPayout, agentPayout] = orderPaymentLines(
      commissionPaidOrderInput,
      broker,
      agent,
    );
    commissionPaymentState.ledger = [
      brokerPrincipal,
      { ...brokerPrincipal },
      masterPrincipal,
      {
        journal: commissionPaidOrderInput.journal,
        orderId: commissionPaidOrderInput.id,
        source: "ORDER_PAYMENT",
        account: "MASTER_FEE_REVENUE",
        direction: "Credit",
        currency: commissionPaidOrderInput.sourceCurrency,
        amountMinor: commissionPaidOrderInput.commissionMinor,
        postedAt: commissionPaidOrderInput.paidAt,
      },
      masterPayout,
      agentPayout,
      ...(commissionPaymentState.ledger || []),
    ];
    const commissionPaid = await requestOk(baseUrl, "/api/app-state", {
      cookie: agentSignup.cookie,
      method: "PUT",
      body: { state: commissionPaymentState, expectedRevision: commissionPaymentView.data.revision },
    });
    const identicalBrokerDebits = commissionPaid.data.state.ledger.filter((line) =>
      line.orderId === commissionOrder.id
      && line.source === "ORDER_PAYMENT"
      && line.account === `${broker.name} ACTOR_CLEARING`
      && line.direction === "Debit"
      && line.currency === commissionOrder.sourceCurrency
      && line.amountMinor === commissionOrder.sourceAmountMinor
    );
    assert.equal(identicalBrokerDebits.length, 2);
    assert.deepEqual(
      new Set(identicalBrokerDebits.map((line) => line.paymentComponent)),
      new Set(["brokerPrincipal", "brokerCommission"]),
    );
    assert.equal(identicalBrokerDebits.reduce((sum, line) => sum + line.amountMinor, 0), commissionOrder.grossMinor);

    const commissionRoundTripView = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    const commissionRoundTrip = await requestOk(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: {
        state: structuredClone(commissionRoundTripView.data.state),
        expectedRevision: commissionRoundTripView.data.revision,
      },
    });
    const roundTrippedBrokerDebits = commissionRoundTrip.data.state.ledger.filter((line) =>
      line.orderId === commissionOrder.id
      && line.source === "ORDER_PAYMENT"
      && line.account === `${broker.name} ACTOR_CLEARING`
      && line.direction === "Debit"
      && line.currency === commissionOrder.sourceCurrency
      && line.amountMinor === commissionOrder.sourceAmountMinor
    );
    assert.equal(roundTrippedBrokerDebits.length, 2);
    assert.deepEqual(
      new Set(roundTrippedBrokerDebits.map((line) => line.paymentComponent)),
      new Set(["brokerPrincipal", "brokerCommission"]),
      "Ledger merge keys must preserve financially identical principal and commission rows.",
    );

    const archiveScopeDatabase = JSON.parse(await readFile(databasePath, "utf8"));
    const archiveScopeState = archiveScopeDatabase.appStates[workspaceId];
    const persistedCommissionOrder = archiveScopeState.orders.find((order) => order.id === commissionOrder.id);
    const persistedLegacyPaidOrder = archiveScopeState.orders.find((order) => order.id === legacyOrder.id);
    assert.ok(persistedCommissionOrder && persistedLegacyPaidOrder);
    const sameIdDifferentJournalArchive = {
      id: "ARC-SAME-ID-DIFFERENT-JOURNAL",
      actor: broker.name,
      actorId: broker.id,
      actorRole: broker.role,
      actorCurrency: broker.currency,
      closedAt: "2026-02-01T00:00:00.000Z",
      ledger: [],
      orders: [{ ...persistedCommissionOrder, journal: "JRN-HISTORICAL-DIFFERENT-NAME" }],
      transfers: [],
      receivables: [],
    };
    const differentIdSameJournalArchive = {
      id: "ARC-DIFFERENT-ID-SAME-JOURNAL",
      actor: broker.name,
      actorId: broker.id,
      actorRole: broker.role,
      actorCurrency: broker.currency,
      closedAt: "2026-02-02T00:00:00.000Z",
      ledger: [],
      orders: [{
        ...persistedLegacyPaidOrder,
        id: "ORD-ARCHIVED-DIFFERENT-STABLE-ID",
        internalOrderId: "ORD-ARCHIVED-DIFFERENT-STABLE-ID",
        collisionSourceOrderId: "ORD-ARCHIVED-DIFFERENT-STABLE-ID",
      }],
      transfers: [],
      receivables: [],
    };
    archiveScopeState.archives = [
      sameIdDifferentJournalArchive,
      differentIdSameJournalArchive,
      ...(archiveScopeState.archives || []),
    ];
    await writeFile(databasePath, JSON.stringify(archiveScopeDatabase, null, 2));

    const archivesBeforeScopeChecks = structuredClone(archiveScopeState.archives || []);
    const sameIdRequestState = structuredClone(commissionRoundTrip.data.state);
    const sameIdLiveOrder = sameIdRequestState.orders.find((order) => order.id === commissionOrder.id);
    sameIdLiveOrder.state = "Void Requested";
    sameIdLiveOrder.voidRequested = true;
    const sameIdRequest = await request(baseUrl, "/api/app-state", {
      cookie: agentSignup.cookie,
      method: "PUT",
      body: { state: sameIdRequestState, expectedRevision: commissionRoundTrip.data.revision },
    });
    assert.equal(sameIdRequest.status, 409);
    assert.match(sameIdRequest.data.error, /balance containing it is already closed/i);

    const afterSameIdDatabase = JSON.parse(await readFile(databasePath, "utf8"));
    assert.equal(afterSameIdDatabase.appStates[workspaceId]._syncRevision, commissionRoundTrip.data.revision);
    assert.equal(afterSameIdDatabase.appStates[workspaceId].orders.find((order) => order.id === commissionOrder.id).state, "Paid");
    assert.deepEqual(afterSameIdDatabase.appStates[workspaceId].archives || [], archivesBeforeScopeChecks);

    const differentIdRequestState = structuredClone(commissionRoundTrip.data.state);
    const differentIdLiveOrder = differentIdRequestState.orders.find((order) => order.id === legacyOrder.id);
    differentIdLiveOrder.state = "Void Requested";
    differentIdLiveOrder.voidRequested = true;
    const differentIdRequested = await requestOk(baseUrl, "/api/app-state", {
      cookie: agentSignup.cookie,
      method: "PUT",
      body: { state: differentIdRequestState, expectedRevision: commissionRoundTrip.data.revision },
    });
    assert.equal(
      differentIdRequested.data.state.orders.find((order) => order.id === legacyOrder.id)?.state,
      "Void Requested",
      JSON.stringify(differentIdRequested.data.state.orders.map((order) => ({ id: order.id, state: order.state, journal: order.journal }))),
    );
    assert.deepEqual(
      differentIdRequested.data.state.archives || [],
      [],
      "The paying Actor response must not include another Actor's reports.",
    );
    const afterDifferentIdRequest = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    assert.deepEqual(afterDifferentIdRequest.data.state.archives || [], archivesBeforeScopeChecks);

    const equalPairSeedView = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    const equalPairSeedState = structuredClone(equalPairSeedView.data.state);
    const equalPairOrder = (idValue) => ({
      ...orderFixture({ id: idValue, broker, agent, agentActorId: agent.id }),
      sourceAmountMinor: 5_100,
      payoutAmountMinor: 102_000,
      commissionPercent: 100,
      commissionMinor: 5_100,
      grossMinor: 10_200,
      orderCommissionLiability: "Broker",
    });
    const equalOrderA = equalPairOrder("ORD-EQUAL-PAYMENT-A");
    const equalOrderB = equalPairOrder("ORD-EQUAL-PAYMENT-B");
    equalPairSeedState.orders.unshift(equalOrderA, equalOrderB);
    const equalPairSeeded = await requestOk(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: { state: equalPairSeedState, expectedRevision: equalPairSeedView.data.revision },
    });

    const equalPairPaymentView = await requestOk(baseUrl, "/api/app-state", { cookie: agentSignup.cookie });
    const equalPairPaymentState = structuredClone(equalPairPaymentView.data.state);
    const equalPairPaidAt = "2098-01-01T00:00:00.000Z";
    const equalPaymentOrders = [equalOrderA.id, equalOrderB.id].map((orderId) => {
      const order = equalPairPaymentState.orders.find((item) => item.id === orderId);
      Object.assign(order, {
        state: "Paid",
        journal: "JRN-EQUAL-PAYMENT-PAIR",
        paidAt: equalPairPaidAt,
        updatedAt: equalPairPaidAt,
      });
      return order;
    });
    equalPairPaymentState.ledger = [
      ...brokerCommissionPaymentLines(equalPaymentOrders[0], broker, agent),
      ...brokerCommissionPaymentLines(equalPaymentOrders[1], broker, agent),
      ...(equalPairPaymentState.ledger || []),
    ];
    const equalPairPaid = await requestOk(baseUrl, "/api/app-state", {
      cookie: agentSignup.cookie,
      method: "PUT",
      body: { state: equalPairPaymentState, expectedRevision: equalPairPaymentView.data.revision },
    });
    const storedEqualOrders = [equalOrderA.id, equalOrderB.id]
      .map((orderId) => equalPairPaid.data.state.orders.find((order) => order.id === orderId));
    assert.equal(
      storedEqualOrders.every(Boolean),
      true,
      "Both distinct same-shape orders must survive duplicate cleanup before collision suffix allocation.",
    );
    assert.deepEqual(
      new Set(storedEqualOrders.map((order) => order.journal)),
      new Set(["JRN-EQUAL-PAYMENT-PAIR", "JRN-EQUAL-PAYMENT-PAIR (1)"]),
    );
    const serverRenamedEqualOrder = storedEqualOrders.find((order) => order.journal === "JRN-EQUAL-PAYMENT-PAIR (1)");
    const unsuffixedEqualOrder = storedEqualOrders.find((order) => order.journal === "JRN-EQUAL-PAYMENT-PAIR");
    assert.equal(serverRenamedEqualOrder.journalCollisionBase, "JRN-EQUAL-PAYMENT-PAIR");
    assert.equal(unsuffixedEqualOrder.journalCollisionBase, undefined);
    const expectedPaymentComponents = new Set([
      "brokerPrincipal",
      "brokerCommission",
      "masterPrincipal",
      "masterCommission",
      "masterPayout",
      "agentPayout",
    ]);
    const allEqualPairLines = equalPairPaid.data.state.ledger.filter((line) =>
      [equalOrderA.id, equalOrderB.id].includes(line.orderId) && line.source === "ORDER_PAYMENT"
    );
    assert.equal(allEqualPairLines.length, 12, "Both same-shape six-line payments must survive merge before journal suffix repair.");
    storedEqualOrders.forEach((order) => {
      const lines = allEqualPairLines.filter((line) => line.orderId === order.id);
      assert.equal(lines.length, 6);
      assert.notEqual(order.paidAt, equalPairPaidAt);
      assert.equal(order.updatedAt, order.paidAt);
      const assigned = equalPairSeeded.data.state.orders.find((item) => item.id === order.id);
      assert.ok(new Date(order.paidAt).getTime() > Math.max(
        new Date(assigned?.assignedAt || 0).getTime(),
        new Date(assigned?.updatedAt || 0).getTime(),
      ));
      assert.equal(lines.every((line) => line.journal === order.journal && line.postedAt === order.paidAt), true);
      assert.deepEqual(new Set(lines.map((line) => line.paymentComponent)), expectedPaymentComponents);
      [...new Set(lines.map((line) => line.currency))].forEach((currency) => {
        const signed = lines
          .filter((line) => line.currency === currency)
          .reduce((sum, line) => sum + (line.direction === "Debit" ? 1 : -1) * line.amountMinor, 0);
        assert.equal(signed, 0, `${order.id} ${currency} journal must remain balanced.`);
      });
    });

    const equalPairRoundTripView = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    const equalPairRoundTripState = structuredClone(equalPairRoundTripView.data.state);
    equalPairRoundTripState.orders.find((order) => order.id === serverRenamedEqualOrder.id).journalCollisionBase = "JRN-TAMPERED";
    equalPairRoundTripState.orders.find((order) => order.id === unsuffixedEqualOrder.id).journalCollisionBase = "JRN-FORGED";
    const equalPairRoundTrip = await requestOk(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: {
        state: equalPairRoundTripState,
        expectedRevision: equalPairRoundTripView.data.revision,
      },
    });
    assert.equal(equalPairRoundTrip.data.state.ledger.filter((line) =>
      [equalOrderA.id, equalOrderB.id].includes(line.orderId) && line.source === "ORDER_PAYMENT"
    ).length, 12);
    assert.equal(
      equalPairRoundTrip.data.state.orders.find((order) => order.id === serverRenamedEqualOrder.id).journalCollisionBase,
      "JRN-EQUAL-PAYMENT-PAIR",
      "A client cannot change the server-owned collision marker.",
    );
    assert.equal(
      equalPairRoundTrip.data.state.orders.find((order) => order.id === unsuffixedEqualOrder.id).journalCollisionBase,
      undefined,
      "A client cannot add a collision marker to an existing order.",
    );

    const externalCollisionSeedState = structuredClone(equalPairRoundTrip.data.state);
    const manualCollisionOrder = {
      ...orderFixture({ id: "ORD-MANUAL-JOURNAL-COLLISION", broker, agent, agentActorId: agent.id }),
      sourceAmountMinor: 6_100,
      payoutAmountMinor: 122_000,
      grossMinor: 6_100,
    };
    const transferCollisionOrder = {
      ...orderFixture({ id: "ORD-TRANSFER-JOURNAL-COLLISION", broker, agent, agentActorId: agent.id }),
      sourceAmountMinor: 6_200,
      payoutAmountMinor: 124_000,
      grossMinor: 6_200,
    };
    externalCollisionSeedState.orders.unshift(manualCollisionOrder, transferCollisionOrder);
    const manualPostedAt = new Date(Date.now() + 12_500).toISOString();
    externalCollisionSeedState.ledger = [
      {
        journal: "JRN-MANUAL-COLLISION",
        source: "JOURNAL",
        account: `${broker.name} ACTOR_CLEARING`,
        direction: "Debit",
        currency: "USD",
        amountMinor: 99,
        postedAt: manualPostedAt,
      },
      {
        journal: "JRN-MANUAL-COLLISION",
        source: "JOURNAL",
        account: "MASTER_FX_CLEARING",
        direction: "Credit",
        currency: "USD",
        amountMinor: 99,
        postedAt: manualPostedAt,
      },
      ...(externalCollisionSeedState.ledger || []),
    ];
    externalCollisionSeedState.transfers = [
      {
        id: "TR-EXTERNAL-JOURNAL-COLLISION",
        recordKey: "TR-EXTERNAL-JOURNAL-COLLISION",
        journal: "JRN-TRANSFER-COLLISION",
        from: "Master",
        to: otherBroker.name,
        currency: "USD",
        amountMinor: 77,
        createdAt: manualPostedAt,
      },
      ...(externalCollisionSeedState.transfers || []),
    ];
    const externalCollisionSeeded = await requestOk(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: { state: externalCollisionSeedState, expectedRevision: equalPairRoundTrip.data.revision },
    });

    const externalCollisionPaymentView = await requestOk(baseUrl, "/api/app-state", { cookie: agentSignup.cookie });
    const externalCollisionPaymentState = structuredClone(externalCollisionPaymentView.data.state);
    const externalPaidAt = new Date(Date.now() + 13_000).toISOString();
    const externalCollisionOrders = [
      [manualCollisionOrder.id, "JRN-MANUAL-COLLISION"],
      [transferCollisionOrder.id, "JRN-TRANSFER-COLLISION"],
    ].map(([orderId, journal]) => {
      const order = externalCollisionPaymentState.orders.find((item) => item.id === orderId);
      Object.assign(order, { state: "Paid", journal, paidAt: externalPaidAt, updatedAt: externalPaidAt });
      return order;
    });
    externalCollisionPaymentState.ledger = [
      ...orderPaymentLines(externalCollisionOrders[0], broker, agent),
      ...orderPaymentLines(externalCollisionOrders[1], broker, agent),
      ...(externalCollisionPaymentState.ledger || []),
    ];
    const externalCollisionPaid = await requestOk(baseUrl, "/api/app-state", {
      cookie: agentSignup.cookie,
      method: "PUT",
      body: { state: externalCollisionPaymentState, expectedRevision: externalCollisionPaymentView.data.revision },
    });
    const storedManualCollisionOrder = externalCollisionPaid.data.state.orders.find((order) => order.id === manualCollisionOrder.id);
    const storedTransferCollisionOrder = externalCollisionPaid.data.state.orders.find((order) => order.id === transferCollisionOrder.id);
    assert.equal(storedManualCollisionOrder.journal, "JRN-MANUAL-COLLISION (1)");
    assert.equal(storedTransferCollisionOrder.journal, "JRN-TRANSFER-COLLISION (1)");
    assert.equal(externalCollisionPaid.data.state.ledger
      .filter((line) => line.orderId === manualCollisionOrder.id && line.source === "ORDER_PAYMENT")
      .every((line) => line.journal === storedManualCollisionOrder.journal), true);
    assert.equal(externalCollisionPaid.data.state.ledger
      .filter((line) => line.orderId === transferCollisionOrder.id && line.source === "ORDER_PAYMENT")
      .every((line) => line.journal === storedTransferCollisionOrder.journal), true);
    const externalCollisionMasterView = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    assert.equal(externalCollisionMasterView.data.state.ledger
      .filter((line) => line.source === "JOURNAL" && line.journal === "JRN-MANUAL-COLLISION").length, 2);
    assert.equal(externalCollisionMasterView.data.state.transfers
      .some((transfer) => transfer.id === "TR-EXTERNAL-JOURNAL-COLLISION" && transfer.journal === "JRN-TRANSFER-COLLISION"), true);

    const atomicCollisionOrder = {
      ...orderFixture({ id: "ORD-ATOMIC-MANUAL-COLLISION", broker, agent, agentActorId: agent.id }),
      sourceAmountMinor: 6_300,
      payoutAmountMinor: 126_000,
      grossMinor: 6_300,
    };
    const atomicSeedState = structuredClone(externalCollisionMasterView.data.state);
    atomicSeedState.orders.unshift(atomicCollisionOrder);
    const atomicSeeded = await requestOk(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: { state: atomicSeedState, expectedRevision: externalCollisionMasterView.data.revision },
    });
    const atomicPaymentState = structuredClone(atomicSeeded.data.state);
    const atomicStoredOrder = atomicPaymentState.orders.find((order) => order.id === atomicCollisionOrder.id);
    const atomicRequestedJournal = "JRN-ATOMIC-MANUAL-COLLISION";
    const atomicClientPaidAt = "2097-01-01T00:00:00.000Z";
    Object.assign(atomicStoredOrder, {
      state: "Paid",
      journal: atomicRequestedJournal,
      paidAt: atomicClientPaidAt,
      updatedAt: atomicClientPaidAt,
    });
    const atomicManualPostedAt = new Date(Date.now() + 14_000).toISOString();
    atomicPaymentState.ledger = [
      ...orderPaymentLines(atomicStoredOrder, broker, agent),
      {
        journal: atomicRequestedJournal,
        source: "JOURNAL",
        account: `${broker.name} ACTOR_CLEARING`,
        direction: "Debit",
        currency: "USD",
        amountMinor: 88,
        postedAt: atomicManualPostedAt,
      },
      {
        journal: atomicRequestedJournal,
        source: "JOURNAL",
        account: "MASTER_FX_CLEARING",
        direction: "Credit",
        currency: "USD",
        amountMinor: 88,
        postedAt: atomicManualPostedAt,
      },
      ...(atomicPaymentState.ledger || []),
    ];
    const atomicCollisionPaid = await requestOk(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: { state: atomicPaymentState, expectedRevision: atomicSeeded.data.revision },
    });
    const atomicPaidOrder = atomicCollisionPaid.data.state.orders.find((order) => order.id === atomicCollisionOrder.id);
    assert.equal(atomicPaidOrder.journal, `${atomicRequestedJournal} (1)`);
    assert.equal(atomicCollisionPaid.data.state.ledger.filter((line) =>
      line.source === "ORDER_PAYMENT" && line.orderId === atomicCollisionOrder.id
    ).every((line) => line.journal === atomicPaidOrder.journal), true);
    assert.equal(atomicCollisionPaid.data.state.ledger.filter((line) =>
      line.source === "JOURNAL" && line.journal === atomicRequestedJournal
    ).length, 2);
  } finally {
    if (processHandle.exitCode === null) {
      processHandle.kill();
      await new Promise((resolve) => processHandle.once("exit", resolve));
    }
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
