import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("Master must confirm before closing an Actor ledger balance", async () => {
  const [index, preview] = await Promise.all([
    readFile(path.join(repositoryRoot, "index.html"), "utf8"),
    readFile(path.join(repositoryRoot, "preview.html"), "utf8"),
  ]);
  assert.equal(index, preview);

  const startMarker = 'document.getElementById("closeBalanceButton").addEventListener';
  const endMarker = "const subscriptionMutationSelector";
  const start = index.indexOf(startMarker);
  const end = index.indexOf(endMarker, start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const handlerSource = index.slice(start, end);

  let clickHandler;
  let selectedRole = "Actor";
  let confirmation;
  const closeCalls = [];
  let renderCalls = 0;
  const state = { selectedLedgerActor: "Broker One" };
  const button = {
    addEventListener(eventName, handler) {
      assert.equal(eventName, "click");
      clickHandler = handler;
    },
  };

  new Function(
    "document",
    "selectedActor",
    "state",
    "confirmAction",
    "closeCurrentBalanceForActor",
    "renderAll",
    handlerSource,
  )(
    { getElementById: (id) => id === "closeBalanceButton" ? button : null },
    () => ({ role: selectedRole }),
    state,
    (message, onYes) => { confirmation = { message, onYes }; },
    (actorName) => { closeCalls.push(actorName); return true; },
    () => { renderCalls += 1; },
  );

  assert.equal(typeof clickHandler, "function");
  clickHandler();
  assert.equal(confirmation, undefined, "Only Master may receive the close-balance confirmation.");

  selectedRole = "Master";
  clickHandler();
  assert.match(confirmation.message, /Warning: close Broker One's ledger balance\?/);
  assert.match(confirmation.message, /move to Report/);
  assert.match(confirmation.message, /cannot be undone/);
  assert.deepEqual(closeCalls, [], "Opening or cancelling the warning must not close the balance.");
  assert.equal(renderCalls, 0);

  confirmation.onYes();
  assert.deepEqual(closeCalls, ["Broker One"]);
  assert.equal(renderCalls, 1);
});
