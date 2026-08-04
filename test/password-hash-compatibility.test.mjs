import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function passwordHash(password, iterations, modern) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("hex");
  return modern ? `pbkdf2-sha256$${iterations}$${salt}$${hash}` : `${salt}:${hash}`;
}

async function unusedPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(baseUrl, serverProcess, stderr) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (serverProcess.exitCode !== null) throw new Error(`Test server stopped before startup.\n${stderr()}`);
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // The test server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Test server did not start.\n${stderr()}`);
}

test("login accepts password hashes created before and after the rolled-back security update", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "haderapay-password-compat-"));
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const modernPassword = "Modern-password-123";
  const legacyPassword = "Legacy-password-123";
  const expiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const database = {
    users: [
      { id: "user-modern", name: "Modern Master", email: "modern@example.com", passwordHash: passwordHash(modernPassword, 600000, true), active: true, subscriptionExpiresAt: expiry },
      { id: "user-legacy", name: "Legacy Actor", email: "legacy@example.com", passwordHash: passwordHash(legacyPassword, 120000, false), active: true },
    ],
    workspaces: [{ id: "workspace-1", name: "Compatibility", ownerUserId: "user-modern" }],
    memberships: [
      { id: "membership-modern", userId: "user-modern", workspaceId: "workspace-1", role: "Master", actorId: "actor-modern", actorName: "Modern Master", actorRole: "Master", currency: "USD" },
      { id: "membership-legacy", userId: "user-legacy", workspaceId: "workspace-1", role: "Actor", actorId: "actor-legacy", actorName: "Legacy Actor", actorRole: "Broker", currency: "USD" },
    ],
    invites: [],
    sessions: [],
    appStates: { "workspace-1": {} },
    files: [],
    ownerPasswordHash: "",
    loginAttempts: {},
  };
  await writeFile(path.join(dataDirectory, "auth-db.json"), JSON.stringify(database));

  let serverError = "";
  const serverProcess = spawn(process.execPath, ["server.mjs"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      DATA_DIR: dataDirectory,
      HOST: "127.0.0.1",
      PORT: String(port),
      OWNER_PASSWORD: "Test-owner-password-123",
    },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  serverProcess.stderr.setEncoding("utf8");
  serverProcess.stderr.on("data", (chunk) => {
    serverError += chunk;
  });

  try {
    await waitForServer(baseUrl, serverProcess, () => serverError);
    for (const credentials of [
      { email: "modern@example.com", password: modernPassword },
      { email: "legacy@example.com", password: legacyPassword },
    ]) {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credentials),
      });
      const result = await response.json();
      assert.equal(response.status, 200, result.error);
      assert.equal(result.session.user.email, credentials.email);
    }
  } finally {
    if (serverProcess.exitCode === null) {
      serverProcess.kill();
      await new Promise((resolve) => serverProcess.once("exit", resolve));
    }
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
