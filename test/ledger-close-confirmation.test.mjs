import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("Master chooses how cancelled orders are handled before closing an Actor balance", async () => {
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
  const requests = [];
  const replacements = [];
  const notices = [];
  let renderCalls = 0;
  const broker = { id: "ACT-BROKER", name: "Broker One", role: "Broker" };
  const state = {
    selectedLedgerActor: broker.name,
    orders: [
      { id: "ORD-CANCELLED", state: "Cancelled", brokerActorId: broker.id, broker: broker.name },
      { id: "ORD-OTHER", state: "Cancelled", brokerActorId: "ACT-OTHER", broker: broker.name },
    ],
  };
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
    "saveStateNow",
    "activeActors",
    "orderParticipantMatchesActor",
    "confirmAction",
    "api",
    "replaceState",
    "renderAll",
    "notifyEvent",
    "remoteStateRevision",
    handlerSource,
  )(
    { getElementById: (id) => id === "closeBalanceButton" ? button : null },
    () => ({ role: selectedRole }),
    state,
    async () => true,
    () => [broker],
    (order, actor, role) => role === "broker" && (order.brokerActorId ? order.brokerActorId === actor.id : order.broker === actor.name),
    (message, onYes, onNo = () => {}, labels = {}) => { confirmation = { message, onYes, onNo, labels }; },
    async (url, options) => {
      requests.push({ url, options });
      return {
        state: { closed: true, policy: options.body.cancelledOrderPolicy },
        cancelledOrderCount: 1,
      };
    },
    (nextState) => replacements.push(nextState),
    () => { renderCalls += 1; },
    (title, message) => notices.push({ title, message }),
    "revision-before-close",
  );

  assert.equal(typeof clickHandler, "function");
  await clickHandler();
  assert.equal(confirmation, undefined, "Only Master may receive the close-balance confirmation.");

  selectedRole = "Master";
  await clickHandler();
  assert.match(confirmation.message, /Warning: close Broker One's ledger balance\?/);
  assert.match(confirmation.message, /1 cancelled order will be removed from Orderbook either way/);
  assert.match(confirmation.message, /cannot be undone/);
  assert.deepEqual(confirmation.labels, {
    yes: "Keep in Report & Close",
    no: "Remove without Report & Close",
  });
  assert.deepEqual(requests, [], "Opening or cancelling the warning must not close the balance.");
  assert.equal(renderCalls, 0);

  await confirmation.onYes();
  assert.equal(requests[0].url, "/api/app-state/close-balance");
  assert.deepEqual(requests[0].options.body, {
    actorId: broker.id,
    actorName: broker.name,
    cancelledOrderPolicy: "include",
    expectedRevision: "revision-before-close",
  });
  assert.deepEqual(replacements[0], { closed: true, policy: "include" });
  assert.equal(renderCalls, 1);

  await clickHandler();
  await confirmation.onNo();
  assert.deepEqual(requests[1].options.body, {
    actorId: broker.id,
    actorName: broker.name,
    cancelledOrderPolicy: "omit",
    expectedRevision: "revision-before-close",
  });
  assert.deepEqual(replacements[1], { closed: true, policy: "omit" });
  assert.equal(renderCalls, 2);
  assert.match(notices[0].message, /kept in Report/);
  assert.match(notices[1].message, /removed without Report/);

  state.orders = [];
  await clickHandler();
  assert.match(confirmation.message, /Completed transactions and collected receivables will move to Report/);
  assert.deepEqual(confirmation.labels, {}, "A close without cancelled orders uses the normal confirmation labels.");
  await confirmation.onYes();
  assert.equal(requests[2].options.body.cancelledOrderPolicy, "include");
});

test("shared confirmation labels reset after every action", async () => {
  const index = await readFile(path.join(repositoryRoot, "index.html"), "utf8");
  assert.match(index, /function confirmAction\(message, onYes, onNo = \(\) => \{\}, labels = \{\}\)/);
  assert.match(index, /els\.confirmYes\.textContent = labels\.yes \|\| "Yes"/);
  assert.match(index, /els\.confirmNo\.textContent = labels\.no \|\| "No"/);
  assert.match(index, /function closeConfirmation\(\)[\s\S]*?els\.confirmYes\.textContent = "Yes"[\s\S]*?els\.confirmNo\.textContent = "No"/);
});
