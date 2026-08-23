import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function loadTypeScriptModule(source, dependencies = {}) {
  const outputText = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  new Function("exports", "module", "require", outputText)(module.exports, module, (specifier) => {
    if (Object.prototype.hasOwnProperty.call(dependencies, specifier)) return dependencies[specifier];
    throw new Error(`Unexpected runtime import: ${specifier}`);
  });
  return module.exports;
}

function emptyWorkspace(overrides = {}) {
  return {
    actors: [],
    orders: [],
    receivables: [],
    savedCustomers: [],
    transfers: [],
    ledger: [],
    masterBankEntries: [],
    archives: [],
    settlements: [],
    chatConversations: [],
    ...overrides,
  };
}

test("Android close API sends the chosen cancellation policy and honors deleted-order tombstones", async () => {
  const source = await readFile(path.join(repositoryRoot, "mobile/src/api/client.ts"), "utf8");
  const storage = {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  };
  const client = loadTypeScriptModule(source, {
    "@react-native-async-storage/async-storage": storage,
    "expo-file-system": {},
    "../domain/ledgerNumbering": {
      ensureActorLedgerNumbers: () => undefined,
      nextActorLedgerSequence: () => 1,
    },
    "../domain/routingDurability": {},
    "../utils/money": {},
    "../utils/orderParticipantRetention": {
      retainOrdersForUnclosedParticipants: (orders, _archives, _ledger, _actors, deletedOrderIds = []) => {
        const deleted = new Set(deletedOrderIds);
        return (orders || []).filter((order) => !deleted.has(order.id));
      },
    },
  });
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (String(url).endsWith("/api/session")) {
      return {
        ok: true,
        text: async () => JSON.stringify({
          session: {
            user: { id: "USR-MASTER", name: "Master", email: "master@example.com" },
            workspace: { id: "WS-1", name: "Workspace" },
            membership: { role: "Master", actorRole: "Master", actorId: "ACT-MASTER", actorName: "Master", currency: "USD" }
          }
        }),
      };
    }
    if (String(url).endsWith("/api/app-state") && String(options?.method || "GET") === "GET") {
      return {
        ok: true,
        text: async () => JSON.stringify({ revision: "revision-before-close", state: emptyWorkspace() }),
      };
    }
    return {
      ok: true,
      text: async () => JSON.stringify({
        revision: "revision-after-close",
        state: emptyWorkspace({
          deletedOrderIds: ["ORD-CANCELLED", "ORD-CANCELLED", ""],
          orders: [
            { id: "ORD-CANCELLED", createdAt: "2026-08-13T08:00:00.000Z" },
            { id: "ORD-ACTIVE", createdAt: "2026-08-13T09:00:00.000Z" },
          ],
        }),
      }),
    };
  };

  try {
    await client.getCurrentSession();
    await client.loadWorkspaceState();
    const state = await client.closeActorBalance("ACT-BROKER", "omit", "revision-before-close");
    assert.deepEqual(state.deletedOrderIds, ["ORD-CANCELLED"]);
    assert.deepEqual(state.orders.map((order) => order.id), ["ORD-ACTIVE"]);
    assert.equal(state.offlineSnapshot, false);
    assert.equal(requests.length, 3);
    assert.equal(requests[2].url, "https://haderapay.com/api/app-state/close-balance");
    assert.equal(requests[2].options.method, "POST");
    assert.deepEqual(JSON.parse(requests[2].options.body), {
      actorId: "ACT-BROKER",
      cancelledOrderPolicy: "omit",
      expectedRevision: "revision-before-close",
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("Android report and PDF keep cancelled amounts informational and exclude them from financial columns", async () => {
  const source = await readFile(path.join(repositoryRoot, "mobile/src/domain/reportPdf.ts"), "utf8");
  const report = loadTypeScriptModule(source, {
    "../utils/date": {
      formatDate: (value) => `DATE:${String(value || "")}`,
      formatDateTime: (value) => `TIME:${String(value || "")}`,
      formatMonthYear: (value) => String(value || ""),
    },
    "../utils/money": {
      currencies: ["USD"],
      currencyDecimals: () => 2,
      majorFromMinor: (minor) => Number(minor || 0) / 100,
    },
  });
  const cancelledAt = "2026-08-13T10:15:00.000Z";
  const archive = {
    id: "ARC-1",
    actor: "Renamed Broker",
    actorId: "ACT-BROKER",
    actorRole: "Broker",
    actorCurrency: "USD",
    closedAt: "2026-08-13T11:00:00.000Z",
    balances: {},
    orders: [{
      id: "ORD-CANCELLED",
      brokerOrderNumber: "BRK234",
      broker: "Old Broker Name",
      brokerActorId: "ACT-BROKER",
      agent: "Cancelled",
      sourceCurrency: "USD",
      payoutCurrency: "USD",
      sourceAmountMinor: 10_000,
      payoutAmountMinor: 10_000,
      state: "Cancelled",
      excludedFromCalculations: true,
      cancelledBy: "Master",
      cancelledAt,
      sentAt: "2026-08-12T08:00:00.000Z",
      createdAt: "2026-08-12T07:00:00.000Z",
    }],
  };
  const viewer = {
    actorId: "ACT-BROKER",
    actorName: "Renamed Broker",
    actorRole: "Broker",
  };

  const [row] = report.archiveReportPdfRows([archive], [], viewer);
  assert.equal(row.status, "Cancelled - Excluded");
  assert.equal(row.cancelled, true);
  assert.equal(row.voided, false);
  assert.equal(row.date, `DATE:${cancelledAt}`);
  assert.equal(row.amount, "100.00 USD");
  assert.equal(row.currencyAmounts.USD, "100.00");
  assert.match(row.details, /Cancelled by: Master/);
  assert.match(row.details, /Original amount shown for reference only/);
  assert.match(row.details, /Excluded from all calculations/);

  const html = report.buildArchiveReportPdfHtml("Cancelled report", [archive], [], viewer);
  assert.match(html, /<tr class="void-row">/);
  assert.match(html, /100\.00 USD<\/td>/);
  assert.match(html, /<td><\/td>\s*<td>Cancelled - Excluded<\/td>/);
});

test("Android UI exposes the guarded Master close choices and stable archive visibility", async () => {
  const [app, client, screens, types] = await Promise.all([
    readFile(path.join(repositoryRoot, "mobile/App.tsx"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/api/client.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/screens/WorkspaceScreens.tsx"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/types.ts"), "utf8"),
  ]);

  assert.match(types, /deletedOrderIds\?: string\[\]/);
  assert.match(client, /export async function closeActorBalance/);
  assert.match(client, /"\/api\/app-state\/close-balance"/);
  assert.match(screens, /label="Close Balance"/);
  assert.match(screens, /disabled=\{offline \|\| session\.subscriptionReadOnly === true\}/);
  assert.match(screens, /Keep in Report & Close/);
  assert.match(screens, /closeWithPolicy\(selected, "include", closePromptRevision\)/);
  assert.match(screens, /Remove without Report & Close/);
  assert.match(screens, /closeWithPolicy\(selected, "omit", closePromptRevision\)/);
  assert.match(screens, /Cancelled - Excluded/);
  assert.match(screens, /!\["Unassigned", "Cancelled"\]\.includes\(order\.agent\)/);
  assert.match(screens, /archive\.actorId\s*\? archive\.actorId === session\.actorId\s*:\s*archive\.actor === session\.actorName/);
  assert.match(app, /archive\.actorId\s*\? archive\.actorId === session\.actorId\s*:\s*archive\.actor === session\.actorName/);
  assert.match(app, /b\.cancelledAt \|\| b\.voidedAt \|\| b\.paidAt/);
  assert.match(app, /Original amount \(informational\):/);
});
