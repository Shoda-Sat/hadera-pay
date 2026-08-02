import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("Android ledger Order_Payment details show only sender and receiver names", async () => {
  const screens = await readFile(path.join(repositoryRoot, "mobile/src/screens/WorkspaceScreens.tsx"), "utf8");

  assert.match(screens, /function ledgerDetailsForDisplay\(state: WorkspaceState, line: WorkspaceState\["ledger"\]\[number\]\): string/);
  assert.match(screens, /order\?\.senderName \? `Sender: \$\{order\.senderName\}`/);
  assert.match(screens, /order\?\.receiverName \? `Receiver: \$\{order\.receiverName\}`/);
  assert.match(screens, /return names\.length \? \["Order_Payment", \.\.\.names\]\.join\(" - "\)/);
  assert.match(screens, /ledgerDetailsForDisplay\(state, line\)/);
});
