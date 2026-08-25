import assert from "node:assert/strict";
import crypto from "node:crypto";
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
  assert.equal(response.ok, true, data.error || `${method} ${pathname} failed`);
  return {
    data,
    cookie: (response.headers.get("set-cookie") || "").split(";", 1)[0] || cookie,
  };
}

test("web and mobile chat clients defer history, rendering, and attachments", async () => {
  const [web, preview, mobileClient, mobileScreen] = await Promise.all([
    readFile(path.join(repositoryRoot, "index.html"), "utf8"),
    readFile(path.join(repositoryRoot, "preview.html"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/api/client.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/screens/WorkspaceScreens.tsx"), "utf8"),
  ]);
  assert.equal(web, preview);
  assert.match(web, /\/api\/app-state\?reports=summary&chats=summary/);
  assert.match(web, /\/api\/chats\/\$\{encodeURIComponent\(chat\.id\)\}\/messages\?limit=50/);
  assert.match(web, /if \(!chatViewActive\) return;/);
  assert.match(web, /loading="lazy"/);
  assert.match(web, /<audio controls preload="none"/);
  assert.match(mobileClient, /export async function loadChatMessagesPage/);
  assert.match(mobileClient, /messages\?limit=50/);
  assert.match(mobileScreen, /label="Load 50 older messages"/);
  assert.match(mobileScreen, /accessibilityLabel="View photo"/);
  assert.match(mobileScreen, /Tap to load audio/);
});

test("chat summaries and message pages do not send or overwrite the full history", { timeout: 30_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "haderapay-chat-pages-"));
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const ownerPassword = crypto.randomBytes(18).toString("base64url");
  const masterPassword = crypto.randomBytes(18).toString("base64url");
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
  serverProcess.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  try {
    await waitForServer(baseUrl, serverProcess, () => stderr);
    const owner = await request(baseUrl, "/api/auth/login", {
      method: "POST",
      body: { username: "Owner", password: ownerPassword },
    });
    await request(baseUrl, "/api/owner/masters", {
      cookie: owner.cookie,
      method: "POST",
      body: {
        name: "Lazy Chat Master",
        email: "lazy-chat@example.com",
        password: masterPassword,
        currency: "USD",
        plan: "one_month",
      },
    });
    const master = await request(baseUrl, "/api/auth/login", {
      method: "POST",
      body: { email: "lazy-chat@example.com", password: masterPassword },
    });
    const initial = await request(baseUrl, "/api/app-state", { cookie: master.cookie });
    const messages = Array.from({ length: 120 }, (_, index) => ({
      id: `MSG-${String(index + 1).padStart(3, "0")}`,
      from: "Broker One",
      text: `Message ${index + 1}`,
      kind: index === 119 ? "photo" : "text",
      ...(index === 119 ? {
        media: "data:image/png;base64,inline-content-must-not-be-eagerly-returned",
      } : {}),
      readBy: ["Broker One"],
      createdAt: new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString(),
    }));
    const state = {
      ...initial.data.state,
      chatConversations: [{
        id: "CHAT-PAGED",
        type: "direct",
        name: "Broker One",
        members: ["Lazy Chat Master", "Broker One"],
        messages,
        createdAt: "2026-08-01T00:00:00.000Z",
      }],
    };
    await request(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: { state, expectedRevision: initial.data.revision },
    });

    const summary = await request(baseUrl, "/api/app-state?reports=summary&chats=summary", { cookie: master.cookie });
    const summarizedChat = summary.data.state.chatConversations.find((chat) => chat.id === "CHAT-PAGED");
    assert.ok(summarizedChat);
    assert.deepEqual(summarizedChat.messages, []);
    assert.equal(summarizedChat.messageCount, 120);
    assert.equal(summarizedChat.lastMessage.id, "MSG-120");
    assert.equal(Object.hasOwn(summarizedChat.lastMessage, "media"), false);
    assert.equal(summarizedChat.unreadCounts["Lazy Chat Master"], 120);
    assert.equal(summarizedChat._messagesLoaded, false);

    const newest = await request(baseUrl, "/api/chats/CHAT-PAGED/messages?limit=50", { cookie: master.cookie });
    assert.equal(newest.data.messages.length, 50);
    assert.equal(newest.data.messages[0].id, "MSG-071");
    assert.equal(newest.data.messages[49].id, "MSG-120");
    assert.equal(newest.data.hasOlder, true);
    assert.equal(newest.data.nextBefore, "70");

    const middle = await request(baseUrl, `/api/chats/CHAT-PAGED/messages?limit=50&before=${newest.data.nextBefore}`, { cookie: master.cookie });
    assert.equal(middle.data.messages[0].id, "MSG-021");
    assert.equal(middle.data.messages[49].id, "MSG-070");
    assert.equal(middle.data.hasOlder, true);
    assert.equal(middle.data.nextBefore, "20");

    const oldest = await request(baseUrl, `/api/chats/CHAT-PAGED/messages?limit=50&before=${middle.data.nextBefore}`, { cookie: master.cookie });
    assert.equal(oldest.data.messages.length, 20);
    assert.equal(oldest.data.messages[0].id, "MSG-001");
    assert.equal(oldest.data.messages[19].id, "MSG-020");
    assert.equal(oldest.data.hasOlder, false);
    assert.equal(oldest.data.nextBefore, "");

    const partialState = {
      ...summary.data.state,
      selectedChatId: "CHAT-PAGED",
    };
    const savedSummary = await request(baseUrl, "/api/app-state", {
      cookie: master.cookie,
      method: "PUT",
      body: {
        state: partialState,
        expectedRevision: summary.data.revision,
        chatResponse: "summary",
      },
    });
    assert.deepEqual(savedSummary.data.state.chatConversations[0].messages, []);
    const afterPartialSave = await request(baseUrl, "/api/chats/CHAT-PAGED/messages?limit=50", { cookie: master.cookie });
    assert.equal(afterPartialSave.data.messages.length, 50);
    assert.equal(afterPartialSave.data.messages[49].id, "MSG-120", "Saving a summary must preserve unseen messages.");
  } finally {
    serverProcess.kill();
    await new Promise((resolve) => serverProcess.once("exit", resolve));
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
