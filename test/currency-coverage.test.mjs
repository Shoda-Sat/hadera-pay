import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function source(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

test("LYD is available across server, web, and Android currency definitions", async () => {
  const [server, index, preview, mobileTypes, mobileClient, mobileWorkspace] = await Promise.all([
    source("server.mjs"),
    source("index.html"),
    source("preview.html"),
    source("mobile/src/types.ts"),
    source("mobile/src/api/client.ts"),
    source("mobile/src/domain/workspace.ts"),
  ]);

  assert.equal(index, preview);
  assert.match(server, /supportedCurrencies\s*=\s*\[[^\]]*"LYD"/);
  assert.match(index, /supportedCurrencies\s*=\s*\[[^\]]*"LYD"/);
  assert.match(index, /currencyDecimalPlaces\s*=\s*\{[^}]*LYD:\s*3/);
  assert.match(index, /data-rate="usdToLyd"/);
  assert.match(mobileTypes, /Currency\s*=\s*[^;]*"LYD"/);
  assert.match(mobileClient, /\["USD",\s*"ETB",\s*"EUR",\s*"ERN",\s*"SSP",\s*"SDG",\s*"LYD"\]/);
  assert.match(mobileWorkspace, /supportedCurrencies[^=]*=\s*\[[^\]]*"LYD"/);

  const inlineScripts = Array.from(index.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g), (match) => match[1])
    .filter((script) => script.trim());
  assert.ok(inlineScripts.length > 0);
  inlineScripts.forEach((script) => {
    assert.doesNotThrow(() => new Function(script));
  });
});

test("Android stores LYD in thousandths without changing existing currency factors", async () => {
  const moneySource = await source("mobile/src/utils/money.ts");
  const transpiled = ts.transpileModule(moneySource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  new Function("exports", "module", transpiled)(module.exports, module);
  const money = module.exports;

  assert.equal(money.currencyDecimals("LYD"), 3);
  assert.equal(money.currencyFactor("LYD"), 1000);
  assert.equal(money.minorFromMajor(1.234, "LYD"), 1234);
  assert.equal(money.majorFromMinor(1234, "LYD"), 1.234);
  assert.equal(money.currencyFactor("USD"), 100);
  assert.equal(money.currencyFactor("ETB"), 1);
});
