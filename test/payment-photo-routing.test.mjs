import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `Could not isolate ${start}`);
  return source.slice(startIndex, endIndex);
}

test("paying-Actor photos are delivered to the original Broker as Master", async () => {
  const [index, preview, server, mobileApi, mobileDomain, mobileScreens] = await Promise.all([
    readFile(path.join(repositoryRoot, "index.html"), "utf8"),
    readFile(path.join(repositoryRoot, "preview.html"), "utf8"),
    readFile(path.join(repositoryRoot, "server.mjs"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/api/client.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/domain/workspace.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "mobile/src/screens/WorkspaceScreens.tsx"), "utf8"),
  ]);

  assert.equal(index, preview);

  assert.match(index, /function paymentProofOrderNumber[\s\S]*brokerOrderNumberForOrder\(order\)/);
  assert.match(index, /function orderForPayerChatReply/);
  assert.match(index, /purpose: linkedOrder \? "order-photo" : "chat-photo"/);
  assert.match(index, /sendChatOrderPhotoToBroker\(linkedOrder, storedFile\)/);
  assert.match(index, /return `\$\{orderNumber\}-payment-photo\$\{extension\}`/);
  assert.match(index, /return `\$\{prefix\}-payment-photo\$\{extension\}`/);
  assert.match(index, /orderId: order\.id,[\s\S]*orderNumber: orderDisplayNumber/);
  const webProofRoute = sourceBetween(index, "function sendPaymentProofToBroker", "function applyPrivileges");
  assert.match(webProofRoute, /directChatWithMaster\(order\.broker\)/);
  assert.match(webProofRoute, /from: masterName\(\)/);
  assert.match(webProofRoute, /orderNumber: displayNumber/);
  assert.match(webProofRoute, /notifyEvent\("Photo sent", `A photo was sent regarding order \$\{payerOrderNumber\}\.\`\)/);
  assert.doesNotMatch(webProofRoute, /from: actor\.name|forwardedFrom/);
  assert.match(index, /notifyEvent\("Photo sent", `A photo was sent regarding replied order \$\{payerOrderNumber\}\.\`\)/);

  assert.match(server, /\["order-photo", \{/);
  assert.match(server, /\["payment-proof", "order-photo"\]\.includes\(file\.purpose\)/);
  assert.match(server, /\["payment-proof", "order-photo"\]\.includes\(file\?\.purpose\)/);
  assert.match(server, /const brokerChatMatches = Boolean\(linkedOrder/);
  assert.match(server, /file\.contextIds = Array\.from\(new Set/);
  const publicFile = sourceBetween(server, "function publicFileRecord", "function attachmentRule");
  assert.doesNotMatch(publicFile, /uploaderUserId|uploaderActorId/);
  assert.match(mobileApi, /"payment-proof" \| "order-photo" \| "chat-photo"/);

  const mobileProofRoute = sourceBetween(mobileDomain, "function appendPaymentProofToBroker", "export async function markOrderPaid");
  assert.match(mobileProofRoute, /item\.members\.includes\(order\.broker\)/);
  assert.match(mobileProofRoute, /from: master\.name/);
  assert.match(mobileProofRoute, /orderNumber: displayNumber/);
  assert.doesNotMatch(mobileProofRoute, /from: actor\.name|forwardedFrom/);
  assert.match(mobileDomain, /export function payingOrderForChatReply/);
  assert.match(mobileDomain, /text: `Payment photo for order \$\{originalOrderNumber\}\.`/);
  assert.match(mobileDomain, /orderId: linkedOrder\.id,[\s\S]*orderNumber: originalOrderNumber/);
  assert.match(mobileScreens, /purpose: linkedOrder \? "order-photo" : "chat-photo"/);
  assert.match(mobileScreens, /orderNumber: order\.brokerOrderNumber \|\| order\.id/);
  assert.match(mobileScreens, /return `\$\{displayNumber\}-payment-photo\$\{extension\}`/);
  assert.match(mobileScreens, /return `\$\{prefix\}-payment-photo\$\{extension\}`/);
  assert.match(mobileScreens, /Alert\.alert\("Photo sent", `A photo was sent regarding order \$\{displayNumber\}\.\`\)/);
  assert.match(mobileScreens, /Alert\.alert\("Photo sent", `A photo was sent regarding replied order \$\{payerOrderNumber\}\.\`\)/);
});
