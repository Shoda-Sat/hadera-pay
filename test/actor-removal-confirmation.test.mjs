import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("Master must confirm before removing an Actor on web and Android", async () => {
  const [index, preview, mobileScreens] = await Promise.all([
    readFile(path.join(repositoryRoot, "index.html"), "utf8"),
    readFile(path.join(repositoryRoot, "preview.html"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/screens/WorkspaceScreens.tsx"), "utf8"),
  ]);

  assert.equal(index, preview);
  const webRemoveHandler = index.match(
    /const removeActorButton = event\.target\.closest\("\.remove-actor"\);[\s\S]*?(?=\n\s*const orderCurrencyButton)/
  )?.[0] || "";
  assert.match(webRemoveHandler, /confirmAction\(/);
  assert.match(webRemoveHandler, /\(\) => removeActor\(actor\.id\)/);
  assert.match(webRemoveHandler, /This cannot be undone\./);
  assert.doesNotMatch(webRemoveHandler, /await removeActor\(/);

  assert.match(mobileScreens, /Alert\.alert\("Remove actor\?"/);
  assert.match(mobileScreens, /\{ text: "Cancel", style: "cancel" \}/);
  assert.match(mobileScreens, /style: "destructive", onPress: \(\) => run\(actor\.id, \(\) => removeWorkspaceActor/);
});
