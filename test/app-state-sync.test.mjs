import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

async function waitForServer(baseUrl, serverProcess, stderr) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`Test server stopped before startup.${stderr ? `\n${stderr}` : ""}`);
    }
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Test server did not start.${stderr ? `\n${stderr}` : ""}`);
}

async function requestJson(baseUrl, pathname, { cookie = "", method = "GET", body } = {}) {
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
  assert.equal(response.ok, true, data.error || `${method} ${pathname} failed`);
  const setCookie = response.headers.get("set-cookie") || "";
  return { data, cookie: setCookie.split(";", 1)[0] || cookie, setCookie };
}

async function requestError(baseUrl, pathname, { cookie = "", method = "GET", body } = {}) {
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
  assert.equal(response.ok, false, `${method} ${pathname} unexpectedly succeeded`);
  return { status: response.status, data };
}

test("Owner Master name and Gmail controls are available on web and Android", async () => {
  const [index, preview, mobileClient, mobileScreens] = await Promise.all([
    readFile(path.join(repositoryRoot, "index.html"), "utf8"),
    readFile(path.join(repositoryRoot, "preview.html"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/api/client.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/screens/WorkspaceScreens.tsx"), "utf8"),
  ]);
  assert.equal(index, preview);
  assert.match(index, /class="btn secondary change-master-name"/);
  assert.match(index, /class="btn secondary change-master-email"/);
  assert.match(index, /api\("\/api\/owner\/masters\/name"/);
  assert.match(index, /api\("\/api\/owner\/masters\/email"/);
  assert.match(mobileClient, /export async function updateOwnerMasterName/);
  assert.match(mobileClient, /export async function updateOwnerMasterEmail/);
  assert.match(mobileScreens, /label="Change Name"/);
  assert.match(mobileScreens, /label="Change Gmail"/);
});

test("expired subscription viewing controls are available on web and Android", async () => {
  const [index, preview, mobileApp, mobileClient, mobileTypes] = await Promise.all([
    readFile(path.join(repositoryRoot, "index.html"), "utf8"),
    readFile(path.join(repositoryRoot, "preview.html"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/App.tsx"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/api/client.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/types.ts"), "utf8"),
  ]);
  assert.equal(index, preview);
  assert.match(index, /subscriptionIsReadOnly/);
  assert.match(index, /Workspace is read-only/);
  assert.match(index, /report exports are disabled/);
  assert.match(mobileApp, /subscriptionReadOnlyWarning/);
  assert.match(mobileApp, /Report export is disabled/);
  assert.match(mobileClient, /subscriptionReadOnlyGraceMs/);
  assert.match(mobileClient, /session\.subscriptionReadOnly !== true/);
  assert.match(mobileTypes, /subscriptionGraceEndsAt\?: string/);
});

test("workspace revision checks stay read-only and detect saved changes", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "haderapay-sync-"));
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const ownerPassword = crypto.randomBytes(18).toString("base64url");
  const masterPassword = crypto.randomBytes(12).toString("base64url");
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
  serverProcess.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    await waitForServer(baseUrl, serverProcess, stderr);
    const databasePath = path.join(dataDirectory, "auth-db.json");

    const ownerLogin = await requestJson(baseUrl, "/api/auth/login", {
      method: "POST",
      body: { email: "Owner", password: ownerPassword },
    });
    const createdMaster = await requestJson(baseUrl, "/api/owner/masters", {
      cookie: ownerLogin.cookie,
      method: "POST",
      body: {
        name: "Sync Test Master",
        email: "sync-test@example.com",
        password: masterPassword,
        currency: "LYD",
        plan: "one_month",
      },
    });
    assert.equal(createdMaster.data.user.currency, "LYD");
    const masterLogin = await requestJson(baseUrl, "/api/auth/login", {
      method: "POST",
      body: { email: "sync-test@example.com", password: masterPassword },
    });
    assert.equal(masterLogin.data.session.membership.currency, "LYD");
    const mismatchedPasswordChange = await requestError(baseUrl, "/api/auth/password", {
      cookie: masterLogin.cookie,
      method: "POST",
      body: {
        currentPassword: masterPassword,
        newPassword: `${masterPassword}-changed`,
        confirmNewPassword: `${masterPassword}-different`,
      },
    });
    assert.equal(mismatchedPasswordChange.status, 400);
    assert.equal(mismatchedPasswordChange.data.error, "New password and confirmation must match.");
    const invite = await requestJson(baseUrl, "/api/invites", {
      cookie: masterLogin.cookie,
      method: "POST",
      body: { actorRole: "Special Broker", currency: "LYD", workingCurrencies: [] },
    });
    assert.equal(invite.data.invite.currency, "LYD");
    assert.equal(invite.data.invite.workingCurrencies.includes("LYD"), true);

    const masterRowsBeforeEmailChange = await requestJson(baseUrl, "/api/owner/masters", {
      cookie: ownerLogin.cookie,
    });
    const masterBeforeEmailChange = masterRowsBeforeEmailChange.data.users.find(
      (user) => user.userId === createdMaster.data.user.id
    );
    assert.ok(masterBeforeEmailChange);

    const unauthorizedEmailChange = await requestError(baseUrl, "/api/owner/masters/email", {
      cookie: masterLogin.cookie,
      method: "POST",
      body: { userId: createdMaster.data.user.id, email: "not-owner@example.com" },
    });
    assert.equal(unauthorizedEmailChange.status, 403);

    const invalidEmailChange = await requestError(baseUrl, "/api/owner/masters/email", {
      cookie: ownerLogin.cookie,
      method: "POST",
      body: { userId: createdMaster.data.user.id, email: "not-an-email" },
    });
    assert.equal(invalidEmailChange.status, 400);

    const changedMasterEmail = await requestJson(baseUrl, "/api/owner/masters/email", {
      cookie: ownerLogin.cookie,
      method: "POST",
      body: { userId: createdMaster.data.user.id, email: "Changed-Master@Example.com" },
    });
    assert.equal(changedMasterEmail.data.updated, true);
    assert.equal(changedMasterEmail.data.user.email, "changed-master@example.com");

    const currentMasterSession = await requestJson(baseUrl, "/api/session", {
      cookie: masterLogin.cookie,
    });
    assert.equal(currentMasterSession.data.session.user.id, createdMaster.data.user.id);
    assert.equal(currentMasterSession.data.session.user.email, "changed-master@example.com");
    assert.equal(currentMasterSession.data.session.workspace.name, masterBeforeEmailChange.workspace);

    const masterRowsAfterEmailChange = await requestJson(baseUrl, "/api/owner/masters", {
      cookie: ownerLogin.cookie,
    });
    const masterAfterEmailChange = masterRowsAfterEmailChange.data.users.find(
      (user) => user.userId === createdMaster.data.user.id
    );
    assert.deepEqual(
      { ...masterAfterEmailChange, email: masterBeforeEmailChange.email },
      masterBeforeEmailChange
    );

    const unauthorizedNameChange = await requestError(baseUrl, "/api/owner/masters/name", {
      cookie: masterLogin.cookie,
      method: "POST",
      body: { userId: createdMaster.data.user.id, name: "Not Owner Rename" },
    });
    assert.equal(unauthorizedNameChange.status, 403);

    const invalidNameChange = await requestError(baseUrl, "/api/owner/masters/name", {
      cookie: ownerLogin.cookie,
      method: "POST",
      body: { userId: createdMaster.data.user.id, name: "   " },
    });
    assert.equal(invalidNameChange.status, 400);

    const changedMasterName = await requestJson(baseUrl, "/api/owner/masters/name", {
      cookie: ownerLogin.cookie,
      method: "POST",
      body: { userId: createdMaster.data.user.id, name: "Updated Master Name" },
    });
    assert.equal(changedMasterName.data.updated, true);
    assert.equal(changedMasterName.data.user.name, "Updated Master Name");
    assert.equal(changedMasterName.data.user.email, "changed-master@example.com");

    const renamedMasterSession = await requestJson(baseUrl, "/api/session", {
      cookie: masterLogin.cookie,
    });
    assert.equal(renamedMasterSession.data.session.user.name, "Updated Master Name");
    assert.equal(renamedMasterSession.data.session.user.email, "changed-master@example.com");
    assert.equal(renamedMasterSession.data.session.workspace.name, masterBeforeEmailChange.workspace);

    const masterRowsAfterNameChange = await requestJson(baseUrl, "/api/owner/masters", {
      cookie: ownerLogin.cookie,
    });
    const masterAfterNameChange = masterRowsAfterNameChange.data.users.find(
      (user) => user.userId === createdMaster.data.user.id
    );
    assert.deepEqual(
      { ...masterAfterNameChange, name: masterAfterEmailChange.name },
      masterAfterEmailChange
    );

    const oldEmailLogin = await requestError(baseUrl, "/api/auth/login", {
      method: "POST",
      body: { email: "sync-test@example.com", password: masterPassword },
    });
    assert.equal(oldEmailLogin.status, 401);
    const newEmailLogin = await requestJson(baseUrl, "/api/auth/login", {
      method: "POST",
      body: { email: "changed-master@example.com", password: masterPassword },
    });
    assert.equal(newEmailLogin.data.session.user.id, createdMaster.data.user.id);
    assert.equal(newEmailLogin.data.session.user.name, "Updated Master Name");
    assert.equal(newEmailLogin.data.session.membership.currency, "LYD");

    const invitesAfterEmailChange = await requestJson(baseUrl, "/api/invites", {
      cookie: masterLogin.cookie,
    });
    assert.equal(invitesAfterEmailChange.data.invites.some((item) => item.id === invite.data.invite.id), true);

    const initialVersion = await requestJson(baseUrl, "/api/app-state/version", { cookie: masterLogin.cookie });

    const neverTimeout = await requestJson(baseUrl, "/api/auth/timeout", {
      cookie: masterLogin.cookie,
      method: "PUT",
      body: { idleTimeoutSeconds: 0 },
    });
    assert.equal(neverTimeout.data.idleTimeoutSeconds, 0);
    assert.equal(neverTimeout.data.session.user.idleTimeoutSeconds, 0);
    assert.match(neverTimeout.setCookie, /Max-Age=315360000/);

    const neverDatabase = JSON.parse(await readFile(databasePath, "utf8"));
    const neverSessionId = decodeURIComponent(masterLogin.cookie.split("=", 2)[1]);
    const neverSessionRecord = neverDatabase.sessions.find((item) => item.id === neverSessionId);
    assert.ok(neverSessionRecord);
    neverSessionRecord.lastActivityAt = "2000-01-01T00:00:00.000Z";
    neverSessionRecord.expiresAt = "2000-01-01T00:00:01.000Z";
    await writeFile(databasePath, JSON.stringify(neverDatabase, null, 2));

    const neverSessionStillActive = await requestJson(baseUrl, "/api/session", { cookie: masterLogin.cookie });
    assert.equal(neverSessionStillActive.data.session.user.id, createdMaster.data.user.id);
    assert.equal(neverSessionStillActive.data.session.user.idleTimeoutSeconds, 0);

    const finiteTimeout = await requestJson(baseUrl, "/api/auth/timeout", {
      cookie: masterLogin.cookie,
      method: "PUT",
      body: { idleTimeoutSeconds: 7200 },
    });
    assert.equal(finiteTimeout.data.session.user.idleTimeoutSeconds, 7200);
    assert.match(finiteTimeout.setCookie, /Max-Age=7200/);

    const beforeStateRead = await stat(databasePath, { bigint: true });
    const initialState = await requestJson(baseUrl, "/api/app-state", { cookie: masterLogin.cookie });
    const afterStateRead = await stat(databasePath, { bigint: true });

    assert.equal(afterStateRead.mtimeNs, beforeStateRead.mtimeNs);
    assert.equal(initialState.data.revision, initialVersion.data.revision);
    assert.equal(initialState.data.state.actors.some((actor) => actor.role === "Master" && actor.currency === "LYD"), true);

    initialState.data.state.syncTestMarker = "changed";
    const saved = await requestJson(baseUrl, "/api/app-state", {
      cookie: masterLogin.cookie,
      method: "PUT",
      body: { state: initialState.data.state },
    });
    assert.notEqual(saved.data.revision, initialVersion.data.revision);
    assert.equal(saved.data.state.syncTestMarker, "changed");

    const beforeVersionRead = await stat(databasePath, { bigint: true });
    const changedVersion = await requestJson(baseUrl, "/api/app-state/version", { cookie: masterLogin.cookie });
    const afterVersionRead = await stat(databasePath, { bigint: true });

    assert.equal(changedVersion.data.revision, saved.data.revision);
    assert.equal(afterVersionRead.mtimeNs, beforeVersionRead.mtimeNs);

    const clearableForwardingFields = [
      "forwardedPayoutDivider",
      "forwardedPayoutPercent",
      "manualSpecialPayoutDivider",
      "manualSpecialPayoutPercent",
      "manualMasterRateDivider",
      "manualMasterRatePercent",
    ];
    const stateWithForwardingTerms = structuredClone(saved.data.state);
    const forwardingOrder = {
      id: "ORD-SYNC-FORWARDING",
      broker: "Galaxy Broker",
      agent: "Galaxy Payer",
      sourceCurrency: "USD",
      payoutCurrency: "ETB",
      sourceAmountMinor: 10_000,
      payoutAmountMinor: 1_000_000,
      commissionMinor: 1_550,
      commissionPercent: 15.5,
      state: "Assigned",
      createdAt: new Date(Date.now() + 30_000).toISOString(),
      updatedAt: new Date(Date.now() + 60_000).toISOString(),
      forwardedPayoutDivider: 2,
      forwardedPayoutPercent: 15.5,
      manualSpecialPayoutDivider: 3,
      manualSpecialPayoutPercent: 4,
      manualMasterRateDivider: 5,
      manualMasterRatePercent: 6,
    };
    stateWithForwardingTerms.orders = [
      forwardingOrder,
      ...(stateWithForwardingTerms.orders || []).filter((order) => order.id !== forwardingOrder.id),
    ];
    const savedForwardingTerms = await requestJson(baseUrl, "/api/app-state", {
      cookie: masterLogin.cookie,
      method: "PUT",
      body: { state: stateWithForwardingTerms },
    });
    const clearedForwardingState = structuredClone(savedForwardingTerms.data.state);
    const clearedForwardingOrder = clearedForwardingState.orders.find((order) => order.id === forwardingOrder.id);
    assert.ok(clearedForwardingOrder);
    clearableForwardingFields.forEach((field) => delete clearedForwardingOrder[field]);
    clearedForwardingOrder.updatedAt = new Date(Date.now() + 120_000).toISOString();
    const savedClearedTerms = await requestJson(baseUrl, "/api/app-state", {
      cookie: masterLogin.cookie,
      method: "PUT",
      body: { state: clearedForwardingState },
    });
    const persistedClearedOrder = savedClearedTerms.data.state.orders.find((order) => order.id === forwardingOrder.id);
    assert.ok(persistedClearedOrder);
    clearableForwardingFields.forEach((field) => {
      assert.equal(Object.prototype.hasOwnProperty.call(persistedClearedOrder, field), false, `${field} must stay cleared`);
    });
    assert.equal(persistedClearedOrder.commissionPercent, 15.5, "Clearing payer terms must preserve the Broker commission");
    assert.equal(persistedClearedOrder.commissionMinor, 1_550);

    const reloadedClearedState = await requestJson(baseUrl, "/api/app-state", { cookie: masterLogin.cookie });
    const reloadedClearedOrder = reloadedClearedState.data.state.orders.find((order) => order.id === forwardingOrder.id);
    assert.ok(reloadedClearedOrder);
    clearableForwardingFields.forEach((field) => {
      assert.equal(Object.prototype.hasOwnProperty.call(reloadedClearedOrder, field), false, `${field} must remain cleared after reload`);
    });

    const setSubscriptionExpiry = async (expiresAt) => {
      const database = JSON.parse(await readFile(databasePath, "utf8"));
      const masterUser = database.users.find((user) => user.id === createdMaster.data.user.id);
      assert.ok(masterUser);
      masterUser.subscriptionExpiresAt = expiresAt;
      await writeFile(databasePath, JSON.stringify(database, null, 2));
    };

    const dayMs = 24 * 60 * 60 * 1000;
    const expiredTenDaysAgo = new Date(Date.now() - 10 * dayMs).toISOString();
    await setSubscriptionExpiry(expiredTenDaysAgo);

    const readOnlyLogin = await requestJson(baseUrl, "/api/auth/login", {
      method: "POST",
      body: { email: "changed-master@example.com", password: masterPassword },
    });
    assert.equal(readOnlyLogin.data.session.subscription.expired, true);
    assert.equal(readOnlyLogin.data.session.subscription.readOnly, true);
    assert.equal(readOnlyLogin.data.session.subscription.accessDenied, false);
    assert.equal(
      new Date(readOnlyLogin.data.session.subscription.graceEndsAt).getTime(),
      new Date(expiredTenDaysAgo).getTime() + 30 * dayMs
    );

    const readOnlyState = await requestJson(baseUrl, "/api/app-state", { cookie: readOnlyLogin.cookie });
    assert.equal(readOnlyState.data.state.syncTestMarker, "changed");

    const blockedStateWrite = await requestError(baseUrl, "/api/app-state", {
      cookie: readOnlyLogin.cookie,
      method: "PUT",
      body: { state: { ...readOnlyState.data.state, syncTestMarker: "must-not-save" } },
    });
    assert.equal(blockedStateWrite.status, 403);
    assert.equal(blockedStateWrite.data.code, "SUBSCRIPTION_READ_ONLY");

    const blockedInvite = await requestError(baseUrl, "/api/invites", {
      cookie: readOnlyLogin.cookie,
      method: "POST",
      body: { actorRole: "Broker", currency: "USD", workingCurrencies: [] },
    });
    assert.equal(blockedInvite.status, 403);

    const blockedInviteSignup = await requestError(baseUrl, "/api/auth/signup", {
      method: "POST",
      body: {
        name: "Read Only Actor",
        email: "read-only-actor@example.com",
        password: crypto.randomBytes(12).toString("base64url"),
        inviteCode: invite.data.invite.code,
        role: "Actor",
      },
    });
    assert.equal(blockedInviteSignup.status, 403);
    assert.equal(blockedInviteSignup.data.code, "SUBSCRIPTION_READ_ONLY");

    const stateAfterBlockedWrite = await requestJson(baseUrl, "/api/app-state", { cookie: readOnlyLogin.cookie });
    assert.equal(stateAfterBlockedWrite.data.state.syncTestMarker, "changed");

    await setSubscriptionExpiry(new Date(Date.now() - 31 * dayMs).toISOString());
    const deniedLogin = await requestError(baseUrl, "/api/auth/login", {
      method: "POST",
      body: { email: "changed-master@example.com", password: masterPassword },
    });
    assert.equal(deniedLogin.status, 402);

    const deniedExistingSession = await requestError(baseUrl, "/api/app-state", { cookie: readOnlyLogin.cookie });
    assert.equal(deniedExistingSession.status, 402);

    const deniedSessionCheck = await requestJson(baseUrl, "/api/session", { cookie: readOnlyLogin.cookie });
    assert.equal(deniedSessionCheck.data.session, null);
  } finally {
    if (serverProcess.exitCode === null) {
      serverProcess.kill();
      await new Promise((resolve) => serverProcess.once("exit", resolve));
    }
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
