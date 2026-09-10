import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sources = [
  ["web", new URL("../index.html", import.meta.url)],
  ["web preview", new URL("../preview.html", import.meta.url)],
  ["mobile", new URL("../mobile/src/domain/workspace.ts", import.meta.url)],
];

test("new manual journals include a non-Actor Master balancing line", async () => {
  for (const [name, url] of sources) {
    const source = await readFile(url, "utf8");
    const functionStart = source.indexOf("function postActorJournal(");
    const functionEnd = source.indexOf("function postActorWithdrawal(", functionStart);
    assert.notEqual(functionStart, -1, `${name} is missing postActorJournal`);
    assert.notEqual(functionEnd, -1, `${name} is missing postActorWithdrawal`);
    const journalFunction = source.slice(functionStart, functionEnd);

    assert.match(journalFunction, /source: "JOURNAL"/);
    assert.match(journalFunction, /account: `\$\{actor(?:Name|\.name)\} ACTOR_CLEARING`/);
    assert.match(journalFunction, /direction: "Debit"/);
    assert.match(journalFunction, /source: "JOURNAL_BALANCING"/);
    assert.match(journalFunction, /account: "MASTER_JOURNAL_CLEARING"/);
    assert.match(journalFunction, /direction: "Credit"/);
  }
});
