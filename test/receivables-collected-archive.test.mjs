import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function readRepositoryFile(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `Missing source marker after ${startMarker}: ${endMarker}`);
  return source.slice(start, end);
}

test("web and Android use orange open labels and compact green collected rows", async () => {
  const [index, preview, mobileScreen] = await Promise.all([
    readRepositoryFile("index.html"),
    readRepositoryFile("preview.html"),
    readRepositoryFile("mobile/src/screens/WorkspaceScreens.tsx"),
  ]);

  assert.equal(index, preview, "The production and preview web clients must remain identical.");

  const mobileReceivables = sourceBetween(
    mobileScreen,
    "export function ReceivablesScreen",
    "const likeReaction",
  );
  assert.match(mobileReceivables, /const \[expandedCollected, setExpandedCollected\] = useState<string\[\]>\(\[\]\)/);
  assert.match(mobileReceivables, /const isCollected = !voided && balance === 0/);
  assert.match(mobileReceivables, /badge=\{voided \? "Voided" : balance \? "Open" : "Collected"\}/);
  assert.match(mobileReceivables, /badgeTone=\{voided \? "voided" : balance \? "warn" : "good"\}/);
  assert.match(mobileReceivables, /title=\{item\.brokerOrderNumber \|\| item\.orderId \|\| item\.id\}/);
  assert.match(mobileReceivables, /\{isCollected \? \([\s\S]*style=\{styles\.receivableCompactRow\}/);
  assert.match(mobileReceivables, /Credit Reminder: \{showReminder \? item\.creditReminder : "No credit reminder"\}/);
  assert.match(mobileReceivables, /numberOfLines=\{1\}/);
  assert.match(mobileReceivables, /\{isExpanded \? "Show less" : "Show more"\}/);
  assert.match(mobileReceivables, /\{isExpanded \? details : null\}/);
  assert.match(mobileReceivables, /\) : details\}/);

  const webReceivables = sourceBetween(index, "function renderReceivables()", "function searchTerms()");
  assert.match(webReceivables, /const isCollected = !isVoided && balanceMinor === 0/);
  assert.match(webReceivables, /if \(isCollected\) \{[\s\S]*class="receivable-compact-cell"/);
  assert.match(webReceivables, /<details class="receivable-compact-detail">/);
  assert.equal((webReceivables.match(/class="receivable-compact-line"/g) || []).length, 2);
  assert.match(webReceivables, /class="state-pill good">Collected<\/span>/);
  assert.match(webReceivables, /class="receivable-compact-reminder">Credit Reminder: \$\{escapeHtml\(creditReminder \|\| "No credit reminder"\)\}/);
  assert.match(webReceivables, /class="show-more-text">Show more<\/span><span class="show-less-text">Show less<\/span>/);
  assert.match(webReceivables, /class="state-pill warn">Open<\/span>[\s\S]*class="receivable-payment"/);
});

test("closing a broker balance archives only fully collected receivables", async () => {
  const index = await readRepositoryFile("index.html");
  const eligibilitySource = sourceBetween(
    index,
    "function receivableIsCollectedForBalanceClose",
    "function actorCanSeeCreditReminder",
  );
  const paidMinor = (receivable) => (receivable.payments || [])
    .reduce((sum, payment) => sum + Number(payment.amountMinor || 0), 0);
  const receivableIsCollectedForBalanceClose = new Function(
    "receivableIsVoided",
    "receivablePaidMinor",
    `${eligibilitySource}\nreturn receivableIsCollectedForBalanceClose;`,
  )(
    (receivable) => Boolean(receivable.voided || receivable.voidedAt),
    paidMinor,
  );
  const selectionSource = sourceBetween(
    index,
    "const collectedReceivables = state.receivables.filter",
    "const incomeRows =",
  );
  const selectCollected = new Function(
    "state",
    "actor",
    "receivableIsVoided",
    "receivablePaidMinor",
    "receivableIsCollectedForBalanceClose",
    `${selectionSource}\nreturn collectedReceivables;`,
  );
  const record = (id, overrides = {}) => ({
    id,
    borrower: "Broker One",
    borrowerActorId: "ACT-BROKER-1",
    principalMinor: 10_000,
    payments: [{ amountMinor: 10_000 }],
    ...overrides,
  });
  const receivables = [
    record("COLLECTED-EXACT"),
    record("COLLECTED-OVER", { payments: [{ amountMinor: 12_000 }] }),
    record("OPEN-PARTIAL", { payments: [{ amountMinor: 9_999 }] }),
    record("OPEN-UNPAID", { payments: [] }),
    record("ZERO-PRINCIPAL", { principalMinor: 0, payments: [] }),
    record("ALREADY-ARCHIVED", { archivedAt: "2026-08-01T00:00:00.000Z" }),
    record("VOIDED", { voidedAt: "2026-08-01T00:00:00.000Z" }),
    record("OTHER-BROKER", { borrower: "Broker Two", borrowerActorId: "ACT-BROKER-2" }),
    record("MATCHES-STABLE-ID", { borrower: "Former Broker Name" }),
  ];
  const state = { receivables: structuredClone(receivables) };
  const actor = { id: "ACT-BROKER-1", name: "Broker One" };
  const collected = selectCollected(
    state,
    actor,
    (receivable) => Boolean(receivable.voided || receivable.voidedAt),
    paidMinor,
    receivableIsCollectedForBalanceClose,
  );

  assert.deepEqual(
    collected.map((receivable) => receivable.id),
    ["COLLECTED-EXACT", "COLLECTED-OVER", "MATCHES-STABLE-ID"],
  );

  const archiveUpdateSource = sourceBetween(
    index,
    "const collectedReceivableIds = new Set",
    "const openingLines =",
  );
  const markCollectedArchived = new Function(
    "state",
    "collectedReceivables",
    "closedAt",
    "archiveId",
    `${archiveUpdateSource}\nreturn state.receivables;`,
  );
  const closedAt = "2026-08-09T10:00:00.000Z";
  const archiveId = "ARC-TEST";
  const updated = markCollectedArchived(state, collected, closedAt, archiveId);
  const archivedIds = updated.filter((receivable) => receivable.archivedAt === closedAt)
    .map((receivable) => receivable.id);

  assert.deepEqual(archivedIds, ["COLLECTED-EXACT", "COLLECTED-OVER", "MATCHES-STABLE-ID"]);
  assert.equal(updated.find((receivable) => receivable.id === "OPEN-PARTIAL").archivedAt, undefined);
  assert.equal(updated.find((receivable) => receivable.id === "OPEN-UNPAID").archiveId, undefined);
  assert.ok(updated.filter((receivable) => archivedIds.includes(receivable.id)).every((receivable) => receivable.archiveId === archiveId));
});

test("closed receivable snapshots retain reminders and reports keep them separate", async () => {
  const [index, mobileApp] = await Promise.all([
    readRepositoryFile("index.html"),
    readRepositoryFile("mobile/App.tsx"),
  ]);
  const snapshotSource = sourceBetween(
    index,
    "function archiveReceivableSnapshot",
    "function archiveTransferSnapshot",
  );
  const archiveReceivableSnapshot = new Function(
    `${snapshotSource}\nreturn archiveReceivableSnapshot;`,
  )();
  const payment = { id: "PAY-1", amountMinor: 25_000, paidAt: "2026-08-09T09:00:00.000Z" };
  const original = {
    id: "REC-1",
    orderId: "ORD-1",
    brokerOrderNumber: "BRH008",
    borrower: "Broker One",
    borrowerActorId: "ACT-BROKER-1",
    currency: "EUR",
    principalMinor: 25_000,
    creditReminder: "Meseret Kebede",
    payments: [payment],
  };
  const closedAt = "2026-08-09T10:00:00.000Z";
  const snapshot = archiveReceivableSnapshot(original, "Broker One", "ARC-1", closedAt);

  assert.equal(snapshot.creditReminder, "Meseret Kebede");
  assert.equal(snapshot.archivedAt, closedAt);
  assert.equal(snapshot.archiveId, "ARC-1");
  assert.deepEqual(snapshot.payments, [payment]);
  assert.notEqual(snapshot.payments[0], payment, "Archived payments must be copied into the snapshot.");

  const reportSource = sourceBetween(index, "function renderArchive()", "function renderSettlements()");
  const splitPosition = reportSource.indexOf('const closedReceivables = records.filter((record) => record.type === "Closed Receivable")');
  const transactionPosition = reportSource.indexOf('const statementTransactions = records.filter((record) => record.type !== "Closed Receivable")');
  const transactionRenderPosition = reportSource.indexOf("statementTransactions.forEach(renderRecord)");
  const headingPosition = reportSource.indexOf("<strong>Closed Receivables</strong> - collected orders archived when this balance closed");
  const receivableRenderPosition = reportSource.indexOf("closedReceivables.forEach(renderRecord)");
  assert.ok(splitPosition >= 0 && transactionPosition > splitPosition);
  assert.ok(transactionRenderPosition > transactionPosition);
  assert.ok(headingPosition > transactionRenderPosition);
  assert.ok(receivableRenderPosition > headingPosition);
  assert.match(index, /type: "Closed Receivable"[\s\S]*status: voided \? "Voided - Excluded" : "Collected"/);
  assert.match(index, /receivable\.creditReminder \? `Credit Reminder: \$\{receivable\.creditReminder\}` : ""/);

  assert.match(mobileApp, /<Panel title="Collected receivables" badge=\{String\(archivedReceivableCount\)\} badgeTone="good">/);
  assert.match(mobileApp, /receivable\.creditReminder \? <Text style=\{styles\.archiveDetailMeta\}>Credit Reminder: \{receivable\.creditReminder\}<\/Text> : null/);
});

test("server hides archived reminders and non-Master saves cannot replace archives", async () => {
  const server = await readRepositoryFile("server.mjs");
  const privacySource = sourceBetween(
    server,
    "function sessionCanAccessCreditReminder",
    "function sanitizeIncomingWorkspaceState",
  );
  const { stripRestrictedCreditReminders } = new Function(
    `${privacySource}\nreturn { stripRestrictedCreditReminders };`,
  )();
  const receivable = (id, borrowerActorId, creditReminder) => ({
    id,
    borrower: borrowerActorId === "ACT-1" ? "Broker One" : "Broker Two",
    borrowerActorId,
    creditReminder,
  });
  const workspaceState = {
    receivables: [
      receivable("ACTIVE-OWN", "ACT-1", "Own active reminder"),
      receivable("ACTIVE-OTHER", "ACT-2", "Private active reminder"),
    ],
    archives: [{
      id: "ARC-1",
      receivables: [
        receivable("CLOSED-OWN", "ACT-1", "Own archived reminder"),
        receivable("CLOSED-OTHER", "ACT-2", "Private archived reminder"),
      ],
    }],
  };
  const brokerSession = {
    membership: {
      role: "Actor",
      actorRole: "Broker",
      actorId: "ACT-1",
      actorName: "Broker One",
    },
  };
  const brokerView = stripRestrictedCreditReminders(workspaceState, brokerSession);
  assert.equal(brokerView.receivables[0].creditReminder, "Own active reminder");
  assert.equal("creditReminder" in brokerView.receivables[1], false);
  assert.equal(brokerView.archives[0].receivables[0].creditReminder, "Own archived reminder");
  assert.equal("creditReminder" in brokerView.archives[0].receivables[1], false);

  const agentView = stripRestrictedCreditReminders(workspaceState, {
    membership: { ...brokerSession.membership, actorRole: "Agent" },
  });
  assert.ok(agentView.receivables.every((item) => !("creditReminder" in item)));
  assert.ok(agentView.archives[0].receivables.every((item) => !("creditReminder" in item)));

  const masterView = stripRestrictedCreditReminders(workspaceState, { membership: { role: "Master" } });
  assert.equal(masterView.receivables[1].creditReminder, "Private active reminder");
  assert.equal(masterView.archives[0].receivables[1].creditReminder, "Private archived reminder");

  const archiveMergeSource = sourceBetween(server, "function mergeByKey", "function mergeChatConversations");
  const mergeArchiveSnapshots = new Function(
    `${archiveMergeSource}\nreturn mergeArchiveSnapshots;`,
  )();
  const storedArchive = {
    id: "ARC-MERGE",
    actor: "Broker One",
    closedAt: "2026-08-09T10:00:00.000Z",
    orders: [],
    transfers: [],
    ledger: [],
    receivables: [{
      id: "REC-MERGE",
      orderId: "ORD-MERGE",
      createdAt: "2026-08-09T09:00:00.000Z",
      borrower: "Broker One",
      borrowerActorId: "ACT-1",
      currency: "USD",
      principalMinor: 10_000,
      creditReminder: "Stored archived reminder",
      payments: [],
    }],
  };
  const staleArchive = {
    ...storedArchive,
    receivables: storedArchive.receivables.map(({ creditReminder, ...item }) => item),
  };
  const [mergedArchive] = mergeArchiveSnapshots([storedArchive], [staleArchive]);
  assert.equal(mergedArchive.receivables[0].creditReminder, "Stored archived reminder");

  const archiveAssignment = server.indexOf("sanitized.archives = structuredClone(persistedState.archives || [])");
  assert.notEqual(archiveAssignment, -1);
  const archiveGuardStart = server.lastIndexOf("  if (", archiveAssignment);
  const archiveGuardEnd = server.indexOf("\n  }", archiveAssignment);
  assert.notEqual(archiveGuardStart, -1);
  assert.notEqual(archiveGuardEnd, -1);
  const archiveGuardSource = server.slice(archiveGuardStart, archiveGuardEnd + 4);
  assert.match(archiveGuardSource, /session\?\.membership\?\.role !== "Master"/);
  const protectArchives = new Function(
    "sanitized",
    "persistedState",
    "session",
    `${archiveGuardSource}\nreturn sanitized;`,
  );
  const persistedArchives = [{ id: "ARC-STORED", receivables: [{ id: "REC-STORED", creditReminder: "Stored" }] }];
  const forgedArchives = [{ id: "ARC-FORGED", receivables: [] }];
  const actorSanitized = protectArchives(
    { archives: forgedArchives },
    { archives: persistedArchives },
    brokerSession,
  );
  assert.deepEqual(actorSanitized.archives, persistedArchives);
  assert.notEqual(actorSanitized.archives, persistedArchives, "Protected archives should be cloned from persisted state.");
  const masterSanitized = protectArchives(
    { archives: forgedArchives },
    { archives: persistedArchives },
    { membership: { role: "Master" } },
  );
  assert.equal(masterSanitized.archives, forgedArchives);
});
