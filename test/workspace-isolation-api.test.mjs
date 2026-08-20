import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { siemGalaxyIsolationRepairId } from "../src/workspaceIsolation.mjs";

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
  return {
    response,
    data: await response.json(),
    cookie: (response.headers.get("set-cookie") || "").split(";", 1)[0] || cookie,
  };
}

async function requestOk(baseUrl, pathname, options) {
  const result = await request(baseUrl, pathname, options);
  assert.equal(result.response.ok, true, result.data.error || `${options?.method || "GET"} ${pathname} failed`);
  return result;
}

test("the live API repairs and persists Siem-to-Galaxy leakage and blocks future cross-workspace saves", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "haderapay-workspace-isolation-"));
  const databasePath = path.join(dataDirectory, "auth-db.json");
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const ownerPassword = crypto.randomBytes(18).toString("base64url");
  const masterPassword = crypto.randomBytes(14).toString("base64url");
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
    for (const master of [
      { name: "Siem", email: "siem-isolation@example.com" },
      { name: "Galaxy", email: "galaxy-isolation@example.com" },
    ]) {
      await requestOk(baseUrl, "/api/owner/masters", {
        cookie: owner.cookie,
        method: "POST",
        body: { ...master, password: masterPassword, currency: "USD", plan: "one_month" },
      });
    }
    const siem = await requestOk(baseUrl, "/api/auth/login", {
      method: "POST",
      body: { email: "siem-isolation@example.com", password: masterPassword },
    });
    const galaxy = await requestOk(baseUrl, "/api/auth/login", {
      method: "POST",
      body: { email: "galaxy-isolation@example.com", password: masterPassword },
    });
    const siemWorkspaceId = siem.data.session.workspace.id;
    const galaxyWorkspaceId = galaxy.data.session.workspace.id;

    const siemInitial = await requestOk(baseUrl, "/api/app-state", { cookie: siem.cookie });
    const siemActor = {
      id: "ACT-SIEM-LEAK",
      name: "Siem Private Broker",
      role: "Broker",
      currency: "USD",
      active: true,
      managedByMaster: true,
      transferEnabled: true,
      transferMode: "master",
    };
    const siemState = structuredClone(siemInitial.data.state);
    siemState.actors.push(siemActor);
    const savedSiem = await requestOk(baseUrl, "/api/app-state", {
      cookie: siem.cookie,
      method: "PUT",
      body: { state: siemState, expectedRevision: siemInitial.data.revision },
    });
    const canonicalSiemActor = savedSiem.data.state.actors.find((actor) => actor.id === siemActor.id);
    assert.equal(canonicalSiemActor.workspaceId, siemWorkspaceId);

    const galaxyInitial = await requestOk(baseUrl, "/api/app-state", { cookie: galaxy.cookie });
    const database = JSON.parse(await readFile(databasePath, "utf8"));
    const leakedActor = { ...canonicalSiemActor };
    delete leakedActor.workspaceId;
    const closedArchive = {
      id: "ARC-CLOSED-FOREIGN",
      actor: leakedActor.name,
      actorId: leakedActor.id,
      balances: { USD: 900 },
      ledger: [{ journal: "JRN-CLOSED", account: `${leakedActor.name} ACTOR_CLEARING`, archived: true }],
      orders: [],
      receivables: [],
      transfers: [],
    };
    database.appStates[galaxyWorkspaceId] = {
      ...database.appStates[galaxyWorkspaceId],
      actors: [...galaxyInitial.data.state.actors.map((actor) => ({ ...actor, workspaceId: undefined })), leakedActor],
      ledger: [
        {
          journal: "JRN-FOREIGN",
          entryId: "JRN-FOREIGN",
          source: "JOURNAL",
          account: `${leakedActor.name} ACTOR_CLEARING`,
          direction: "Debit",
          currency: "USD",
          amountMinor: 1_200,
        },
        {
          journal: "JRN-FOREIGN",
          entryId: "JRN-FOREIGN",
          source: "JOURNAL",
          account: "MASTER_JOURNAL_CLEARING",
          direction: "Credit",
          currency: "USD",
          amountMinor: 1_200,
        },
        {
          journal: "JRN-CLOSED",
          entryId: "JRN-CLOSED",
          source: "ORDER_PAYMENT",
          account: `${leakedActor.name} ACTOR_CLEARING`,
          direction: "Debit",
          currency: "USD",
          amountMinor: 900,
          archived: true,
        },
      ],
      settlements: [{ actor: leakedActor.name, currency: "USD", netMinor: 1_200 }],
      archives: [closedArchive],
      _syncRevision: galaxyInitial.data.revision,
    };
    await writeFile(databasePath, JSON.stringify(database, null, 2));

    const repaired = await requestOk(baseUrl, "/api/app-state", { cookie: galaxy.cookie });
    assert.equal(repaired.data.state.actors.some((actor) => actor.name === leakedActor.name), false);
    assert.deepEqual(repaired.data.state.ledger.map((line) => line.journal), ["JRN-CLOSED"]);
    assert.deepEqual(repaired.data.state.archives, [closedArchive]);
    assert.equal(repaired.data.state.settlements.some((item) => item.actor === leakedActor.name), false);
    const audit = repaired.data.state.workspaceIsolationRepairs.find((item) => item.id === siemGalaxyIsolationRepairId);
    assert.equal(audit.balanceMerged, true);
    assert.equal(audit.removedLedgerLineCount, 2);
    assert.equal(audit.closedReportsChanged, false);

    const persisted = JSON.parse(await readFile(databasePath, "utf8"));
    assert.equal(persisted.appStates[galaxyWorkspaceId].actors.some((actor) => actor.name === leakedActor.name), false);
    assert.deepEqual(persisted.appStates[galaxyWorkspaceId].archives, [closedArchive]);

    const forged = await request(baseUrl, "/api/app-state", {
      cookie: galaxy.cookie,
      method: "PUT",
      body: {
        state: { ...repaired.data.state, _workspaceId: siemWorkspaceId },
        expectedRevision: repaired.data.revision,
      },
    });
    assert.equal(forged.response.status, 409);
    assert.match(forged.data.error, /belongs to another workspace/i);

    const siemAfter = await requestOk(baseUrl, "/api/app-state", { cookie: siem.cookie });
    assert.equal(siemAfter.data.state.actors.some((actor) => actor.id === siemActor.id), true);
  } finally {
    serverProcess.kill();
    await new Promise((resolve) => serverProcess.once("exit", resolve));
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
