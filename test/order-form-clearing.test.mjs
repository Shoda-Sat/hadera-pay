import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("create-order fields and cleared payer terms stay empty", async () => {
  const [index, preview, mobileMoney, mobileClient, mobileWorkspace, mobileScreens, server] = await Promise.all([
    readFile(path.join(repositoryRoot, "index.html"), "utf8"),
    readFile(path.join(repositoryRoot, "preview.html"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/utils/money.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/api/client.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/domain/workspace.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/screens/WorkspaceScreens.tsx"), "utf8"),
    readFile(path.join(repositoryRoot, "server.mjs"), "utf8")
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

  const forwardPercentInput = index.match(/<input id="forwardPercent-\$\{order\.id\}"[^>]*>/)?.[0] || "";
  assert.ok(forwardPercentInput, "Missing Master payer-percentage field");
  assert.match(forwardPercentInput, /value="\$\{escapeHtml\(forwardingPercentValue\)\}"/);
  assert.match(index, /const forwardingPercentValue = displayedRoutingAttempt[\s\S]*: forwardedPayoutPercentInputValue\(order\);/,
    "Normal Master routing must still leave an unset payer percentage empty outside an unresolved retry.");
  assert.doesNotMatch(forwardPercentInput, /commissionPercent/, "The order commission must not prefill the payer percentage");
  assert.match(index, /function forwardedPayoutPercentValue\(order\)[\s\S]*hasOwnProperty\.call\(order \|\| \{\}, "forwardedPayoutPercent"\)[\s\S]*return null;/);
  assert.match(index, /function forwardedPayoutPercentInputValue\(order\)[\s\S]*forwardedPayoutPercentValue\(order\)[\s\S]*percent === null \? ""/);
  assert.match(index, /if \(percentText\) \{[\s\S]*order\.forwardedPayoutPercent = forwardedPercent;[\s\S]*\} else \{[\s\S]*delete order\.forwardedPayoutPercent;/);
  assert.match(mobileClient, /forwardedPayoutPercent: undefined/);
  assert.match(mobileWorkspace, /if \(percentText\) order\.forwardedPayoutPercent = percent;[\s\S]*else delete order\.forwardedPayoutPercent;/);
  for (const legacyField of [
    "manualSpecialPayoutDivider",
    "manualSpecialPayoutPercent",
    "manualMasterRateDivider",
    "manualMasterRatePercent"
  ]) {
    assert.match(index, new RegExp(`delete order\\.${legacyField};`), `Web forwarding must clear ${legacyField}`);
    assert.match(mobileWorkspace, new RegExp(`delete order\\.${legacyField};`), `Android forwarding must clear ${legacyField}`);
  }

  assert.match(index, /function orderCommissionSummary\(order, viewer\)[\s\S]*orderViewerIsAssignedPayer\(order, viewer\)[\s\S]*if \(percent === null\) return null;[\s\S]*label: "Payer %"/);
  assert.match(index, /function ledgerOrderPercent\(order, ledgerActor\)[\s\S]*orderViewerIsAssignedPayer\(order, ledgerActor\)[\s\S]*forwardedPayoutPercentValue\(order\)/);
  assert.match(mobileScreens, /function orderPercentDisplayForViewer\(order: OrderRecord, session: UserSession\)[\s\S]*hasOwnProperty\.call\(order, "forwardedPayoutPercent"\)/);
  assert.match(mobileScreens, /percentDisplay \? <SummaryRow label=\{percentDisplay\.label\} value=\{`\$\{percentDisplay\.percent\}%`\} \/> : null/);
  assert.match(mobileScreens, /percentDisplay \? `\$\{percentDisplay\.label\}: \$\{percentDisplay\.percent\}%` : ""/);
  assert.doesNotMatch(mobileScreens, /<SummaryRow label="Commission" value=\{`\$\{order\.commissionPercent/);

  const mobileMasterForwardStart = mobileScreens.indexOf('{isMasterView(session) && order.state === "Pending Forward" ? (');
  const mobilePayerActionsStart = mobileScreens.indexOf('{isPayer && order.state === "Assigned" ? (', mobileMasterForwardStart);
  assert.ok(mobileMasterForwardStart >= 0 && mobilePayerActionsStart > mobileMasterForwardStart, "Missing Android Master forwarding controls");
  const mobileMasterForwardBlock = mobileScreens.slice(mobileMasterForwardStart, mobilePayerActionsStart);
  assert.match(mobileMasterForwardBlock, /<Field label="Payout divisor"[^\r\n]*placeholder="Optional"/);
  assert.match(mobileMasterForwardBlock, /<Field label="Payer %"[^\r\n]*placeholder="Optional"/);
  assert.doesNotMatch(mobileMasterForwardBlock, /payerOptions\.some|Special Agent|Special Broker/, "Payout terms must be available for every paying Actor");
  assert.doesNotMatch(mobileMasterForwardBlock, /commissionPercent/, "Broker commission must not populate Master payout terms");
  assert.match(mobileMasterForwardBlock, /assignOrder\(order\.id, selectedAgent\[order\.id\], divider\[order\.id\], percent\[order\.id\]\)/);

  for (const field of [
    "forwardedPayoutDivider",
    "forwardedPayoutPercent",
    "manualSpecialPayoutDivider",
    "manualSpecialPayoutPercent",
    "manualMasterRateDivider",
    "manualMasterRatePercent"
  ]) {
    assert.match(index, new RegExp(`clearableOrderForwardingFields[\\s\\S]*"${field}"`));
    assert.match(server, new RegExp(`clearableOrderForwardingFields[\\s\\S]*"${field}"`));
  }
  assert.match(index, /if \(!Object\.prototype\.hasOwnProperty\.call\(item, field\)\) delete next\[field\];/);
  assert.match(server, /if \(!Object\.prototype\.hasOwnProperty\.call\(item, field\)\) delete next\[field\];/);
});
