import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `Missing ${startMarker}`);
  assert.notEqual(end, -1, `Missing ${endMarker}`);
  return source.slice(start, end);
}

test("Transfers shows current journals and withdrawals to Master and only the concerned Actor", async () => {
  const web = await readFile(path.join(repositoryRoot, "index.html"), "utf8");
  const mobile = await readFile(path.join(repositoryRoot, "mobile/src/screens/WorkspaceScreens.tsx"), "utf8");
  const state = {
    ledger: [
      { source: "JOURNAL", account: "Nahom ACTOR_CLEARING", postedAt: "2026-08-20T09:00:00.000Z" },
      { source: "WITHDRAWAL", account: "Walta ACTOR_CLEARING", postedAt: "2026-08-20T10:00:00.000Z" },
      { source: "JOURNAL", account: "MASTER_FX_CLEARING", postedAt: "2026-08-20T11:00:00.000Z" },
      { source: "WITHDRAWAL", account: "Nahom ACTOR_CLEARING", archived: true, postedAt: "2026-08-20T12:00:00.000Z" },
    ],
  };
  const historySource = sourceBetween(web, "function transferJournalHistoryLines(actor)", "function renderTransferJournalHistory(actor)");
  const transferJournalHistoryLines = new Function(
    "state",
    "activeLedgerLines",
    `${historySource}\nreturn transferJournalHistoryLines;`
  )(state, (lines) => lines.filter((line) => line.archived !== true));

  assert.deepEqual(
    transferJournalHistoryLines({ role: "Master" }).map((line) => line.account),
    ["Walta ACTOR_CLEARING", "Nahom ACTOR_CLEARING"]
  );
  assert.deepEqual(
    transferJournalHistoryLines({ role: "Broker", name: "Nahom" }).map((line) => line.account),
    ["Nahom ACTOR_CLEARING"]
  );
  assert.match(web, /id="transferJournalHistory"/);
  assert.match(web, /renderTransferJournalHistory\(actor\)/);
  assert.match(mobile, /const journalWithdrawalEntries = useMemo/);
  assert.match(mobile, /line\.account === `\$\{session\.actorName\} ACTOR_CLEARING`/);
});
