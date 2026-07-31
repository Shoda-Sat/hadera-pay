import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("Android Master Profiles provides profile and order search", async () => {
  const [app, screens, types] = await Promise.all([
    readFile(path.join(repositoryRoot, "mobile/App.tsx"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/screens/WorkspaceScreens.tsx"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/types.ts"), "utf8"),
  ]);

  assert.match(types, /\| "profiles"/);
  assert.match(app, /ProfilesScreen/);
  assert.match(app, /currentScreen === "profiles" && isMasterView/);
  assert.match(screens, /export function ProfilesScreen/);
  assert.match(screens, /label="Profiles"/);
  assert.match(screens, /label="Search profiles"/);
  assert.match(screens, /label="Search this profile's orders"/);
  assert.match(screens, /function ordersForProfile/);
  assert.match(screens, /order\.broker === actor\.name/);
  assert.match(screens, /order\.agentActorId === actor\.id/);
  assert.match(screens, /orderNumber\(order, displaySession\)/);
});
