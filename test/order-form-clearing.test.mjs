import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("create-order fields start empty and cleared conversion fields stay empty", async () => {
  const [index, preview, mobileMoney] = await Promise.all([
    readFile(path.join(repositoryRoot, "index.html"), "utf8"),
    readFile(path.join(repositoryRoot, "preview.html"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/utils/money.ts"), "utf8")
  ]);

  assert.equal(index, preview);
  for (const fieldId of ["sourceAmount", "rate", "commission", "senderName", "receiverName", "accountNumber", "phoneNumber"]) {
    const input = index.match(new RegExp(`<input id="${fieldId}"[^>]*>`))?.[0] || "";
    assert.ok(input, `Missing create-order field ${fieldId}`);
    assert.doesNotMatch(input, /\svalue=/, `${fieldId} should not contain a prefilled value`);
  }

  assert.doesNotMatch(index, /Samir Ali|Amina Tesfaye|value="1000\.00"|value="56\.50"|value="1\.50"/);
  assert.match(index, /if \(recordTouch && changedInput && !changedInput\.value\.trim\(\)\) return;/);
  assert.match(mobileMoney, /if \(activeField && !String\(draft\[activeField\] \|\| ""\)\.trim\(\)\) return draft;/);
});
