import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("chat go-to-bottom controls are compact icon-only buttons on web and Android", async () => {
  const [index, preview, mobileApp] = await Promise.all([
    readFile(path.join(repositoryRoot, "index.html"), "utf8"),
    readFile(path.join(repositoryRoot, "preview.html"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/App.tsx"), "utf8")
  ]);

  assert.equal(index, preview);
  assert.match(index, /\.chat-bottom-button \{[\s\S]*width: 36px;[\s\S]*height: 36px;/);
  assert.match(index, /id="chatBottomButton"[^>]+aria-label="Go to the newest chat message"/);
  assert.doesNotMatch(index, /<svg[^>]*><path d="m6 9 6 6 6-6"\/><\/svg>\s*Go to bottom/);

  assert.match(mobileApp, /style=\{styles\.chatBottomButton\}[\s\S]*<ChevronDown size=\{17\}/);
  assert.match(mobileApp, /chatBottomButton: \{[\s\S]*width: 36,[\s\S]*height: 36,/);
  assert.doesNotMatch(mobileApp, /chatBottomButtonText|>Bottom<\/Text>/);
});
