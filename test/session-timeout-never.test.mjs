import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("Never timeout is available and disables inactivity logout on web and Android", async () => {
  const [index, preview, server, mobileApp, mobileClient, mobileScreens] = await Promise.all([
    readFile(path.join(repositoryRoot, "index.html"), "utf8"),
    readFile(path.join(repositoryRoot, "preview.html"), "utf8"),
    readFile(path.join(repositoryRoot, "server.mjs"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/App.tsx"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/api/client.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/screens/WorkspaceScreens.tsx"), "utf8"),
  ]);

  assert.equal(index, preview);
  assert.match(index, /<option value="0">Never<\/option>/);
  assert.match(index, /if \(authIdleSeconds\(session\) === 0\) return false/);
  assert.match(index, /if \(authIdleSeconds\(currentAuth\) === 0\) return/);
  assert.match(server, /allowedSessionIdleSeconds = new Set\(\[0,/);
  assert.match(server, /if \(idleTimeoutSeconds === 0\) return false/);
  assert.match(server, /session\.expiresAt = idleTimeoutSeconds === 0 \? ""/);
  assert.match(mobileClient, /7200, 0\] as const/);
  assert.match(mobileApp, /if \(idleTimeoutSeconds === 0\) return/);
  assert.match(mobileScreens, /if \(seconds === 0\) return "Never"/);
  assert.match(mobileScreens, /allowedIdleTimeoutSeconds\[selectedIndex\] \?\? 7200/);
});
