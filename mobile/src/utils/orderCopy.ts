import type { ActorRecord, OrderRecord, UserSession } from "../types";
import { compactAmount, currencyDecimals, majorFromMinor } from "./money";

function cleanText(value: unknown): string {
  return String(value ?? "").trim();
}

function sessionIsMaster(session: UserSession): boolean {
  return session.role === "Master" && session.actorRole === "Master";
}

function payoutCapableRole(role: ActorRecord["role"]): boolean {
  return ["Agent", "Special Agent", "Special Broker"].includes(role);
}

function viewerIsAssignedPayer(order: OrderRecord, viewer: ActorRecord): boolean {
  return Boolean(
    (viewer.id && order.agentActorId === viewer.id) ||
    (viewer.name && order.agent === viewer.name)
  );
}

function agentOrderNumberFor(order: OrderRecord, agentName: string): string {
  const mapped = cleanText(order.agentOrderNumbers?.[agentName]);
  if (mapped) return mapped;
  return cleanText(order.agentOrderNumber);
}

function brokerOrderNumberFor(order: OrderRecord): string {
  return cleanText(order.brokerOrderNumber) || cleanText(order.id);
}

function displayOrderNumberFor(order: OrderRecord, viewer: ActorRecord): string {
  if (payoutCapableRole(viewer.role) && viewerIsAssignedPayer(order, viewer)) {
    return agentOrderNumberFor(order, viewer.name) || brokerOrderNumberFor(order);
  }
  return brokerOrderNumberFor(order);
}

function formatMinorWithoutCurrency(orderCurrency: OrderRecord["sourceCurrency"], amountMinor: number): string {
  return majorFromMinor(amountMinor, orderCurrency)
    .toFixed(currencyDecimals(orderCurrency))
    .replace(/(\.\d*?[1-9])0+$/, "$1")
    .replace(/\.0+$/, "");
}

function copyAmount(currency: OrderRecord["sourceCurrency"], amountMinor: number): string {
  if (Number(amountMinor || 0) <= 0) return "";
  return compactAmount(currency, majorFromMinor(amountMinor, currency));
}

function sourceAmountForCopy(order: OrderRecord, viewer: ActorRecord | undefined): string {
  const permissionsApply = viewer?.role === "Agent" || viewer?.role === "Special Agent";
  const permissions = viewer?.orderVisibilityPermissions || {};
  if (permissionsApply && permissions.baseAmount === false) return "";
  if (permissionsApply && permissions.sourceCurrency === false) {
    return formatMinorWithoutCurrency(order.sourceCurrency, Number(order.sourceAmountMinor || 0));
  }
  return copyAmount(order.sourceCurrency, Number(order.sourceAmountMinor || 0));
}

export function viewerCanCopyOrderDetails(order: OrderRecord, session: UserSession, viewer: ActorRecord | undefined): boolean {
  if (!viewer) return false;
  if (sessionIsMaster(session) && viewer.role === "Master") return true;
  return payoutCapableRole(viewer.role) && viewerIsAssignedPayer(order, viewer);
}

export function orderDetailsClipboardText(
  order: OrderRecord,
  session: UserSession,
  viewer: ActorRecord | undefined
): string {
  if (!viewerCanCopyOrderDetails(order, session, viewer)) return "";
  const isMaster = sessionIsMaster(session) && viewer?.role === "Master";
  const payoutCurrency = order.payoutCurrency || order.sourceCurrency;
  const payoutMinor = Number(order.payoutAmountMinor || order.sourceAmountMinor || 0);
  const values: Array<[string, unknown]> = [
    ["Order Number", isMaster ? brokerOrderNumberFor(order) : displayOrderNumberFor(order, viewer!)],
    ["File Number", isMaster ? agentOrderNumberFor(order, order.agent) : ""],
    ["Sender Name", order.senderName],
    ["Receiver Name", order.receiverName],
    ["Receiver City", order.receiverCity],
    ["Source Amount", sourceAmountForCopy(order, viewer)],
    ["Total Payout", copyAmount(payoutCurrency, payoutMinor)],
    ["Phone Number", order.phoneNumber],
    ["Account Number", order.accountNumber],
    ["Remarks", order.remarks]
  ];
  return values
    .map(([label, value]) => [label, cleanText(value)] as const)
    .filter(([, value]) => Boolean(value))
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");
}
