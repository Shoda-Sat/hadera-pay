import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("mobile badges wrap whole words instead of individual letters", async () => {
  const source = await readFile(path.join(repositoryRoot, "mobile/src/components/ui.tsx"), "utf8");
  const pillStyle = source.match(/\n  pill: \{([\s\S]*?)\n  \},/)?.[1] || "";
  const pillTextStyle = source.match(/\n  pillText: \{([\s\S]*?)\n  \},/)?.[1] || "";

  assert.match(source, /const words = label\.trim\(\)\.split\(\/\\s\+\/\)\.filter\(Boolean\)/);
  assert.match(source, /words\.map\(\(word, index\) => \([\s\S]*?numberOfLines=\{1\}/);
  assert.match(pillStyle, /flexWrap: "wrap"/);
  assert.doesNotMatch(pillStyle, /maxWidth/);
  assert.doesNotMatch(pillTextStyle, /flexShrink/);
});
