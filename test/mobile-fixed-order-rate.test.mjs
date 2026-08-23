import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Android applies and enforces each Actor's Master-fixed order rate", async () => {
  const [app, client, money] = await Promise.all([
    readFile(path.join(repositoryRoot, "mobile/App.tsx"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/api/client.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/utils/money.ts"), "utf8")
  ]);

  assert.match(money, /setting\?\.enabled === true[\s\S]*rate > 0 \? rate : null/);
  assert.match(app, /fixedOrderRateForActor\(actor, draft\.payoutCurrency\)/);
  assert.match(app, /editable=\{!fixedRate\}/);
  assert.match(app, /reconcileFixedOrderConversion\(next, fixedRate, key\)/);
  assert.match(client, /fixedOrderRateForActor\(actor, effectiveDraft\.payoutCurrency\)/);
  assert.match(client, /fixedRate \? \{ rate: String\(fixedRate\), payoutAmount: "" \} : \{\}/);
});
