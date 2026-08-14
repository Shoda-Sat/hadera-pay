import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

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
      // The test server is still starting.
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

function missingBrokerFixture(initialState, suffix, { includeOpenActor = false } = {}) {
  const payerClosedAt = `2026-08-0${suffix}T13:28:00.000Z`;
  const brokerClosedAt = `2026-08-0${suffix}T16:23:11.000Z`;
  const broker = { id: `ACT-BROKER-${suffix}`, name: `Broker ${suffix}`, role: "Broker", currency: "USD" };
  const payer = { id: `ACT-PAYER-${suffix}`, name: `Payer ${suffix}`, role: "Agent", currency: "USD" };
  const orderId = `ORD-${suffix}`;
  const journal = `JRN-${suffix}`;
  const order = {
    id: orderId,
    internalOrderId: orderId,
    brokerOrderNumber: `BROKER${suffix}`,
    agentOrderNumber: `000${suffix}_BROKER${suffix}`,
    brokerActorId: broker.id,
    agentActorId: payer.id,
    broker: broker.name,
    agent: payer.name,
    sourceCurrency: "USD",
    sourceAmountMinor: 10_150,
    payoutCurrency: "USD",
    payoutAmountMinor: 10_150,
    payerCurrency: "USD",
    payerAmountMinor: 10_150,
    state: "Paid",
    journal,
    actor: payer.name,
    paidAt: payerClosedAt,
    archivedAt: payerClosedAt,
    locked: true,
  };
  const openActor = { id: `ACT-OPEN-${suffix}`, name: `Open ${suffix}`, role: "Agent", currency: "USD" };
  return {
    ...structuredClone(initialState),
    actors: [...(initialState.actors || []), broker, payer, ...(includeOpenActor ? [openActor] : [])],
    orders: [],
    archives: [
      {
        id: `ARC-PAYER-${suffix}`,
        actor: payer.name,
        actorId: payer.id,
        actorRole: payer.role,
        closedAt: payerClosedAt,
        balances: { USD: -10_150 },
        incomeProfitMinor: 0,
        orders: [order],
        ledger: [],
        transfers: [],
        receivables: [],
      },
      {
        id: `ARC-BROKER-${suffix}`,
        actor: broker.name,
        actorId: broker.id,
        actorRole: broker.role,
        closedAt: brokerClosedAt,
        balances: { USD: 10_150 },
        incomeProfitMinor: 0,
        orders: [],
        ledger: [],
        transfers: [],
        receivables: [],
      },
    ],
    ledger: [
      { journal, orderId, source: "ORDER_PAYMENT", account: `${payer.name} ACTOR_CLEARING`, direction: "Credit", currency: "USD", amountMinor: 10_150, archived: true, closedAt: payerClosedAt },
      { journal, orderId, source: "ORDER_PAYMENT", account: `${broker.name} ACTOR_CLEARING`, direction: "Debit", currency: "USD", amountMinor: 10_150, archived: true, closedAt: brokerClosedAt },
      ...(includeOpenActor ? [{ journal: `JRN-OPEN-${suffix}`, orderId: `ORD-OPEN-${suffix}`, source: "ORDER_PAYMENT", account: `${openActor.name} ACTOR_CLEARING`, direction: "Credit", currency: "USD", amountMinor: 500, archived: false }] : []),
    ],
  };
}

test("Owner can safely plan and atomically repair closed reports across workspaces", async () => {
  const [server, index, preview] = await Promise.all([
    readFile(path.join(root, "server.mjs"), "utf8"),
    readFile(path.join(root, "index.html"), "utf8"),
    readFile(path.join(root, "preview.html"), "utf8"),
  ]);

  assert.equal(index, preview, "The deployed web entry points must stay identical.");
  assert.match(server, /backfillAllClosedActorOrderSnapshots/);
  assert.match(server, /\/api\/owner\/repair-order-archives\/plan-all[\s\S]*requireOwner/);
  assert.match(server, /\/api\/owner\/repair-order-archives\/apply-all[\s\S]*requireOwner/);
  assert.match(server, /applyOwnerOrderArchiveRepairs[\s\S]*enqueueDbWrite/);
  assert.match(server, /readFile\(dbPath\)[\s\S]*planDigest[\s\S]*expectedCount !== plan\.candidateCount/);
  assert.match(server, /validateWorkspaceWideOrderArchiveRepair[\s\S]*orderArchiveRepairInvariantState/);
  assert.match(server, /beforeOrders[\s\S]*afterOrders\.slice\(0, beforeOrders\.length\)/);
  assert.match(server, /backfillAllClosedActorOrderSnapshots\(result\.state\)[\s\S]*repairedCount !== 0/);
  assert.match(server, /createOrderArchiveRepairBackup\(rawDatabase[\s\S]*writePersistedDbAtomic\(latestDb\)/);
  assert.match(server, /decipher\.setAuthTag[\s\S]*restoredDatabase\.equals\(rawDatabase\)/);

  assert.match(index, /id="ownerOrderArchiveRepairButton"/);
  assert.match(index, /Check All Closed Reports/);
  assert.match(index, /Unclosed Actors are skipped/);
  assert.match(index, /expectedCount: Number\(plan\.candidateCount\)/);
  assert.match(index, /planDigest: plan\.planDigest/);
  assert.match(index, /Create Backup & Restore/);
  assert.match(index, /not ledger balances, settlements, income, or closed totals/i);
});

test("Owner plan scans multiple workspaces, skips unclosed Actors, and Master cannot use it", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "haderapay-global-report-repair-"));
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const ownerPassword = crypto.randomBytes(18).toString("base64url");
  const masterPassword = crypto.randomBytes(14).toString("base64url");
  let stderr = "";
  const serverProcess = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: { ...process.env, DATA_DIR: dataDirectory, HOST: "127.0.0.1", PORT: String(port), OWNER_PASSWORD: ownerPassword },
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
    const masterSessions = [];
    for (const suffix of [1, 2]) {
      const email = `global-repair-master-${suffix}@example.com`;
      await requestOk(baseUrl, "/api/owner/masters", {
        cookie: owner.cookie,
        method: "POST",
        body: { name: `Global Repair Master ${suffix}`, email, password: masterPassword, currency: "USD", plan: "one_month" },
      });
      const master = await requestOk(baseUrl, "/api/auth/login", {
        method: "POST",
        body: { email, password: masterPassword },
      });
      const initial = await requestOk(baseUrl, "/api/app-state", { cookie: master.cookie });
      const fixture = missingBrokerFixture(initial.data.state, suffix, { includeOpenActor: suffix === 1 });
      await requestOk(baseUrl, "/api/app-state", {
        cookie: master.cookie,
        method: "PUT",
        body: { state: fixture, expectedRevision: initial.data.revision },
      });
      masterSessions.push(master.cookie);
    }

    const forbidden = await request(baseUrl, "/api/owner/repair-order-archives/plan-all", {
      cookie: masterSessions[0],
      method: "POST",
      body: {},
    });
    assert.equal(forbidden.response.status, 403);

    const plan = await requestOk(baseUrl, "/api/owner/repair-order-archives/plan-all", {
      cookie: owner.cookie,
      method: "POST",
      body: {},
    });
    assert.equal(plan.data.candidateCount, 2);
    assert.equal(plan.data.eligibleWorkspaceCount, 2);
    assert.equal(plan.data.affectedActorCount, 2);
    assert.equal(plan.data.blockedActorCount, 0);
    assert.equal(plan.data.closedActorCount, 4);
    assert.equal(plan.data.unclosedActorCount, 1);
    assert.equal(plan.data.privateBackupReady, false);
    assert.equal(plan.data.canApply, false);

    const staleApply = await request(baseUrl, "/api/owner/repair-order-archives/apply-all", {
      cookie: owner.cookie,
      method: "POST",
      body: { expectedCount: plan.data.candidateCount, planDigest: "stale-plan" },
    });
    assert.equal(staleApply.response.status, 409);

    const noBackupApply = await request(baseUrl, "/api/owner/repair-order-archives/apply-all", {
      cookie: owner.cookie,
      method: "POST",
      body: { expectedCount: plan.data.candidateCount, planDigest: plan.data.planDigest },
    });
    assert.equal(noBackupApply.response.status, 503);
    for (const cookie of masterSessions) {
      const after = await requestOk(baseUrl, "/api/app-state", { cookie });
      const brokerArchive = after.data.state.archives.find((archive) => String(archive.id || "").startsWith("ARC-BROKER-"));
      assert.deepEqual(brokerArchive.orders, [], "A failed backup gate must leave every workspace unchanged.");
    }
  } finally {
    if (serverProcess.exitCode === null) {
      serverProcess.kill();
      await new Promise((resolve) => serverProcess.once("exit", resolve));
    }
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
