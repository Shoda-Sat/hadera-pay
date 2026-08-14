import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function loadMoneyModule(source) {
  const outputText = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const module = { exports: {} };
  new Function("exports", "module", "require", outputText)(module.exports, module, () => {
    throw new Error("The money module should not have runtime imports.");
  });
  return module.exports;
}

function webFixedCommissionHelper(source, actors) {
  const helper = source.match(/function fixedOrderCommissionFor\(brokerName\) \{[\s\S]*?(?=\n    function applyFixedOrderCommission\()/)?.[0];
  assert.ok(helper, "The web fixed-commission helper is missing");
  return new Function("activeActors", `${helper}\nreturn fixedOrderCommissionFor;`)(() => actors);
}

test("fixed order commission accepts signed and zero percentages", async () => {
  const [index, preview, mobileMoney] = await Promise.all([
    readFile(path.join(repositoryRoot, "index.html"), "utf8"),
    readFile(path.join(repositoryRoot, "preview.html"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/utils/money.ts"), "utf8")
  ]);
  assert.equal(index, preview);

  const mobile = loadMoneyModule(mobileMoney);
  const actors = [
    { name: "Positive", orderFixedCommission: { enabled: true, percent: 2 } },
    { name: "Negative", orderFixedCommission: { enabled: true, percent: -2 } },
    { name: "Zero", orderFixedCommission: { enabled: true, percent: 0 } },
    { name: "Disabled", orderFixedCommission: { enabled: false, percent: 3 } },
    { name: "Blank", orderFixedCommission: { enabled: true, percent: "" } }
  ];
  const webFixedCommissionFor = webFixedCommissionHelper(index, actors);

  for (const [actor, expected] of [[actors[0], 2], [actors[1], -2], [actors[2], 0], [actors[3], null], [actors[4], null]]) {
    assert.equal(mobile.fixedOrderCommissionForActor(actor), expected);
    assert.equal(webFixedCommissionFor(actor.name), expected);
  }

  const fixedNegative = mobile.fixedOrderCommissionForActor(actors[1]);
  const quote = mobile.calculateQuote({
    sourceCurrency: "USD",
    payoutCurrency: "ETB",
    sourceAmount: "100",
    payoutAmount: "20000",
    rate: "200",
    commissionPercent: String(fixedNegative)
  });
  assert.equal(quote.commissionAmount, -2);
  assert.equal(quote.grossAmount, 98);
  assert.equal(mobile.normalizedOrderCommissionLiability({ commissionPercent: fixedNegative, commissionMinor: -200 }), "Master");
});

test("Master can configure and Actors cannot override a fixed commission on web or Android", async () => {
  const [index, mobileApp, mobileClient, mobileDomain, mobileScreens, mobileTypes, server] = await Promise.all([
    readFile(path.join(repositoryRoot, "index.html"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/App.tsx"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/api/client.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/domain/workspace.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/screens/WorkspaceScreens.tsx"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/types.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "server.mjs"), "utf8")
  ]);

  assert.match(index, /Fixed Order Rates &amp; Commission/);
  assert.match(index, /class="fixed-order-commission"/);
  assert.match(index, /class="btn primary save-fixed-order-commission"/);
  assert.match(index, /class="btn \$\{fixedCommission !== null \? "danger" : "primary"\} toggle-fixed-order-commission"/);
  assert.match(index, /function applyFixedOrderCommission\(\)[\s\S]*commissionInput\.disabled = true/);
  assert.match(index, /const commissionPercent = fixedCommission !== null \? fixedCommission : enteredCommission/);
  assert.match(index, /document\.activeElement\?\.closest\?\.\("\.fixed-order-rate, \.fixed-order-commission"\)/);
  assert.match(index, /if \(!signedInAsMaster\(\)\) return;[\s\S]*actor\.orderFixedCommission/);
  assert.match(index, /"\.save-fixed-order-commission", "\.toggle-fixed-order-commission"/);

  assert.match(mobileTypes, /orderFixedCommission\?: \{ enabled\?: boolean; percent\?: number \| string \}/);
  assert.match(mobileApp, /fixedOrderCommissionForActor\(actor\)/);
  assert.match(mobileApp, /label=\{fixedCommission !== null \? "Commission % \(fixed by Master\)" : "Commission %"\}/);
  assert.match(mobileApp, /editable=\{fixedCommission === null\}/);
  assert.match(mobileClient, /const commissionPercent = fixedCommission !== null[\s\S]*commissionPercent: String\(commissionPercent\)/);
  assert.match(mobileDomain, /orderFixedCommission\?: \{ enabled: boolean; percent: number \}/);
  assert.match(mobileDomain, /actor\.orderFixedCommission = \{[\s\S]*enabled:[\s\S]*percent/);
  assert.match(mobileScreens, /<Panel title="Fixed order commission" badge="Brokers">/);
  assert.match(mobileScreens, /updateActorOrderSettings\(actor\.id, \{ orderFixedCommission: \{ enabled: draft\.enabled, percent \} \}\)/);

  assert.match(server, /for \(const field of \["orderFixedRates", "orderFixedCommission"\]\)/);
  assert.match(server, /state = resolveIncomingWorkspaceRecordCollisions\(persistedState, state,[\s\S]*brokerActorId: session\.membership\.actorId/);
  assert.match(server, /const isReturnedResubmission = persistedBelongsToSessionActor && persistedOrder\.state === "Returned" && allowedOrder\?\.state === "Pending Forward"/);
  assert.match(server, /brokerActorId: isReturnedResubmission \? persistedOrder\.brokerActorId \|\| session\.membership\.actorId : session\.membership\.actorId/);
  assert.match(server, /for \(const field of \["commissionPercent", "commissionMinor", "grossMinor", "orderCommissionLiability"\]\)/);
  assert.match(server, /commissionPercent: fixedPercent,[\s\S]*grossMinor: sourceAmountMinor \+ commissionMinor,[\s\S]*orderCommissionLiability: fixedPercent < 0 \? "Master" : "Broker"/);

  const mobileAssign = mobileDomain.match(/export async function assignOrder\([\s\S]*?(?=\nexport async function returnOrder\()/)?.[0] || "";
  assert.match(mobileAssign, /forwardedPayoutDivider/);
  assert.match(mobileAssign, /forwardedPayoutPercent/);
  assert.doesNotMatch(mobileAssign, /orderFixedCommission/);
});
