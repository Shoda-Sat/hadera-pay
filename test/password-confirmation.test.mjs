import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("password changes require matching confirmation on web, Android, and the server", async () => {
  const [index, preview, server, mobileClient, mobileScreens] = await Promise.all([
    readFile(path.join(repositoryRoot, "index.html"), "utf8"),
    readFile(path.join(repositoryRoot, "preview.html"), "utf8"),
    readFile(path.join(repositoryRoot, "server.mjs"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/api/client.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/screens/WorkspaceScreens.tsx"), "utf8"),
  ]);

  assert.equal(index, preview);
  assert.match(index, /Confirm New Password/);
  assert.match(index, /confirmNewPassword: confirmPassword/);
  assert.match(server, /const confirmNewPassword = String\(body\.confirmNewPassword \|\| ""\)/);
  assert.match(server, /if \(newPassword !== confirmNewPassword\)/);
  assert.match(mobileClient, /changePassword\(currentPassword: string, newPassword: string, confirmNewPassword: string\)/);
  assert.match(mobileClient, /body: \{ currentPassword, newPassword, confirmNewPassword \}/);
  assert.match(mobileScreens, /label="Confirm New Password"/);
  assert.match(mobileScreens, /changePassword\(currentPassword, newPassword, confirmNewPassword\)/);
});
