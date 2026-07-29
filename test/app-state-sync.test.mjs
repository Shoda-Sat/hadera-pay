import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
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
  return { data, cookie: response.headers.get("set-cookie")?.split(";", 1)[0] || cookie };
}

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
    const invite = await requestJson(baseUrl, "/api/invites", {
      cookie: masterLogin.cookie,
      method: "POST",
      body: { actorRole: "Special Broker", currency: "LYD", workingCurrencies: [] },
    });
    assert.equal(invite.data.invite.currency, "LYD");
    assert.equal(invite.data.invite.workingCurrencies.includes("LYD"), true);

    const initialVersion = await requestJson(baseUrl, "/api/app-state/version", { cookie: masterLogin.cookie });
    const databasePath = path.join(dataDirectory, "auth-db.json");
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
  } finally {
    if (serverProcess.exitCode === null) {
      serverProcess.kill();
      await new Promise((resolve) => serverProcess.once("exit", resolve));
    }
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
