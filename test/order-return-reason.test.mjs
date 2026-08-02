import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("Master return reasons are latest-only and hidden from paying Actors", async () => {
  const [index, preview, mobileDomain, mobileScreens] = await Promise.all([
    readFile(path.join(repositoryRoot, "index.html"), "utf8"),
    readFile(path.join(repositoryRoot, "preview.html"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/domain/workspace.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/screens/WorkspaceScreens.tsx"), "utf8"),
  ]);

  assert.equal(index, preview);

  assert.match(index, /class="master-return-reason"[^>]+maxlength="500"/);
  assert.match(index, /if \(!reason\)[\s\S]*Enter the reason for returning this order/);
  assert.match(index, /currentOrder\.returnedReason = reason/);
  assert.match(index, /settingsRateInputIsFocused\(\)[\s\S]*\.master-return-reason/);
  assert.match(index, /document\.activeElement\?\.closest\?\.\("\.forward-agent,[^\n]+\.master-return-reason"\)/);
  assert.match(index, /function viewerCanSeeOrderReturnReason[\s\S]*order\?\.state !== "Returned"[\s\S]*order\?\.broker === viewer\?\.name/);
  assert.match(index, /order\.state = "Assigned";[\s\S]*order\.returnedReason = "";/);

  assert.match(mobileDomain, /returnOrder\(orderId: string, actorName = "Master", reason = ""\)/);
  assert.match(mobileDomain, /if \(masterReturn && !latestReason\) throw new Error\("Enter the reason for returning this order\."\)/);
  assert.match(mobileDomain, /order\.returnedReason = masterReturn \? latestReason : ""/);
  assert.match(mobileDomain, /order\.state = "Assigned";[\s\S]*order\.returnedReason = "";/);

  assert.match(mobileScreens, /label="Reason for returning"[\s\S]*maxLength=\{500\}/);
  assert.match(mobileScreens, /actorCanSeeReturnReason = !isMasterView\(session\) && order\.state === "Returned"/);
  assert.match(mobileScreens, /Reason from Master/);
  assert.doesNotMatch(index, /returnedReasonHistory|returnReasonsHistory/);
  assert.doesNotMatch(mobileDomain, /returnedReasonHistory|returnReasonsHistory/);
});
