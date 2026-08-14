import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function functionSource(source, name, nextName) {
  const plainStart = source.indexOf(`    function ${name}`);
  const asyncStart = source.indexOf(`    async function ${name}`);
  const start = plainStart === -1 ? asyncStart : plainStart;
  const plainEnd = source.indexOf(`    function ${nextName}`, start + 1);
  const asyncEnd = source.indexOf(`    async function ${nextName}`, start + 1);
  const end = plainEnd === -1 ? asyncEnd : asyncEnd === -1 ? plainEnd : Math.min(plainEnd, asyncEnd);
  assert.notEqual(start, -1, `${name} was not found`);
  assert.notEqual(end, -1, `${nextName} was not found after ${name}`);
  return source.slice(start, end);
}

test("a revision conflict retries in place without reloading the workspace", async () => {
  const [index, preview] = await Promise.all([
    readFile(path.join(root, "index.html"), "utf8"),
    readFile(path.join(root, "preview.html"), "utf8"),
  ]);
  assert.equal(index, preview);

  const conflictHandler = functionSource(index, "handleRemoteSaveError", "queueRemoteStateSave");
  const queueSource = functionSource(index, "queueRemoteStateSave", "clientDeviceId");
  assert.doesNotMatch(conflictHandler, /location\.reload/);
  assert.match(conflictHandler, /Your screen was not refreshed/);
  assert.match(queueSource, /for \(let attempt = 0; attempt < 3; attempt \+= 1\)/);
  assert.match(queueSource, /error\?\.status !== 409/);
  assert.match(queueSource, /api\("\/api\/app-state\/version"\)/);

  const calls = [];
  let putCount = 0;
  const api = async (pathname, options = {}) => {
    calls.push({ pathname, options });
    if (pathname === "/api/app-state/version") return { revision: "r1" };
    putCount += 1;
    if (putCount === 1) throw Object.assign(new Error("conflict"), { status: 409 });
    return { revision: "r2", state: { marker: "saved" } };
  };
  const buildHarness = new Function("api", `
    let state = { marker: "local" };
    let remoteStateRevision = "r0";
    let remoteSaveChain = Promise.resolve();
    let remoteSavePending = 0;
    const storageKey = "test";
    const localStorage = { setItem() {} };
    let merged = null;
    const mergeSharedState = (value) => { merged = value; return true; };
    ${queueSource}
    return {
      run: () => queueRemoteStateSave(),
      result: () => ({ remoteStateRevision, remoteSavePending, merged })
    };
  `);
  const harness = buildHarness(api);
  await harness.run();
  assert.equal(putCount, 2);
  assert.equal(calls.filter((call) => call.pathname === "/api/app-state/version").length, 1);
  assert.deepEqual(harness.result(), {
    remoteStateRevision: "r2",
    remoteSavePending: 0,
    merged: { marker: "saved" },
  });
});

test("background sync skips unchanged revisions, active saves, and focused form fields", async () => {
  const index = await readFile(path.join(root, "index.html"), "utf8");
  const refreshSource = functionSource(index, "refreshSharedState", "startRemoteRefresh");
  assert.match(index, /function workspaceInputIsFocused\(\)[\s\S]*input, textarea, select/);
  assert.match(refreshSource, /remoteSavePending > 0 \|\| saveTimer !== null \|\| workspaceInputIsFocused\(\)/);
  assert.match(refreshSource, /String\(version\.revision\) === String\(remoteStateRevision\)/);
  assert.doesNotMatch(refreshSource, /location\.reload/);
  assert.match(refreshSource, /Refresh the page when convenient/);
});
