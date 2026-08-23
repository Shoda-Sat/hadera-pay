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
    if (serverProcess.exitCode !== null) {
      throw new Error(`Test server stopped before startup.\n${readStderr()}`);
    }
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

async function createActorAccount(baseUrl, masterCookie, {
  name,
  email,
  password,
  actorRole,
  currency,
}) {
  const invite = await requestOk(baseUrl, "/api/invites", {
    cookie: masterCookie,
    method: "POST",
    body: { actorRole, currency, workingCurrencies: [currency] },
  });
  return requestOk(baseUrl, "/api/auth/signup", {
    method: "POST",
    body: {
      name,
      email,
      password,
      inviteCode: invite.data.invite.code,
      role: "Actor",
    },
  });
}

test("routing attempt IDs survive Broker submission, Master forwarding, and authoritative replay", { timeout: 30_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "haderapay-routing-attempt-"));
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
        name: "Routing Attempt Master",
        email: "routing-attempt-master@example.com",
        password: masterPassword,
        currency: "USD",
        plan: "one_month",
      },
    });
    const masterLogin = await requestOk(baseUrl, "/api/auth/login", {
      method: "POST",
      body: { email: "routing-attempt-master@example.com", password: masterPassword },
    });
    const brokerSignup = await createActorAccount(baseUrl, masterLogin.cookie, {
      name: "Routing Broker",
      email: "routing-attempt-broker@example.com",
      password: brokerPassword,
      actorRole: "Broker",
      currency: "USD",
    });
    const agentSignup = await createActorAccount(baseUrl, masterLogin.cookie, {
      name: "Routing Agent",
      email: "routing-attempt-agent@example.com",
      password: agentPassword,
      actorRole: "Agent",
      currency: "ETB",
    });

    const brokerActorId = brokerSignup.data.session.membership.actorId;
    const agentActorId = agentSignup.data.session.membership.actorId;
    assert.ok(brokerActorId);
    assert.ok(agentActorId);

    const brokerState = await requestOk(baseUrl, "/api/app-state", { cookie: brokerSignup.cookie });
    const submittedAt = new Date().toISOString();
    const orderId = `ORD-ROUTING-${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
    const routingSubmissionId = `ROUTE-SUB-${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
    const pendingOrder = {
      id: orderId,
      brokerActorId,
      broker: "Routing Broker",
      brokerOrderNumber: "RTG001",
      brokerOrderNumberCycle: 0,
      agentActorId: "",
      agent: "Unassigned",
      sourceCurrency: "USD",
      payoutCurrency: "ETB",
      sourceAmountMinor: 12_500,
      payoutAmountMinor: 2_500_000,
      commissionMinor: 250,
      commissionPercent: 2,
      grossMinor: 12_750,
      orderCommissionLiability: "Broker",
      rate: 200,
      senderName: "Routing Sender",
      receiverName: "Routing Receiver",
      accountNumber: "ROUTING-ACCOUNT-1",
      fundingType: "cash",
      state: "Pending Forward",
      journal: "",
      routingSubmissionId,
      createdAt: submittedAt,
      sentAt: submittedAt,
      updatedAt: submittedAt,
    };
    const brokerSubmissionState = structuredClone(brokerState.data.state);
    brokerSubmissionState.orders = [
      pendingOrder,
      ...(brokerSubmissionState.orders || []).filter((order) => order.id !== orderId),
    ];
    const submitted = await requestOk(baseUrl, "/api/app-state", {
      cookie: brokerSignup.cookie,
      method: "PUT",
      body: {
        state: brokerSubmissionState,
        expectedRevision: brokerState.data.revision,
      },
    });
    const storedPendingOrder = submitted.data.state.orders.find((order) => order.id === orderId);
    assert.ok(storedPendingOrder);
    assert.equal(storedPendingOrder.routingSubmissionId, routingSubmissionId);
    assert.equal(storedPendingOrder.state, "Pending Forward");
    assert.equal(storedPendingOrder.brokerActorId, brokerActorId);
    assert.equal(storedPendingOrder.agentActorId, "");

    const masterState = await requestOk(baseUrl, "/api/app-state", { cookie: masterLogin.cookie });
    const masterForwardState = structuredClone(masterState.data.state);
    const orderToForward = masterForwardState.orders.find((order) => order.id === orderId);
    assert.ok(orderToForward);
    const routingForwardAttemptId = `ROUTE-FWD-${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
    const assignedAt = new Date(Date.now() + 1).toISOString();
    orderToForward.state = "Assigned";
    orderToForward.agent = "Routing Agent";
    orderToForward.agentActorId = agentActorId;
    orderToForward.routingForwardAttemptId = routingForwardAttemptId;
    orderToForward.forwardedPayoutDivider = 2.5;
    orderToForward.forwardedPayoutPercent = 1.75;
    orderToForward.assignedAt = assignedAt;
    orderToForward.updatedAt = assignedAt;

    const forwarded = await requestOk(baseUrl, "/api/app-state", {
      cookie: masterLogin.cookie,
      method: "PUT",
      body: {
        state: masterForwardState,
        expectedRevision: masterState.data.revision,
      },
    });
    const storedAssignedOrder = forwarded.data.state.orders.find((order) => order.id === orderId);
    assert.ok(storedAssignedOrder);
    assert.equal(storedAssignedOrder.state, "Assigned");
    assert.equal(storedAssignedOrder.routingSubmissionId, routingSubmissionId);
    assert.equal(storedAssignedOrder.routingForwardAttemptId, routingForwardAttemptId);
    assert.equal(storedAssignedOrder.agentActorId, agentActorId);
    assert.equal(storedAssignedOrder.agent, "Routing Agent");
    assert.equal(storedAssignedOrder.forwardedPayoutDivider, 2.5);
    assert.equal(storedAssignedOrder.forwardedPayoutPercent, 1.75);
    assert.equal(storedAssignedOrder.sourceAmountMinor, 12_500);
    assert.equal(storedAssignedOrder.payoutAmountMinor, 2_500_000);

    const authoritativeOrderCount = forwarded.data.state.orders.filter((order) => order.id === orderId).length;
    const replayed = await requestOk(baseUrl, "/api/app-state", {
      cookie: masterLogin.cookie,
      method: "PUT",
      body: {
        state: structuredClone(forwarded.data.state),
        expectedRevision: forwarded.data.revision,
      },
    });
    const replayedMatches = replayed.data.state.orders.filter((order) =>
      order.id === orderId || order.routingSubmissionId === routingSubmissionId
    );
    assert.equal(authoritativeOrderCount, 1);
    assert.equal(replayedMatches.length, 1);
    assert.equal(replayedMatches[0].routingSubmissionId, routingSubmissionId);
    assert.equal(replayedMatches[0].routingForwardAttemptId, routingForwardAttemptId);
    assert.equal(replayedMatches[0].agentActorId, agentActorId);
    assert.equal(replayedMatches[0].forwardedPayoutDivider, 2.5);
    assert.equal(replayedMatches[0].forwardedPayoutPercent, 1.75);

    const reloaded = await requestOk(baseUrl, "/api/app-state", { cookie: masterLogin.cookie });
    assert.equal(reloaded.data.state.orders.filter((order) =>
      order.id === orderId || order.routingSubmissionId === routingSubmissionId
    ).length, 1);
  } finally {
    if (serverProcess.exitCode === null) {
      serverProcess.kill();
      await new Promise((resolve) => serverProcess.once("exit", resolve));
    }
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
