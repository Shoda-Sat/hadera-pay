import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function loadTypeScriptModule(source, dependencies = {}) {
  const outputText = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const module = { exports: {} };
  new Function("exports", "module", "require", outputText)(module.exports, module, (specifier) => {
    if (Object.prototype.hasOwnProperty.call(dependencies, specifier)) return dependencies[specifier];
    throw new Error(`Unexpected runtime import: ${specifier}`);
  });
  return module.exports;
}

function session(overrides = {}) {
  return {
    userId: "USR-1",
    name: "Viewer",
    email: "viewer@example.com",
    role: "Actor",
    actorId: "ACT-PAYER",
    actorName: "Paying Agent",
    actorRole: "Agent",
    currency: "USD",
    workingCurrencies: ["USD"],
    workspaceId: "WS-1",
    workspace: "Test",
    idleTimeoutSeconds: 7200,
    ...overrides
  };
}

function order(overrides = {}) {
  return {
    id: "ORD-1",
    brokerOrderNumber: "BRH003",
    brokerActorId: "ACT-BROKER",
    agentOrderNumber: "0233_BRH003",
    agentOrderActor: "Paying Agent",
    agentOrderNumbers: { "Paying Agent": "0233_BRH003" },
    broker: "Broker",
    agent: "Paying Agent",
    agentActorId: "ACT-PAYER",
    sourceCurrency: "EUR",
    payoutCurrency: "ETB",
    sourceAmountMinor: 10_000,
    payoutAmountMinor: 38_800,
    commissionMinor: 0,
    grossMinor: 10_000,
    rate: 388,
    commissionPercent: 0,
    senderName: "Natu",
    receiverName: "Yosan",
    receiverCity: "Addis",
    accountNumber: "247762957",
    phoneNumber: "0911000000",
    remarks: "Cash pickup",
    amount: "EUR100",
    fundingType: "cash",
    state: "Assigned",
    journal: "",
    createdAt: "2026-08-08T08:00:00.000Z",
    sentAt: "2026-08-08T08:00:00.000Z",
    paidAt: "",
    returnedBy: "",
    returnedReason: "",
    updatedAt: "2026-08-08T08:00:00.000Z",
    ...overrides
  };
}

test("Android copies the same permitted order details as web", async () => {
  const [moneySource, copySource, screenSource, uiSource, packageJson, packageLock] = await Promise.all([
    readFile(path.join(repositoryRoot, "mobile/src/utils/money.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/utils/orderCopy.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/screens/WorkspaceScreens.tsx"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/components/ui.tsx"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/package.json"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/package-lock.json"), "utf8")
  ]);
  const money = loadTypeScriptModule(moneySource);
  const copy = loadTypeScriptModule(copySource, { "./money": money });
  const assignedOrder = order();
  const payerSession = session();
  const payerActor = { id: "ACT-PAYER", name: "Paying Agent", role: "Agent", currency: "USD" };

  assert.equal(copy.viewerCanCopyOrderDetails(assignedOrder, payerSession, payerActor), true);
  assert.equal(copy.orderDetailsClipboardText(assignedOrder, payerSession, payerActor), [
    "Order Number: 0233_BRH003",
    "Sender Name: Natu",
    "Receiver Name: Yosan",
    "Receiver City: Addis",
    "Source Amount: EUR100",
    "Total Payout: ETB38800",
    "Phone Number: 0911000000",
    "Account Number: 247762957",
    "Remarks: Cash pickup"
  ].join("\n"));

  const masterSession = session({ role: "Master", actorId: "ACT-0", actorName: "Master", actorRole: "Master" });
  const masterText = copy.orderDetailsClipboardText(assignedOrder, masterSession, { id: "ACT-0", name: "Master", role: "Master", currency: "USD" });
  assert.match(masterText, /^Order Number: BRH003\nFile Number: 0233_BRH003\n/);

  const hiddenCurrencyText = copy.orderDetailsClipboardText(assignedOrder, payerSession, {
    ...payerActor,
    orderVisibilityPermissions: { sourceCurrency: false }
  });
  assert.match(hiddenCurrencyText, /Source Amount: 100/);
  assert.doesNotMatch(hiddenCurrencyText, /Source Amount: EUR/);
  const hiddenAmountText = copy.orderDetailsClipboardText(assignedOrder, payerSession, {
    ...payerActor,
    orderVisibilityPermissions: { baseAmount: false }
  });
  assert.doesNotMatch(hiddenAmountText, /Source Amount:/);

  const brokerSession = session({ actorId: "ACT-BROKER", actorName: "Broker", actorRole: "Broker" });
  assert.equal(copy.viewerCanCopyOrderDetails(assignedOrder, brokerSession, { id: "ACT-BROKER", name: "Broker", role: "Broker", currency: "EUR" }), false);
  assert.equal(copy.orderDetailsClipboardText(assignedOrder, brokerSession, { id: "ACT-BROKER", name: "Broker", role: "Broker", currency: "EUR" }), "");
  assert.equal(copy.viewerCanCopyOrderDetails(assignedOrder, session({ actorId: "ACT-OTHER", actorName: "Other Agent" }), { id: "ACT-OTHER", name: "Other Agent", role: "Agent", currency: "USD" }), false);
  assert.equal(copy.viewerCanCopyOrderDetails(assignedOrder, payerSession, undefined), false);

  assert.equal(JSON.parse(packageJson).dependencies["expo-clipboard"], "~7.1.5");
  assert.match(packageLock, /node_modules\/expo-clipboard/);
  assert.match(screenSource, /import \* as Clipboard from "expo-clipboard"/);
  assert.match(screenSource, /Clipboard\.setStringAsync\(value\)/);
  assert.match(screenSource, /accessibilityLabel="Copy order details"/);
  assert.match(screenSource, /headerAction=\{<CopyOrderDetailsButton order=\{order\}/);
  assert.match(uiSource, /headerAction\?: React\.ReactNode/);
});

test("Android receivables totals match the web principal, collected, and balance math", async () => {
  const [receivablesSource, screenSource] = await Promise.all([
    readFile(path.join(repositoryRoot, "mobile/src/utils/receivables.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/screens/WorkspaceScreens.tsx"), "utf8")
  ]);
  const receivables = loadTypeScriptModule(receivablesSource);
  const brokerSession = session({ actorId: "ACT-BROKER", actorName: "Renamed Broker", actorRole: "Broker" });
  const record = (overrides) => ({
    id: overrides.id,
    orderId: overrides.orderId || overrides.id,
    borrower: "Old Broker Name",
    borrowerActorId: "ACT-BROKER",
    currency: "USD",
    principalMinor: 0,
    senderName: "",
    receiverName: "",
    receiverCity: "",
    accountNumber: "",
    phoneNumber: "",
    remarks: "",
    createdAt: "2026-08-08T08:00:00.000Z",
    updatedAt: "2026-08-08T08:00:00.000Z",
    createdBy: "Old Broker Name",
    payments: [],
    ...overrides
  });
  const allRecords = [
    record({ id: "USD-OPEN", principalMinor: 10_000, payments: [{ amountMinor: 2_500 }] }),
    record({ id: "USD-COLLECTED", principalMinor: 4_000, payments: [{ amountMinor: 4_000 }] }),
    record({ id: "USD-VOIDED", principalMinor: 9_000, payments: [{ amountMinor: 1_000 }], voidedAt: "2026-08-08T09:00:00.000Z" }),
    record({ id: "ETB-OPEN", currency: "ETB", principalMinor: 500, payments: [{ amountMinor: 100 }] }),
    record({ id: "LYD-VOIDED", currency: "LYD", principalMinor: 1_000, voided: true }),
    record({ id: "ARCHIVED", principalMinor: 99_000, archivedAt: "2026-08-08T10:00:00.000Z" }),
    record({ id: "OTHER", borrower: "Other", borrowerActorId: "ACT-OTHER", principalMinor: 88_000 })
  ];

  const visible = receivables.visibleReceivablesForSession(allRecords, brokerSession);
  assert.deepEqual(visible.map((item) => item.id).sort(), ["ETB-OPEN", "LYD-VOIDED", "USD-COLLECTED", "USD-OPEN", "USD-VOIDED"]);
  assert.deepEqual(receivables.receivableTotalsByCurrency(visible), [
    { currency: "USD", principalMinor: 14_000, collectedMinor: 6_500, balanceMinor: 7_500 },
    { currency: "ETB", principalMinor: 500, collectedMinor: 100, balanceMinor: 400 },
    { currency: "LYD", principalMinor: 0, collectedMinor: 0, balanceMinor: 0 }
  ]);

  assert.match(screenSource, /<Panel title="Receivables totals"/);
  assert.match(screenSource, /label="Principal"[\s\S]*total\.principalMinor/);
  assert.match(screenSource, /label="Collected"[\s\S]*total\.collectedMinor/);
  assert.match(screenSource, /label="Balance"[\s\S]*total\.balanceMinor/);
  assert.doesNotMatch(screenSource, /filter\(\(item\) => item\.minor\)/);
});
