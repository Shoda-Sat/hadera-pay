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

async function requestOk(baseUrl, pathname, options) {
  const result = await request(baseUrl, pathname, options);
  assert.equal(result.response.ok, true, result.data.error || `${options?.method || "GET"} ${pathname} failed`);
  return result;
}

function openingLines(state, actorName) {
  return state.ledger
    .filter((line) => line.source === "PREVIOUS_CLOSE" && line.details === `Previous Close for ${actorName}`)
    .map((line) => ({
      account: line.account,
      direction: line.direction,
      currency: line.currency,
      amountMinor: line.amountMinor,
    }));
}

function settlement(state, actor, currency) {
  return state.settlements.find((item) => item.actor === actor && item.currency === currency)?.netMinor;
}

test("real server retains a paid order until both participant balances close and rejects resurrection", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "haderapay-participant-retention-api-"));
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

    const owner = await requestOk(baseUrl, "/api/auth/login", {
      method: "POST",
      body: { email: "Owner", password: ownerPassword },
    });
    await requestOk(baseUrl, "/api/owner/masters", {
      cookie: owner.cookie,
      method: "POST",
      body: {
        name: "Retention Master",
        email: "retention-master@example.com",
        password: masterPassword,
        currency: "USD",
        plan: "one_month",
      },
    });
    const master = await requestOk(baseUrl, "/api/auth/login", {
      method: "POST",
      body: { email: "retention-master@example.com", password: masterPassword },
    });

    const brokerInvite = await requestOk(baseUrl, "/api/invites", {
      cookie: master.cookie,
      method: "POST",
      body: { actorRole: "Broker", currency: "EUR", workingCurrencies: [] },
    });
    const brokerSignup = await requestOk(baseUrl, "/api/auth/signup", {
      method: "POST",
      body: {
        name: "PPP",
        email: "retention-ppp@example.com",
        password: brokerPassword,
        inviteCode: brokerInvite.data.invite.code,
        role: "Actor",
      },
    });
    assert.ok(brokerSignup.cookie);

    const agentInvite = await requestOk(baseUrl, "/api/invites", {
      cookie: master.cookie,
      method: "POST",
      body: { actorRole: "Agent", currency: "ETB", workingCurrencies: [] },
    });
    const agentSignup = await requestOk(baseUrl, "/api/auth/signup", {
      method: "POST",
      body: {
        name: "Retention Agent",
        email: "retention-agent@example.com",
        password: agentPassword,
        inviteCode: agentInvite.data.invite.code,
        role: "Actor",
      },
    });
    assert.ok(agentSignup.cookie);

    const initial = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    const broker = initial.data.state.actors.find((actor) => actor.id === brokerInvite.data.invite.actorId);
    const agent = initial.data.state.actors.find((actor) => actor.id === agentInvite.data.invite.actorId);
    assert.equal(broker?.name, "PPP");
    assert.equal(agent?.name, "Retention Agent");

    const orderId = "ORD-RETENTION-EUR500";
    const journal = "JRN-2000";
    const paidAt = "2026-08-15T09:45:00.000Z";
    const fixture = structuredClone(initial.data.state);
    fixture.orders = [{
      id: orderId,
      internalOrderId: orderId,
      brokerOrderNumber: "PPP500",
      brokerActorId: broker.id,
      agentOrderNumber: "0001_PPP500",
      agentOrderNumbers: { [agent.name]: "0001_PPP500" },
      agentActorId: agent.id,
      broker: broker.name,
      agent: agent.name,
      sourceCurrency: "EUR",
      sourceAmountMinor: 50_000,
      payoutCurrency: "ETB",
      payoutAmountMinor: 98_500,
      state: "Paid",
      journal,
      createdAt: "2026-08-15T09:30:00.000Z",
      paidAt,
      incomeBaseCurrency: "USD",
      incomeBaseAmountMinor: 57_500,
      incomeCollectedCurrency: "EUR",
      incomeCollectedOriginalMinor: 50_000,
      incomeCollectedUsdMinor: 60_000,
      incomeProfitMinor: 2_500,
    }];
    fixture.ledger = [
      { journal, orderId, source: "ORDER_PAYMENT", account: `${broker.name} ACTOR_CLEARING`, direction: "Debit", currency: "EUR", amountMinor: 50_000, postedAt: paidAt },
      { journal, orderId, source: "ORDER_PAYMENT", account: "MASTER_FX_CLEARING", direction: "Credit", currency: "EUR", amountMinor: 50_000, postedAt: paidAt },
      { journal, orderId, source: "ORDER_PAYMENT", account: "MASTER_FX_CLEARING", direction: "Debit", currency: "ETB", amountMinor: 98_500, postedAt: paidAt },
      { journal, orderId, source: "ORDER_PAYMENT", account: `${agent.name} ACTOR_CLEARING`, direction: "Credit", currency: "ETB", amountMinor: 98_500, postedAt: paidAt },
    ];
    fixture.settlements = [
      { actor: broker.name, currency: "EUR", netMinor: 50_000 },
      { actor: agent.name, currency: "ETB", netMinor: -98_500 },
    ];
    fixture.journalCounter = 1_000;

    const seeded = await requestOk(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: { state: fixture, expectedRevision: initial.data.revision },
    });
    assert.deepEqual(seeded.data.state.orders.map((order) => order.id), [orderId]);

    const brokerClose = await requestOk(baseUrl, "/api/app-state/close-balance", {
      cookie: master.cookie,
      method: "POST",
      body: {
        actorId: broker.id,
        cancelledOrderPolicy: "omit",
        expectedRevision: seeded.data.revision,
      },
    });
    assert.deepEqual(brokerClose.data.state.orders.map((order) => order.id), [orderId]);
    const brokerArchive = brokerClose.data.state.archives.find((archive) => archive.id === brokerClose.data.archiveId);
    assert.ok(brokerArchive);
    assert.deepEqual(brokerArchive.balances, { EUR: 50_000 });
    assert.deepEqual(brokerArchive.orders.map((order) => order.id), [orderId]);
    const brokerPaymentLine = brokerClose.data.state.ledger.find((line) => line.journal === journal && line.account === `${broker.name} ACTOR_CLEARING`);
    const agentPaymentLine = brokerClose.data.state.ledger.find((line) => line.journal === journal && line.account === `${agent.name} ACTOR_CLEARING`);
    assert.equal(brokerPaymentLine.archived, true);
    assert.equal(agentPaymentLine.archived, undefined);
    assert.deepEqual(openingLines(brokerClose.data.state, broker.name), [
      { account: `${broker.name} ACTOR_CLEARING`, direction: "Debit", currency: "EUR", amountMinor: 50_000 },
      { account: "MASTER_PREVIOUS_CLOSE", direction: "Credit", currency: "EUR", amountMinor: 50_000 },
    ]);
    assert.equal(settlement(brokerClose.data.state, broker.name, "EUR"), 50_000);
    assert.equal(settlement(brokerClose.data.state, agent.name, "ETB"), -98_500);

    const brokerAfterOwnClose = await requestOk(baseUrl, "/api/app-state", { cookie: brokerSignup.cookie });
    assert.equal(
      brokerAfterOwnClose.data.state.orders.some((order) => order.id === orderId),
      false,
      "An Actor must not receive a retained shared order after their own report has archived it."
    );
    assert.equal(
      brokerAfterOwnClose.data.state.archives.flatMap((archive) => archive.orders || []).some((order) => order.id === orderId),
      true,
      "The closed Actor must still receive the immutable report containing the order."
    );
    const brokerSummaryAfterOwnClose = await requestOk(
      baseUrl,
      "/api/app-state?reports=summary&chats=summary",
      { cookie: brokerSignup.cookie }
    );
    assert.equal(
      brokerSummaryAfterOwnClose.data.state.orders.some((order) => order.id === orderId),
      false,
      "Lazy report summaries must also keep the Actor's closed order out of the active response."
    );
    const agentBeforeOwnClose = await requestOk(baseUrl, "/api/app-state", { cookie: agentSignup.cookie });
    assert.equal(
      agentBeforeOwnClose.data.state.orders.some((order) => order.id === orderId),
      true,
      "The same retained order must remain active for the participant who still needs to close it."
    );

    const afterBrokerGet = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    assert.equal(afterBrokerGet.data.revision, brokerClose.data.revision);
    assert.deepEqual(afterBrokerGet.data.state.orders.map((order) => order.id), [orderId], "Server GET normalization must preserve the retained shared order.");
    assert.equal(afterBrokerGet.data.state.ledger.find((line) => line.journal === journal && line.account === `${agent.name} ACTOR_CLEARING`).archived, undefined);
    const staleAfterBroker = structuredClone(afterBrokerGet.data.state);

    const agentClose = await requestOk(baseUrl, "/api/app-state/close-balance", {
      cookie: master.cookie,
      method: "POST",
      body: {
        actorId: agent.id,
        cancelledOrderPolicy: "omit",
        expectedRevision: afterBrokerGet.data.revision,
      },
    });
    assert.equal(agentClose.data.state.orders.some((order) => order.id === orderId), false);
    const agentArchive = agentClose.data.state.archives.find((archive) => archive.id === agentClose.data.archiveId);
    assert.ok(agentArchive);
    assert.deepEqual(agentArchive.balances, { ETB: -98_500 });
    assert.deepEqual(agentArchive.orders.map((order) => order.id), [orderId]);
    assert.equal(agentArchive.orders[0].payerCurrency, "ETB");
    assert.equal(agentArchive.orders[0].payerAmountMinor, 98_500);
    assert.deepEqual(openingLines(agentClose.data.state, agent.name), [
      { account: `${agent.name} ACTOR_CLEARING`, direction: "Credit", currency: "ETB", amountMinor: 98_500 },
      { account: "MASTER_PREVIOUS_CLOSE", direction: "Debit", currency: "ETB", amountMinor: 98_500 },
    ]);
    assert.equal(settlement(agentClose.data.state, broker.name, "EUR"), 50_000);
    assert.equal(settlement(agentClose.data.state, agent.name, "ETB"), -98_500);
    assert.equal(agentClose.data.state.ledger.find((line) => line.journal === journal && line.account === `${agent.name} ACTOR_CLEARING`).archived, true);
    const snapshots = agentClose.data.state.archives
      .flatMap((archive) => archive.orders || [])
      .filter((order) => order.id === orderId);
    assert.equal(snapshots.length, 2);
    assert.deepEqual(new Set(snapshots.map((order) => order.actor)), new Set([broker.name, agent.name]));

    const afterAgentGet = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    assert.equal(afterAgentGet.data.state.orders.some((order) => order.id === orderId), false);
    assert.equal(afterAgentGet.data.state.archives.flatMap((archive) => archive.orders || []).filter((order) => order.id === orderId).length, 2);

    const rejectedStaleRevision = await request(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: { state: staleAfterBroker, expectedRevision: afterBrokerGet.data.revision },
    });
    assert.equal(rejectedStaleRevision.response.status, 409);

    const acceptedCurrentRevision = await requestOk(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: { state: staleAfterBroker, expectedRevision: afterAgentGet.data.revision },
    });
    assert.equal(acceptedCurrentRevision.data.state.orders.some((order) => order.id === orderId), false, "Persisted participant archives must prune a stale live-order payload even with the current revision.");
    assert.equal(acceptedCurrentRevision.data.state.archives.flatMap((archive) => archive.orders || []).filter((order) => order.id === orderId).length, 2);

    const finalState = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
    assert.equal(finalState.data.state.orders.some((order) => order.id === orderId), false);
    assert.equal(finalState.data.state.archives.flatMap((archive) => archive.orders || []).filter((order) => order.id === orderId).length, 2);
  } finally {
    if (serverProcess.exitCode === null) {
      serverProcess.kill();
      await new Promise((resolve) => serverProcess.once("exit", resolve));
    }
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
