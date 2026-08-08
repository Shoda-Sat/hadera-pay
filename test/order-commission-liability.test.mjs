import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function loadMoneyModule(source) {
  const outputText = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  const module = { exports: {} };
  new Function("exports", "module", "require", outputText)(module.exports, module, () => {
    throw new Error("The money module should not have runtime imports.");
  });
  return module.exports;
}

function loadWebCommissionHelpers(source) {
  const helperBlock = source.match(/const orderCommissionLiabilityOptions = \["Broker", "Master"\];[\s\S]*?(?=\n    const state = loadState\(\);)/)?.[0];
  assert.ok(helperBlock, "Web order commission helpers are missing");
  return new Function(`${helperBlock}\nreturn { normalizedOrderCommissionLiability, orderCommissionAmountMinor, signedOrderCommissionMinor, orderCommissionLedgerTerms };`)();
}

function sourceCurrencyLedger(order, terms) {
  return [
    { account: `${order.broker} ACTOR_CLEARING`, direction: "Debit", amountMinor: order.sourceAmountMinor },
    { account: `${order.broker} ACTOR_CLEARING`, direction: terms.brokerDirection, amountMinor: terms.amountMinor },
    { account: "MASTER_FX_CLEARING", direction: "Credit", amountMinor: order.sourceAmountMinor },
    { account: terms.masterAccount, direction: terms.masterDirection, amountMinor: terms.amountMinor }
  ].filter((line) => line.amountMinor > 0);
}

function ledgerBalance(lines) {
  return lines.reduce((total, line) => total + (line.direction === "Debit" ? line.amountMinor : -line.amountMinor), 0);
}

function actorNet(lines, actorName) {
  const account = `${actorName} ACTOR_CLEARING`;
  return lines
    .filter((line) => line.account === account)
    .reduce((total, line) => total + (line.direction === "Debit" ? line.amountMinor : -line.amountMinor), 0);
}

test("positive and negative order commissions select the correct liable party", async () => {
  const [index, preview, mobileMoney] = await Promise.all([
    readFile(path.join(repositoryRoot, "index.html"), "utf8"),
    readFile(path.join(repositoryRoot, "preview.html"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/utils/money.ts"), "utf8")
  ]);
  assert.equal(index, preview);

  const mobile = loadMoneyModule(mobileMoney);
  const web = loadWebCommissionHelpers(index);
  const baseDraft = {
    sourceCurrency: "USD",
    payoutCurrency: "ETB",
    sourceAmount: "100",
    payoutAmount: "20000",
    rate: "200"
  };
  const positiveQuote = mobile.calculateQuote({ ...baseDraft, commissionPercent: "2" });
  const negativeQuote = mobile.calculateQuote({ ...baseDraft, commissionPercent: "-2" });

  assert.equal(positiveQuote.commissionAmount, 2);
  assert.equal(positiveQuote.grossAmount, 102);
  assert.equal(negativeQuote.commissionAmount, -2);
  assert.equal(negativeQuote.grossAmount, 98);

  for (const helpers of [mobile, web]) {
    const positiveOrder = {
      broker: "Broker A",
      sourceAmountMinor: 10_000,
      commissionPercent: 2,
      commissionMinor: 200,
      orderCommissionLiability: "Broker"
    };
    const negativeOrder = {
      broker: "Broker A",
      sourceAmountMinor: 10_000,
      commissionPercent: -2,
      commissionMinor: -200,
      orderCommissionLiability: "Master"
    };
    const positiveTerms = helpers.orderCommissionLedgerTerms(positiveOrder);
    const negativeTerms = helpers.orderCommissionLedgerTerms(negativeOrder);

    assert.deepEqual(
      { liability: positiveTerms.liability, amountMinor: positiveTerms.amountMinor, brokerDirection: positiveTerms.brokerDirection, masterDirection: positiveTerms.masterDirection, masterAccount: positiveTerms.masterAccount },
      { liability: "Broker", amountMinor: 200, brokerDirection: "Debit", masterDirection: "Credit", masterAccount: "MASTER_FEE_REVENUE" }
    );
    assert.deepEqual(
      { liability: negativeTerms.liability, amountMinor: negativeTerms.amountMinor, brokerDirection: negativeTerms.brokerDirection, masterDirection: negativeTerms.masterDirection, masterAccount: negativeTerms.masterAccount },
      { liability: "Master", amountMinor: 200, brokerDirection: "Credit", masterDirection: "Debit", masterAccount: "MASTER_COMMISSION_EXPENSE" }
    );

    const positiveLines = sourceCurrencyLedger(positiveOrder, positiveTerms);
    const negativeLines = sourceCurrencyLedger(negativeOrder, negativeTerms);
    assert.equal(ledgerBalance(positiveLines), 0);
    assert.equal(ledgerBalance(negativeLines), 0);
    assert.equal(actorNet(positiveLines, "Broker A"), 10_200, "Positive commission remains payable by the Broker");
    assert.equal(actorNet(negativeLines, "Broker A"), 9_800, "Negative commission is paid by Master to the Broker");
    assert.equal(helpers.signedOrderCommissionMinor(positiveOrder), 200);
    assert.equal(helpers.signedOrderCommissionMinor(negativeOrder), -200);
  }
});

test("web and Android post the liability lines without changing forwarding terms", async () => {
  const [index, mobileApp, mobileClient, mobileWorkspace, mobileScreens] = await Promise.all([
    readFile(path.join(repositoryRoot, "index.html"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/App.tsx"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/api/client.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/domain/workspace.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/screens/WorkspaceScreens.tsx"), "utf8")
  ]);

  const webPreview = index.match(/function buildJournalPreview\(\) \{[\s\S]*?(?=\n    function activeActors\()/)?.[0] || "";
  const webPayment = index.match(/function postOrderPayment\(order\) \{[\s\S]*?(?=\n    function archiveOrderSnapshot\()/)?.[0] || "";
  const webPayer = index.match(/function payingActorStatement\(order\) \{[\s\S]*?(?=\n    function settlementFor\()/)?.[0] || "";
  const mobilePayment = mobileWorkspace.match(/export async function markOrderPaid\([\s\S]*?(?=\nexport async function requestOrderVoid\()/)?.[0] || "";
  const mobilePayer = mobileWorkspace.match(/function payingActorStatement\([\s\S]*?(?=\ntype BuyingRates)/)?.[0] || "";
  const mobileAssign = mobileWorkspace.match(/export async function assignOrder\([\s\S]*?(?=\nexport async function returnOrder\()/)?.[0] || "";

  for (const block of [webPreview, webPayment, mobilePayment]) {
    assert.match(block, /orderCommissionLedgerTerms/);
    assert.match(block, /brokerDirection/);
    assert.match(block, /masterDirection/);
    assert.match(block, /masterAccount/);
  }
  assert.match(index, /const commissionMinor = signedOrderCommissionMinor\(order\);[\s\S]*const collectedMinor = sourceAmountMinor \+ commissionMinor;/);
  assert.match(mobileWorkspace, /const collectedMinor = Number\(order\.sourceAmountMinor \|\| 0\) \+ signedOrderCommissionMinor\(order\);/);
  assert.match(mobileScreens, /order\.incomeCollectedOriginalMinor \?\?[\s\S]*signedOrderCommissionMinor\(order\)/);
  assert.match(mobileClient, /commissionMinor: minorFromMajor\(quote\.commissionAmount, sourceCurrency\)/);
  assert.match(mobileClient, /orderCommissionLiability: commissionPercent < 0 \? "Master" : "Broker"/);
  assert.match(mobileApp, /label=\{fixedCommission !== null \? "Commission % \(fixed by Master\)" : "Commission %"\}[\s\S]*?keyboardType="numeric"/);

  for (const payerBlock of [webPayer, mobilePayer]) {
    assert.match(payerBlock, /forwardedPayoutDivider/);
    assert.match(payerBlock, /forwardedPayoutPercent/);
    assert.doesNotMatch(payerBlock, /commissionMinor|commissionPercent|orderCommissionLiability/);
  }
  assert.match(mobileAssign, /order\.forwardedPayoutDivider/);
  assert.match(mobileAssign, /order\.forwardedPayoutPercent/);
  assert.doesNotMatch(mobileAssign, /commissionMinor|commissionPercent|orderCommissionLiability/);
});
