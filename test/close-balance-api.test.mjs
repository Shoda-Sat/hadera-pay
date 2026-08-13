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
    if (serverProcess.exitCode !== null) {
      throw new Error(`Test server stopped before startup.\n${readStderr()}`);
    }
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

function cancelledOrder(id, actor, timestamp) {
  return {
    id,
    internalOrderId: id,
    brokerOrderNumber: id,
    brokerActorId: actor.id,
    broker: actor.name,
    agentActorId: "",
    agent: "Cancelled",
    state: "Cancelled",
    sourceCurrency: "USD",
    payoutCurrency: "ETB",
    sourceAmountMinor: 12_300,
    payoutAmountMinor: 2_460_000,
    commissionMinor: 0,
    grossMinor: 12_300,
    createdAt: timestamp,
    updatedAt: timestamp,
    cancelledAt: timestamp,
    cancelledBy: actor.name,
  };
}

test("Master close API archives or permanently omits cancelled orders without changing accounting", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "haderapay-close-api-"));
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
        name: "Cancelled Close Master",
        email: "cancelled-close-master@example.com",
        password: masterPassword,
        currency: "USD",
        plan: "one_month",
      },
    });
    const masterLogin = await requestOk(baseUrl, "/api/auth/login", {
      method: "POST",
      body: { email: "cancelled-close-master@example.com", password: masterPassword },
    });
    const invite = await requestOk(baseUrl, "/api/invites", {
      cookie: masterLogin.cookie,
      method: "POST",
      body: { actorRole: "Broker", currency: "USD", workingCurrencies: [] },
    });
    const actorSignup = await requestOk(baseUrl, "/api/auth/signup", {
      method: "POST",
      body: {
        name: "Cancelled Close Broker",
        email: "cancelled-close-broker@example.com",
        password: actorPassword,
        inviteCode: invite.data.invite.code,
        role: "Actor",
      },
    });

    const initial = await requestOk(baseUrl, "/api/app-state", { cookie: masterLogin.cookie });
    const actor = initial.data.state.actors.find((item) => item.id === invite.data.invite.actorId);
    assert.ok(actor);

    const invalidPolicy = await request(baseUrl, "/api/app-state/close-balance", {
      cookie: masterLogin.cookie,
      method: "POST",
      body: { actorId: actor.id, cancelledOrderPolicy: "delete", expectedRevision: initial.data.revision },
    });
    assert.equal(invalidPolicy.response.status, 400);

    const actorAttempt = await request(baseUrl, "/api/app-state/close-balance", {
      cookie: actorSignup.cookie,
      method: "POST",
      body: { actorId: actor.id, cancelledOrderPolicy: "include", expectedRevision: initial.data.revision },
    });
    assert.equal(actorAttempt.response.status, 403);

    const includeTimestamp = new Date(Date.now() - 2_000).toISOString();
    const includeFixture = structuredClone(initial.data.state);
    includeFixture.orders = [cancelledOrder("ORD-CANCEL-INCLUDE", actor, includeTimestamp), ...(includeFixture.orders || [])];
    const savedInclude = await requestOk(baseUrl, "/api/app-state", {
      cookie: masterLogin.cookie,
      method: "PUT",
      body: { state: includeFixture },
    });
    const staleIncludeState = structuredClone(savedInclude.data.state);

    const included = await requestOk(baseUrl, "/api/app-state/close-balance", {
      cookie: masterLogin.cookie,
      method: "POST",
      body: {
        actorId: actor.id,
        actorName: actor.name,
        cancelledOrderPolicy: "include",
        expectedRevision: savedInclude.data.revision,
      },
    });
    assert.equal(included.data.cancelledOrderCount, 1);
    assert.equal(included.data.includedCancelledOrderCount, 1);
    assert.equal(included.data.state.orders.some((order) => order.id === "ORD-CANCEL-INCLUDE"), false);
    const includeArchive = included.data.state.archives.find((archive) => archive.id === included.data.archiveId);
    assert.ok(includeArchive);
    assert.deepEqual(includeArchive.balances, {});
    assert.deepEqual(includeArchive.ledger, []);
    assert.equal(includeArchive.incomeProfitMinor, 0);
    assert.equal(includeArchive.orders[0].state, "Cancelled");
    assert.equal(includeArchive.orders[0].excludedFromCalculations, true);
    assert.equal(included.data.state.deletedOrderIds.includes("ORD-CANCEL-INCLUDE"), true);

    const duplicateClose = await request(baseUrl, "/api/app-state/close-balance", {
      cookie: masterLogin.cookie,
      method: "POST",
      body: { actorId: actor.id, cancelledOrderPolicy: "include", expectedRevision: included.data.revision },
    });
    assert.equal(duplicateClose.response.status, 409);

    const staleIncludeSave = await request(baseUrl, "/api/app-state", {
      cookie: masterLogin.cookie,
      method: "PUT",
      body: { state: staleIncludeState },
    });
    assert.equal(staleIncludeSave.response.status, 409);
    const afterStaleInclude = await requestOk(baseUrl, "/api/app-state", { cookie: masterLogin.cookie });
    assert.equal(afterStaleInclude.data.state.orders.some((order) => order.id === "ORD-CANCEL-INCLUDE"), false);
    assert.equal(afterStaleInclude.data.state.archives.filter((archive) => archive.id === includeArchive.id).length, 1);

    const omitTimestamp = new Date().toISOString();
    const omitFixture = structuredClone(afterStaleInclude.data.state);
    omitFixture.orders = [cancelledOrder("ORD-CANCEL-OMIT", actor, omitTimestamp), ...(omitFixture.orders || [])];
    const savedOmit = await requestOk(baseUrl, "/api/app-state", {
      cookie: masterLogin.cookie,
      method: "PUT",
      body: { state: omitFixture },
    });
    const staleOmitState = structuredClone(savedOmit.data.state);

    const omitted = await requestOk(baseUrl, "/api/app-state/close-balance", {
      cookie: masterLogin.cookie,
      method: "POST",
      body: {
        actorId: actor.id,
        cancelledOrderPolicy: "omit",
        expectedRevision: savedOmit.data.revision,
      },
    });
    assert.equal(omitted.data.cancelledOrderCount, 1);
    assert.equal(omitted.data.omittedCancelledOrderCount, 1);
    assert.equal(omitted.data.state.orders.some((order) => order.id === "ORD-CANCEL-OMIT"), false);
    assert.equal(omitted.data.state.deletedOrderIds.includes("ORD-CANCEL-OMIT"), true);
    const omitArchive = omitted.data.state.archives.find((archive) => archive.id === omitted.data.archiveId);
    assert.ok(omitArchive);
    assert.deepEqual(omitArchive.orders, []);
    assert.deepEqual(omitArchive.balances, {});
    assert.deepEqual(omitArchive.ledger, []);
    assert.equal(omitArchive.incomeProfitMinor, 0);

    const staleOmitSave = await request(baseUrl, "/api/app-state", {
      cookie: masterLogin.cookie,
      method: "PUT",
      body: { state: staleOmitState },
    });
    assert.equal(staleOmitSave.response.status, 409);
    const finalState = await requestOk(baseUrl, "/api/app-state", { cookie: masterLogin.cookie });
    assert.equal(finalState.data.state.orders.some((order) => order.id === "ORD-CANCEL-OMIT"), false);
    assert.equal(finalState.data.state.deletedOrderIds.includes("ORD-CANCEL-OMIT"), true);
    assert.equal(finalState.data.state.archives.filter((archive) => archive.id === omitArchive.id).length, 1);
    assert.notEqual(includeArchive.id, omitArchive.id);

    const raceFixture = structuredClone(finalState.data.state);
    raceFixture.orders = [cancelledOrder("ORD-CANCEL-RACE", actor, new Date().toISOString()), ...(raceFixture.orders || [])];
    const savedRace = await requestOk(baseUrl, "/api/app-state", {
      cookie: masterLogin.cookie,
      method: "PUT",
      body: { state: raceFixture, expectedRevision: finalState.data.revision },
    });
    const stalePromptClose = await request(baseUrl, "/api/app-state/close-balance", {
      cookie: masterLogin.cookie,
      method: "POST",
      body: {
        actorId: actor.id,
        cancelledOrderPolicy: "include",
        expectedRevision: finalState.data.revision,
      },
    });
    assert.equal(stalePromptClose.response.status, 409, "A cancellation saved after the prompt must force Master to choose again.");
    const afterRaceConflict = await requestOk(baseUrl, "/api/app-state", { cookie: masterLogin.cookie });
    assert.equal(afterRaceConflict.data.revision, savedRace.data.revision);
    assert.equal(afterRaceConflict.data.state.orders.some((order) => order.id === "ORD-CANCEL-RACE"), true);
  } finally {
    if (serverProcess.exitCode === null) {
      serverProcess.kill();
      await new Promise((resolve) => serverProcess.once("exit", resolve));
    }
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
