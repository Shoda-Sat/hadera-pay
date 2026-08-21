import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { newManualLedgerCurrencyViolations } from "../src/manualLedgerCurrency.mjs";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const actors = [
  { id: "ACT-1", name: "Nahom", role: "Agent", currency: "ETB" },
  { id: "ACT-2", name: "PPP", role: "Broker", currency: "EUR" },
];

test("new journals and withdrawals must use the selected Actor's base currency", () => {
  const currentState = {
    actors,
    ledger: [
      { entryId: "JNL-OLD", journal: "JRN-1", source: "JOURNAL", account: "Nahom ACTOR_CLEARING", direction: "Debit", currency: "USD" },
    ],
  };
  const incomingState = {
    actors,
    ledger: [
      ...currentState.ledger,
      { entryId: "JNL-NEW", journal: "JRN-2", source: "JOURNAL", account: "Nahom ACTOR_CLEARING", direction: "Debit", currency: "USD" },
      { entryId: "WDL-NEW", journal: "JRN-3", source: "WITHDRAWAL", account: "PPP ACTOR_CLEARING", direction: "Credit", currency: "USD" },
      { entryId: "JNL-CLOSED", journal: "JRN-4", source: "JOURNAL", account: "Nahom ACTOR_CLEARING", direction: "Debit", currency: "USD", archived: true },
    ],
  };

  assert.deepEqual(newManualLedgerCurrencyViolations(currentState, incomingState), [
    { actor: "Nahom", source: "JOURNAL", journal: "JRN-2", currency: "USD", expectedCurrency: "ETB" },
    { actor: "PPP", source: "WITHDRAWAL", journal: "JRN-3", currency: "USD", expectedCurrency: "EUR" },
  ]);
  assert.deepEqual(newManualLedgerCurrencyViolations(currentState, {
    actors,
    ledger: [
      ...currentState.ledger,
      { entryId: "JNL-NEW", journal: "JRN-2", source: "JOURNAL", account: "Nahom ACTOR_CLEARING", direction: "Debit", currency: "ETB" },
      { entryId: "WDL-NEW", journal: "JRN-3", source: "WITHDRAWAL", account: "PPP ACTOR_CLEARING", direction: "Credit", currency: "EUR" },
    ],
  }), []);
});

test("web and Android lock manual-entry destinations to the Actor base currency", async () => {
  const [index, preview, mobileScreen, mobileDomain, server] = await Promise.all([
    readFile(path.join(repositoryRoot, "index.html"), "utf8"),
    readFile(path.join(repositoryRoot, "preview.html"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/screens/WorkspaceScreens.tsx"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/domain/workspace.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "server.mjs"), "utf8"),
  ]);

  assert.equal(index, preview);
  assert.match(index, /Destination currency \(Actor base\)/);
  assert.match(index, /function setLedgerDestinationCurrency\(select, actorName\)/);
  assert.match(index, /currencyMismatch = !destinationCurrency \|\| selectedCurrency !== destinationCurrency/);
  assert.match(mobileScreen, /label="Destination currency \(Actor base\)"/);
  assert.match(mobileScreen, /currency: item\.currency/);
  assert.match(mobileDomain, /input\.currency !== actor\.currency/);
  assert.match(server, /newManualLedgerCurrencyViolations\(currentState, incomingState, membershipActors\)/);
});
