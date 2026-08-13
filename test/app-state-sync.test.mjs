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

test("new web and Android records use collision-safe hidden IDs", async () => {
  const [index, preview, mobileClient] = await Promise.all([
    readFile(path.join(repositoryRoot, "index.html"), "utf8"),
    readFile(path.join(repositoryRoot, "preview.html"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/api/client.ts"), "utf8"),
  ]);
  assert.equal(index, preview);
  assert.match(index, /return collisionSafeRecordId\("ORD", state\.orderCounter\)/);
  assert.match(index, /return collisionSafeRecordId\("REC", state\.receivableCounter\)/);
  assert.match(mobileClient, /return collisionSafeRecordId\("ORD", nextNumber\)/);
  assert.match(mobileClient, /return collisionSafeRecordId\("REC", nextNumber\)/);
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

    const fixedCommissionInvite = await requestJson(baseUrl, "/api/invites", {
      cookie: masterLogin.cookie,
      method: "POST",
      body: { actorRole: "Broker", currency: "USD", workingCurrencies: [] },
    });
    const fixedCommissionActorPassword = crypto.randomBytes(12).toString("base64url");
    const fixedCommissionActorSignup = await requestJson(baseUrl, "/api/auth/signup", {
      method: "POST",
      body: {
        name: "Fixed Commission Broker",
        email: "fixed-commission-broker@example.com",
        password: fixedCommissionActorPassword,
        inviteCode: fixedCommissionInvite.data.invite.code,
        role: "Actor",
      },
    });
    assert.equal(fixedCommissionActorSignup.data.session.membership.actorRole, "Broker");

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

    const fixedCommissionActorId = fixedCommissionActorSignup.data.session.membership.actorId;
    const stateWithFixedCommission = structuredClone(saved.data.state);
    const fixedCommissionActor = stateWithFixedCommission.actors.find((actor) => actor.id === fixedCommissionActorId);
    assert.ok(fixedCommissionActor);
    fixedCommissionActor.orderFixedRates = { ETB: { enabled: true, rate: 200 } };
    fixedCommissionActor.orderFixedCommission = { enabled: true, percent: -2 };
    const savedFixedCommission = await requestJson(baseUrl, "/api/app-state", {
      cookie: masterLogin.cookie,
      method: "PUT",
      body: { state: stateWithFixedCommission },
    });
    assert.deepEqual(
      savedFixedCommission.data.state.actors.find((actor) => actor.id === fixedCommissionActorId)?.orderFixedCommission,
      { enabled: true, percent: -2 }
    );
    const actorState = await requestJson(baseUrl, "/api/app-state", { cookie: fixedCommissionActorSignup.cookie });
    const actorTamperState = structuredClone(actorState.data.state);
    const actorTamperRecord = actorTamperState.actors.find((actor) => actor.id === fixedCommissionActorId);
    assert.ok(actorTamperRecord);
    actorTamperRecord.orderFixedRates = { ETB: { enabled: false, rate: 999 } };
    actorTamperRecord.orderFixedCommission = { enabled: false, percent: 99 };
    actorTamperState.orders = [
      {
        id: "ORD-FIXED-COMMISSION",
        brokerActorId: "ACT-SPOOFED",
        broker: "Spoofed Broker",
        agent: "Unassigned",
        sourceCurrency: "USD",
        payoutCurrency: "ETB",
        sourceAmountMinor: 10_000,
        payoutAmountMinor: 2_000_000,
        commissionPercent: 5,
        commissionMinor: 500,
        grossMinor: 10_500,
        orderCommissionLiability: "Broker",
        rate: 200,
        state: "Pending Forward",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      ...(actorTamperState.orders || []).filter((order) => order.id !== "ORD-FIXED-COMMISSION"),
    ];
    const actorProtectedSave = await requestJson(baseUrl, "/api/app-state", {
      cookie: fixedCommissionActorSignup.cookie,
      method: "PUT",
      body: { state: actorTamperState },
    });
    const protectedActor = actorProtectedSave.data.state.actors.find((actor) => actor.id === fixedCommissionActorId);
    assert.deepEqual(protectedActor.orderFixedRates, { ETB: { enabled: true, rate: 200 } });
    assert.deepEqual(protectedActor.orderFixedCommission, { enabled: true, percent: -2 });
    const protectedOrder = actorProtectedSave.data.state.orders.find((order) => order.id === "ORD-FIXED-COMMISSION");
    assert.equal(protectedOrder.brokerActorId, fixedCommissionActorId);
    assert.equal(protectedOrder.broker, "Fixed Commission Broker");
    assert.equal(protectedOrder.commissionPercent, -2);
    assert.equal(protectedOrder.commissionMinor, -200);
    assert.equal(protectedOrder.grossMinor, 9_800);
    assert.equal(protectedOrder.orderCommissionLiability, "Master");

    const collisionFixtureState = structuredClone(actorProtectedSave.data.state);
    const originalCollisionOrder = collisionFixtureState.orders.find((order) => order.id === "ORD-FIXED-COMMISSION");
    assert.ok(originalCollisionOrder);
    originalCollisionOrder.brokerOrderNumber = "FIX001";
    originalCollisionOrder.journal = "JRN-COLLISION-ORIGINAL";
    originalCollisionOrder.updatedAt = new Date(Date.now() + 5_000).toISOString();
    collisionFixtureState.receivables = [
      {
        id: "REC-COLLISION-ORIGINAL",
        orderId: "ORD-FIXED-COMMISSION",
        brokerOrderNumber: "FIX001",
        borrower: "Fixed Commission Broker",
        borrowerActorId: fixedCommissionActorId,
        currency: "USD",
        principalMinor: 10_000,
        payments: [],
        createdAt: originalCollisionOrder.createdAt,
        updatedAt: originalCollisionOrder.updatedAt,
      },
      ...(collisionFixtureState.receivables || []),
    ];
    collisionFixtureState.ledger = [
      {
        journal: "JRN-COLLISION-ORIGINAL",
        orderId: "ORD-FIXED-COMMISSION",
        source: "ORDER_PAYMENT",
        account: "Fixed Commission Broker ACTOR_CLEARING",
        direction: "Debit",
        currency: "USD",
        amountMinor: 10_000,
        postedAt: originalCollisionOrder.updatedAt,
      },
      ...(collisionFixtureState.ledger || []),
    ];
    collisionFixtureState.chatConversations = [
      {
        id: "CHAT-COLLISION-SCOPE",
        type: "direct",
        name: "Collision scope",
        members: ["Master", "Fixed Commission Broker"],
        createdAt: originalCollisionOrder.createdAt,
        messages: [{
          id: "MSG-COLLISION-ORIGINAL",
          from: "Master",
          text: "Original order message",
          orderId: "ORD-FIXED-COMMISSION",
          orderNumber: "FIX001",
          createdAt: originalCollisionOrder.updatedAt,
        }],
      },
      ...(collisionFixtureState.chatConversations || []),
    ];
    const savedCollisionFixture = await requestJson(baseUrl, "/api/app-state", {
      cookie: masterLogin.cookie,
      method: "PUT",
      body: { state: collisionFixtureState },
    });

    const actorCollisionState = structuredClone(savedCollisionFixture.data.state);
    actorCollisionState.orders = [
      {
        id: "ORD-FIXED-COMMISSION",
        brokerActorId: "ACT-SPOOFED-COLLISION",
        broker: "Spoofed Collision Broker",
        brokerOrderNumber: "FIX002",
        agent: "Unassigned",
        sourceCurrency: "USD",
        payoutCurrency: "ETB",
        sourceAmountMinor: 20_000,
        payoutAmountMinor: 4_000_000,
        commissionPercent: 8,
        commissionMinor: 1_600,
        grossMinor: 21_600,
        orderCommissionLiability: "Broker",
        rate: 200,
        journal: "JRN-COLLISION-NEW",
        state: "Pending Forward",
        createdAt: new Date(Date.now() + 10_000).toISOString(),
        updatedAt: new Date(Date.now() + 10_000).toISOString(),
      },
      ...(actorCollisionState.orders || []),
    ];
    actorCollisionState.receivables = [
      {
        id: "REC-COLLISION-NEW",
        orderId: "ORD-FIXED-COMMISSION",
        brokerOrderNumber: "FIX002",
        borrower: "Spoofed Collision Broker",
        borrowerActorId: "ACT-SPOOFED-COLLISION",
        currency: "USD",
        principalMinor: 20_000,
        payments: [],
        createdAt: actorCollisionState.orders[0].createdAt,
        updatedAt: actorCollisionState.orders[0].updatedAt,
      },
      ...(actorCollisionState.receivables || []),
    ];
    actorCollisionState.ledger = [
      {
        journal: "JRN-COLLISION-NEW",
        orderId: "ORD-FIXED-COMMISSION",
        source: "ORDER_PAYMENT",
        account: "Spoofed Collision Broker ACTOR_CLEARING",
        direction: "Debit",
        currency: "USD",
        amountMinor: 20_000,
        postedAt: actorCollisionState.orders[0].updatedAt,
      },
      ...(actorCollisionState.ledger || []),
    ];
    const collisionConversation = actorCollisionState.chatConversations.find((chat) => chat.id === "CHAT-COLLISION-SCOPE");
    assert.ok(collisionConversation);
    collisionConversation.messages.push({
      id: "MSG-COLLISION-NEW",
      from: "Fixed Commission Broker",
      text: "New colliding order message",
      orderId: "ORD-FIXED-COMMISSION",
      orderNumber: "FIX002",
      createdAt: actorCollisionState.orders[0].updatedAt,
    });
    const actorCollisionSave = await requestJson(baseUrl, "/api/app-state", {
      cookie: fixedCommissionActorSignup.cookie,
      method: "PUT",
      body: { state: actorCollisionState },
    });
    const collisionOrder = actorCollisionSave.data.state.orders.find((order) => order.brokerOrderNumber === "FIX002");
    assert.ok(collisionOrder);
    assert.notEqual(collisionOrder.id, "ORD-FIXED-COMMISSION");
    assert.equal(collisionOrder.brokerActorId, fixedCommissionActorId);
    assert.equal(collisionOrder.broker, "Fixed Commission Broker");
    assert.equal(collisionOrder.commissionPercent, -2);
    assert.equal(collisionOrder.commissionMinor, -400);
    assert.equal(collisionOrder.grossMinor, 19_600);
    assert.equal(collisionOrder.orderCommissionLiability, "Master");
    assert.equal(actorCollisionSave.data.state.orders.some((order) => order.id === "ORD-FIXED-COMMISSION" && order.brokerOrderNumber === "FIX001"), true);
    assert.equal(actorCollisionSave.data.state.receivables.find((item) => item.id === "REC-COLLISION-ORIGINAL")?.orderId, "ORD-FIXED-COMMISSION");
    assert.equal(actorCollisionSave.data.state.receivables.find((item) => item.id === "REC-COLLISION-NEW")?.orderId, collisionOrder.id);
    assert.equal(actorCollisionSave.data.state.ledger.find((line) => line.journal === "JRN-COLLISION-ORIGINAL")?.orderId, "ORD-FIXED-COMMISSION");
    assert.equal(actorCollisionSave.data.state.ledger.find((line) => line.journal === "JRN-COLLISION-NEW")?.orderId, collisionOrder.id);
    const savedCollisionConversation = actorCollisionSave.data.state.chatConversations.find((chat) => chat.id === "CHAT-COLLISION-SCOPE");
    assert.equal(savedCollisionConversation?.messages.find((message) => message.id === "MSG-COLLISION-ORIGINAL")?.orderId, "ORD-FIXED-COMMISSION");
    assert.equal(savedCollisionConversation?.messages.find((message) => message.id === "MSG-COLLISION-NEW")?.orderId, collisionOrder.id);

    const clearableForwardingFields = [
      "forwardedPayoutDivider",
      "forwardedPayoutPercent",
      "manualSpecialPayoutDivider",
      "manualSpecialPayoutPercent",
      "manualMasterRateDivider",
      "manualMasterRatePercent",
    ];
    const stateWithForwardingTerms = structuredClone(actorCollisionSave.data.state);
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

    const collisionBaseState = structuredClone(reloadedClearedState.data.state);
    const goitomCreatedAt = "2026-08-06T16:30:48.000Z";
    const goitomState = structuredClone(collisionBaseState);
    goitomState.orders = [
      {
        id: "ORD-900",
        brokerActorId: "ACT-GOITOM",
        broker: "Goitom",
        brokerOrderNumber: "GOI001",
        senderName: "Goitom Sender",
        receiverName: "Goitom Receiver",
        accountNumber: "GOITOM-ACCOUNT",
        sourceCurrency: "EUR",
        sourceAmountMinor: 10_000,
        payoutCurrency: "EUR",
        payoutAmountMinor: 10_000,
        fundingType: "credit",
        state: "Pending Forward",
        createdAt: goitomCreatedAt,
        updatedAt: goitomCreatedAt,
      },
      ...(goitomState.orders || []).filter((order) => order.id !== "ORD-900"),
    ];
    goitomState.receivables = [
      {
        id: "REC-900",
        orderId: "ORD-900",
        brokerOrderNumber: "GOI001",
        borrowerActorId: "ACT-GOITOM",
        borrower: "Goitom",
        receiverName: "Goitom Receiver",
        accountNumber: "GOITOM-ACCOUNT",
        currency: "EUR",
        principalMinor: 10_000,
        payments: [],
        createdAt: goitomCreatedAt,
        updatedAt: goitomCreatedAt,
      },
      ...(goitomState.receivables || []).filter((receivable) => receivable.id !== "REC-900"),
    ];
    const savedGoitomState = await requestJson(baseUrl, "/api/app-state", {
      cookie: masterLogin.cookie,
      method: "PUT",
      body: { state: goitomState },
    });
    assert.ok(savedGoitomState.data.state.orders.find((order) => order.brokerOrderNumber === "GOI001"));

    const lamCreatedAt = "2026-08-06T16:31:12.000Z";
    const staleLamState = structuredClone(collisionBaseState);
    staleLamState.orders = [
      {
        id: "ORD-900",
        brokerActorId: "ACT-LAM",
        broker: "LAM Broker",
        brokerOrderNumber: "LAM007",
        senderName: "LAM Sender",
        receiverName: "LAM Receiver",
        accountNumber: "LAM-ACCOUNT",
        sourceCurrency: "EUR",
        sourceAmountMinor: 20_000,
        payoutCurrency: "EUR",
        payoutAmountMinor: 20_000,
        fundingType: "credit",
        state: "Pending Forward",
        createdAt: lamCreatedAt,
        updatedAt: lamCreatedAt,
      },
      ...(staleLamState.orders || []).filter((order) => order.id !== "ORD-900"),
    ];
    staleLamState.receivables = [
      {
        id: "REC-900",
        orderId: "ORD-900",
        brokerOrderNumber: "LAM007",
        borrowerActorId: "ACT-LAM",
        borrower: "LAM Broker",
        receiverName: "LAM Receiver",
        accountNumber: "LAM-ACCOUNT",
        currency: "EUR",
        principalMinor: 20_000,
        payments: [],
        createdAt: lamCreatedAt,
        updatedAt: lamCreatedAt,
      },
      ...(staleLamState.receivables || []).filter((receivable) => receivable.id !== "REC-900"),
    ];
    staleLamState.ledger = [
      {
        entryId: "COLLISION-LINE-LAM",
        orderId: "ORD-900",
        journal: "COLLISION-JOURNAL-LAM",
        source: "COLLISION_TEST",
        account: "LAM Broker ACTOR_CLEARING",
        direction: "Debit",
        currency: "EUR",
        amountMinor: 20_000,
        postedAt: lamCreatedAt,
      },
      ...(staleLamState.ledger || []).filter((line) => line.entryId !== "COLLISION-LINE-LAM"),
    ];
    staleLamState.chatConversations = [
      {
        id: "CHAT-COLLISION-LAM",
        members: ["Updated Master Name", "LAM Broker"],
        messages: [{ id: "MSG-COLLISION-LAM", orderId: "ORD-900", text: "LAM007", createdAt: lamCreatedAt }],
      },
      ...(staleLamState.chatConversations || []).filter((chat) => chat.id !== "CHAT-COLLISION-LAM"),
    ];
    const recoveredCollision = await requestJson(baseUrl, "/api/app-state", {
      cookie: masterLogin.cookie,
      method: "PUT",
      body: { state: staleLamState, expectedRevision: savedGoitomState.data.revision },
    });
    const recoveredGoitomOrder = recoveredCollision.data.state.orders.find((order) => order.brokerOrderNumber === "GOI001");
    const recoveredLamOrder = recoveredCollision.data.state.orders.find((order) => order.brokerOrderNumber === "LAM007");
    assert.ok(recoveredGoitomOrder);
    assert.ok(recoveredLamOrder);
    assert.equal(recoveredGoitomOrder.id, "ORD-900");
    assert.match(recoveredLamOrder.id, /^ORD-\d+-[A-F0-9]{20}$/);
    assert.notEqual(recoveredLamOrder.id, recoveredGoitomOrder.id);
    assert.equal(recoveredGoitomOrder.receiverName, "Goitom Receiver");
    assert.equal(recoveredGoitomOrder.accountNumber, "GOITOM-ACCOUNT");
    assert.equal(recoveredLamOrder.receiverName, "LAM Receiver");
    assert.equal(recoveredLamOrder.accountNumber, "LAM-ACCOUNT");

    const recoveredGoitomReceivable = recoveredCollision.data.state.receivables.find((item) => item.brokerOrderNumber === "GOI001");
    const recoveredLamReceivable = recoveredCollision.data.state.receivables.find((item) => item.brokerOrderNumber === "LAM007");
    assert.ok(recoveredGoitomReceivable);
    assert.ok(recoveredLamReceivable);
    assert.equal(recoveredGoitomReceivable.id, "REC-900");
    assert.equal(recoveredGoitomReceivable.orderId, recoveredGoitomOrder.id);
    assert.match(recoveredLamReceivable.id, /^REC-\d+-[A-F0-9]{20}$/);
    assert.equal(recoveredLamReceivable.orderId, recoveredLamOrder.id);
    assert.equal(recoveredLamReceivable.borrower, "LAM Broker");
    assert.equal(
      recoveredCollision.data.state.ledger.find((line) => line.entryId === "COLLISION-LINE-LAM")?.orderId,
      recoveredLamOrder.id
    );
    assert.equal(
      recoveredCollision.data.state.chatConversations
        .find((chat) => chat.id === "CHAT-COLLISION-LAM")
        ?.messages.find((message) => message.id === "MSG-COLLISION-LAM")?.orderId,
      recoveredLamOrder.id
    );

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
