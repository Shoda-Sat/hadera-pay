import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("closing one Actor balance starts only that Actor's order numbering from one", async () => {
  const [index, preview, mobileTypes, mobileNumbering, mobileWorkspace, mobileClient, workspaceSecurity] = await Promise.all([
    readFile(path.join(repositoryRoot, "index.html"), "utf8"),
    readFile(path.join(repositoryRoot, "preview.html"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/types.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/domain/ledgerNumbering.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/domain/workspace.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/api/client.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "src/workspace-security.mjs"), "utf8"),
  ]);

  assert.equal(index, preview);
  assert.match(index, /function actorNumberingCycle\(actorName\)/);
  assert.match(index, /actor\.numberingCycle = actorNumberingCycle\(actor\.name\) \+ 1;[\s\S]*syncSettlementsFromLedger\(\)/);
  assert.match(index, /brokerOrderNumberCycle: existingOrder\?\.brokerOrderNumberCycle \?\? actorNumberingCycle\(input\.broker\)/);
  assert.match(index, /Number\(order\.brokerOrderNumberCycle \|\| 0\) === numberingCycle/);
  assert.match(index, /Number\(order\.agentOrderNumberCycles\?\.\[actorName\] \|\| 0\) === numberingCycle/);
  assert.match(index, /Number\(order\.agentOrderNumberCycles\[agentName\] \|\| 0\) !== numberingCycle[\s\S]*order\.agentOrderNumberCycles\[agentName\] = numberingCycle/);

  assert.match(mobileTypes, /numberingCycle\?: number/);
  assert.match(mobileTypes, /brokerOrderNumberCycle\?: number/);
  assert.match(mobileTypes, /agentOrderNumberCycles\?: Record<string, number>/);
  assert.match(mobileNumbering, /Number\(order\.brokerOrderNumberCycle \|\| 0\) === numberingCycle/);
  assert.match(mobileNumbering, /Number\(order\.agentOrderNumberCycles\?\.\[actorName\] \|\| 0\) === numberingCycle/);
  assert.match(mobileWorkspace, /order\.agentOrderNumberCycles\[agentName\] = numberingCycle/);
  assert.match(mobileClient, /brokerOrderNumberCycle: existingOrder\?\.brokerOrderNumberCycle \?\?/);
  assert.match(workspaceSecurity, /brokerOrderNumberCycle: existing\?\.brokerOrderNumberCycle \?\?/);
});
