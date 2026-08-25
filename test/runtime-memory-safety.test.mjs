import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  const data = await response.json();
  return {
    response,
    data,
    cookie: (response.headers.get("set-cookie") || "").split(";", 1)[0] || cookie,
  };
}

test("runtime persistence bounds queued snapshots and polling cannot overlap", async () => {
  const [server, web, preview, mobile] = await Promise.all([
    readFile(path.join(repositoryRoot, "server.mjs"), "utf8"),
    readFile(path.join(repositoryRoot, "index.html"), "utf8"),
    readFile(path.join(repositoryRoot, "preview.html"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/App.tsx"), "utf8"),
  ]);

  assert.equal(web, preview, "The served and preview web clients must stay identical.");
  assert.match(server, /const maxPendingDbWrites = 3;/);
  assert.match(server, /pendingDbWriteCount >= maxPendingDbWrites/);
  assert.match(server, /const incomingMetadata = \{ \.\.\.\(db \|\| blankDb\(\)\) \};\s*delete incomingMetadata\.appStates;/);
  assert.match(server, /const deferredSessionPersistence = true;/);
  assert.match(server, /runtimeSessionActivityNeedsPersistence\(sessionId\)/);
  assert.match(server, /function apiMetadataFromDb\(db\)[\s\S]*\{ _syncRevision: String\(state\?\._syncRevision \|\| "0"\) \}/);
  assert.match(server, /handleFastPollingApi\(request, response, url\)[\s\S]*loadRuntimeApiMetadata\(\)/);
  assert.match(server, /const fastActivity = method === "POST" && url\.pathname === "\/api\/auth\/activity";/);
  assert.match(server, /runtimeSessionActivityNeedsPersistence\(sessionId\)\) await persistRuntimeSessionActivity\(sessionId\)/);
  assert.match(server, /if \(await handleFastPollingApi\(request, response, url\)\) return;/);
  assert.match(server, /function workspaceStateForRead\(db, workspaceId, persistedState = \{\}\)/);
  const appStateReadRoute = server.match(
    /if \(url\.pathname === "\/api\/app-state" && method === "GET"\) \{([\s\S]*?)\n  \}\n\n  const closedReportMatch/,
  );
  assert.ok(appStateReadRoute, "The app-state read route must remain identifiable for the performance guard.");
  assert.match(appStateReadRoute[1], /workspaceStateForReadWithHistoricalRepair/);
  assert.doesNotMatch(
    appStateReadRoute[1],
    /mergeWorkspaceState/,
    "Ordinary reads must not run the full write-time reconciliation pipeline.",
  );
  assert.match(server, /const metadataOnlyRequest = \(/);
  assert.match(server, /url\.pathname === "\/api\/search" && method === "GET"/);
  assert.match(server, /await pipeline\(createReadStream\(filePath\), response\)/);
  assert.match(server, /typeof storedObject\.Body\.pipe === "function"[\s\S]*await pipeline\(storedObject\.Body, response\)/);
  assert.match(web, /if \(remoteRefreshPending \|\|[\s\S]*remoteRefreshPending = true;[\s\S]*finally \{\s*remoteRefreshPending = false;/);
  assert.match(web, /Date\.now\(\) - lastAccountDeviceWarningRefreshAt >= 15000/);
  assert.match(web, /async function loadGlobalSearchResults\(query, requestSequence\)/);
  assert.match(web, /item\.kind === "archived_order"/);
  assert.match(web, /async function prepareArchiveSearchDestination\(result\)/);
  assert.match(web, /await loadClosedReportDetail\(archive\)/);
  assert.match(web, /api\(`\/api\/search\?\$\{new URLSearchParams\(\{ q: query, limit: "50" \}\)\}`\)/);
  assert.match(web, /globalSearchDebounceTimer = window\.setTimeout\([\s\S]*loadGlobalSearchResults\(query, requestSequence\);[\s\S]*}, 350\);/);
  assert.doesNotMatch(web, /els\.globalSearch\?\.addEventListener\("input", buildGlobalSearchResults\)/);
  assert.match(mobile, /let requestPending = false;[\s\S]*if \(requestPending \|\| AppState\.currentState !== "active"[\s\S]*\.finally\(\(\) => \{ requestPending = false; \}\);/);
  assert.match(mobile, /getAccountDeviceWarning\(\)[\s\S]*\.finally\(\(\) => \{ requestPending = false; \}\);[\s\S]*}, 15000\);/);
});

test("ordinary session activity does not rewrite the financial database", { timeout: 30_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "haderapay-memory-safety-"));
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const ownerPassword = "memory-safety-owner-password";
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
  });
  serverProcess.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  try {
    await waitForServer(baseUrl, serverProcess, () => stderr);
    const login = await request(baseUrl, "/api/auth/login", {
      method: "POST",
      body: { username: "Owner", password: ownerPassword },
    });
    assert.equal(login.response.status, 200, login.data.error);

    const databasePath = path.join(dataDirectory, "auth-db.json");
    const before = await readFile(databasePath, "utf8");
    const activity = await request(baseUrl, "/api/auth/activity", {
      cookie: login.cookie,
      method: "POST",
      body: {},
    });
    assert.equal(activity.response.status, 200, activity.data.error);
    const after = await readFile(databasePath, "utf8");
    assert.equal(after, before, "An activity heartbeat must not rewrite the complete financial database.");
  } finally {
    serverProcess.kill();
    await new Promise((resolve) => serverProcess.once("exit", resolve));
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
