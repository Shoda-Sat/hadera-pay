import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("Master and paying Actor return reasons are required, latest-only, and refresh-safe", async () => {
  const [index, preview, mobileDomain, mobileScreens] = await Promise.all([
    readFile(path.join(repositoryRoot, "index.html"), "utf8"),
    readFile(path.join(repositoryRoot, "preview.html"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/domain/workspace.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/screens/WorkspaceScreens.tsx"), "utf8"),
  ]);

  assert.equal(index, preview);

  assert.match(index, /class="[^"]*order-return-reason[^"]*"[^>]+maxlength="500"/);
  assert.match(index, /if \(canPay\)[\s\S]*Reason for returning[\s\S]*class="order-return-reason"[\s\S]*class="btn secondary return-order"/);
  assert.match(index, /if \(!reason\)[\s\S]*Enter the reason for returning this order/);
  assert.match(index, /const orderReturnReasonDrafts = new Map\(\)/);
  assert.match(index, /orderReturnReasonDrafts\.set\(input\.dataset\.id, input\.value \|\| ""\)/);
  assert.match(index, /if \(!actorCanPayOrder\(order, actor\)\) return;[\s\S]*if \(!actorCanPayOrder\(currentOrder, actor\)\) return;[\s\S]*currentOrder\.returnedBy = actor\.name;[\s\S]*currentOrder\.returnedReason = reason/);
  assert.match(index, /workspaceInputIsFocused\(\)[\s\S]*input, textarea, select/);
  assert.match(index, /document\.activeElement\?\.closest\?\.\("\.forward-agent,[^\n]+\.order-return-reason"\)/);
  assert.match(index, /function viewerCanSeeOrderReturnReason[\s\S]*order\?\.state !== "Returned"[\s\S]*order\?\.broker === viewer\?\.name/);
  assert.match(index, /order\.state = "Assigned";[\s\S]*order\.returnedReason = "";/);

  assert.match(mobileDomain, /returnOrder\(orderId: string, actorName = "Master", reason = "", actorId = ""\)/);
  assert.match(mobileDomain, /Boolean\(actorId\) && order\.agentActorId === actorId\)[\s\S]*order\.agent === actorName/);
  assert.match(mobileDomain, /if \(!latestReason\) throw new Error\("Enter the reason for returning this order\."\)/);
  assert.match(mobileDomain, /order\.returnedReason = latestReason/);
  assert.match(mobileDomain, /order\.state = "Assigned";[\s\S]*order\.returnedReason = "";/);

  assert.match(mobileScreens, /const orderReturnReasonDrafts = new Map<string, string>\(\)/);
  assert.match(mobileScreens, /orderReturnReasonDrafts\.set\(returnReasonKey\(orderId\), value\)/);
  assert.match(mobileScreens, /returnOrder\(order\.id, session\.actorName, reason, session\.actorId\)/);
  assert.match(mobileScreens, /isPayer && order\.state === "Assigned"[\s\S]*label="Reason for returning"[\s\S]*maxLength=\{500\}/);
  assert.match(mobileScreens, /actorCanSeeReturnReason = order\.state === "Returned"[\s\S]*isMasterView\(session\)/);
  assert.match(mobileScreens, /Reason for return/);
  assert.doesNotMatch(index, /returnedReasonHistory|returnReasonsHistory/);
  assert.doesNotMatch(mobileDomain, /returnedReasonHistory|returnReasonsHistory/);
});
