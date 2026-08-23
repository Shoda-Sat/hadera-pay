import AsyncStorage from "@react-native-async-storage/async-storage";
import type { OrderRecord, TransferDraft, UserSession } from "../types";

const mobileRoutingOutboxPrefix = "haderapay.mobile.routing-action.v1";
const clearedRoutingAttempts = new Set<string>();

export type MobileRoutingSession = Pick<UserSession, "workspaceId" | "userId">;

interface MobileRoutingActionBase {
  kind: "broker-send" | "master-forward";
  attemptId: string;
  workspaceId: string;
  userId: string;
  orderId: string;
  order: OrderRecord;
}

export interface MobileBrokerRoutingAction extends MobileRoutingActionBase {
  kind: "broker-send";
  draft: TransferDraft;
  editingOrderId: string;
}

export interface MobileMasterRoutingAction extends MobileRoutingActionBase {
  kind: "master-forward";
  targetActorId: string;
  targetActorName: string;
  dividerText: string;
  percentText: string;
}

export type MobileRoutingActionRecord = MobileBrokerRoutingAction | MobileMasterRoutingAction;

function routingTokenPart(value: unknown, fallback = "INITIAL"): string {
  return String(value || fallback)
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || fallback;
}

export function mobileRoutingActionOutboxKey(session: MobileRoutingSession): string {
  const workspaceId = String(session?.workspaceId || "");
  const userId = String(session?.userId || "");
  return workspaceId && userId ? `${mobileRoutingOutboxPrefix}.${workspaceId}.${userId}` : "";
}

export async function readMobileRoutingAction(session: MobileRoutingSession): Promise<MobileRoutingActionRecord | null> {
  const key = mobileRoutingActionOutboxKey(session);
  if (!key) return null;
  let stored: string | null;
  try {
    stored = await AsyncStorage.getItem(key);
  } catch {
    throw new Error("The app could not safely check for an unfinished order. Check device storage and try again.");
  }
  if (!stored) return null;
  let record: MobileRoutingActionRecord;
  try {
    record = JSON.parse(stored) as MobileRoutingActionRecord;
  } catch {
    throw new Error("The protected order record on this device is unreadable. Do not resend until it is reviewed.");
  }
  const invalidBase = !record || !["broker-send", "master-forward"].includes(record.kind) || !record.attemptId || !record.order?.id ||
    String(record.workspaceId || "") !== String(session.workspaceId || "") ||
    String(record.userId || "") !== String(session.userId || "");
  const invalidBroker = record?.kind === "broker-send" &&
    (!record.draft || typeof record.editingOrderId !== "string" || record.order.routingSubmissionId !== record.attemptId);
  const invalidMaster = record?.kind === "master-forward" &&
    (!record.targetActorId || typeof record.dividerText !== "string" || typeof record.percentText !== "string" ||
      record.order.routingForwardAttemptId !== record.attemptId);
  if (invalidBase || invalidBroker || invalidMaster) {
    throw new Error("The protected order record on this device is incomplete. Do not resend until it is reviewed.");
  }
  if (clearedRoutingAttempts.has(`${key}:${record.attemptId}`)) return null;
  return record;
}

export async function persistMobileRoutingAction(
  session: MobileRoutingSession,
  record: MobileRoutingActionRecord
): Promise<void> {
  const key = mobileRoutingActionOutboxKey(session);
  if (!key) throw new Error("The active account cannot protect this routing action.");
  if (String(record.workspaceId || "") !== String(session.workspaceId || "") ||
      String(record.userId || "") !== String(session.userId || "")) {
    throw new Error("The routing action belongs to another signed-in workspace.");
  }
  try {
    await AsyncStorage.setItem(key, JSON.stringify(record));
    clearedRoutingAttempts.delete(`${key}:${record.attemptId}`);
  } catch {
    throw new Error("The app could not protect this order for restart. Free device storage and try again.");
  }
}

export async function clearMobileRoutingAction(session: MobileRoutingSession, expectedAttemptId = ""): Promise<void> {
  const key = mobileRoutingActionOutboxKey(session);
  if (!key) return;
  if (expectedAttemptId) {
    let record: MobileRoutingActionRecord | null;
    try {
      record = await readMobileRoutingAction(session);
    } catch {
      clearedRoutingAttempts.add(`${key}:${expectedAttemptId}`);
      return;
    }
    if (record && record.attemptId !== expectedAttemptId) return;
  }
  try {
    await AsyncStorage.removeItem(key);
  } catch {
    if (!expectedAttemptId) throw new Error("The app could not clear the protected order record from device storage.");
  }
  if (expectedAttemptId) clearedRoutingAttempts.add(`${key}:${expectedAttemptId}`);
}

export function mobileBrokerRoutingAttemptId(orderId: string, cycle = "INITIAL"): string {
  return `ROUTE-SEND-${routingTokenPart(orderId)}-${routingTokenPart(cycle)}`;
}

export function mobileMasterRoutingAttemptId(
  order: OrderRecord,
  targetActorId: string,
  dividerText = "AUTO",
  percentText = "AUTO"
): string {
  const cycle = order.routingSubmissionId || order.updatedAt || order.sentAt || order.createdAt || "INITIAL";
  return `ROUTE-FORWARD-${routingTokenPart(order.id)}-${routingTokenPart(targetActorId)}-${routingTokenPart(cycle)}-D-${routingTokenPart(dividerText, "AUTO")}-P-${routingTokenPart(percentText, "AUTO")}`;
}

function sameText(left: unknown, right: unknown): boolean {
  return String(left || "").trim().toLowerCase() === String(right || "").trim().toLowerCase();
}

export function routingOrderIdentityMatches(candidate: OrderRecord, submitted: OrderRecord): boolean {
  const submittedIds = new Set([submitted.id, submitted.internalOrderId, submitted.collisionSourceOrderId].filter(Boolean));
  return [candidate.id, candidate.internalOrderId, candidate.collisionSourceOrderId]
    .some((value) => Boolean(value) && submittedIds.has(value));
}

export function routingOrderContentMatches(candidate: OrderRecord, submitted: OrderRecord): boolean {
  const sameBroker = candidate.brokerActorId && submitted.brokerActorId
    ? candidate.brokerActorId === submitted.brokerActorId
    : sameText(candidate.broker, submitted.broker);
  if (!sameBroker) return false;
  const candidateMoment = String(candidate.createdAt || candidate.sentAt || "");
  const submittedMoment = String(submitted.createdAt || submitted.sentAt || "");
  if (candidateMoment && submittedMoment && candidateMoment !== submittedMoment) return false;
  return candidate.sourceCurrency === submitted.sourceCurrency &&
    Number(candidate.sourceAmountMinor || 0) === Number(submitted.sourceAmountMinor || 0) &&
    candidate.payoutCurrency === submitted.payoutCurrency &&
    Number(candidate.payoutAmountMinor || 0) === Number(submitted.payoutAmountMinor || 0) &&
    sameText(candidate.receiverName, submitted.receiverName) &&
    String(candidate.accountNumber || "").trim() === String(submitted.accountNumber || "").trim() &&
    String(candidate.phoneNumber || "").trim() === String(submitted.phoneNumber || "").trim();
}

export function brokerRoutingOrderMatches(candidate: OrderRecord | null | undefined, submitted: OrderRecord): boolean {
  if (!candidate || candidate.routingSubmissionId !== submitted.routingSubmissionId) return false;
  if (!routingOrderIdentityMatches(candidate, submitted)) return false;
  return routingOrderContentMatches(candidate, submitted);
}

function sameOptionalForwardingTerm(candidate: OrderRecord, submitted: OrderRecord, field: "forwardedPayoutDivider" | "forwardedPayoutPercent"): boolean {
  const candidateHas = Object.prototype.hasOwnProperty.call(candidate, field);
  const submittedHas = Object.prototype.hasOwnProperty.call(submitted, field);
  return candidateHas === submittedHas && (!submittedHas || Number(candidate[field]) === Number(submitted[field]));
}

export function masterRoutingOrderMatches(candidate: OrderRecord | null | undefined, submitted: OrderRecord): boolean {
  if (!candidate || candidate.routingForwardAttemptId !== submitted.routingForwardAttemptId) return false;
  if (!routingOrderIdentityMatches(candidate, submitted)) return false;
  if (candidate.agentActorId !== submitted.agentActorId) return false;
  if (!sameOptionalForwardingTerm(candidate, submitted, "forwardedPayoutDivider")) return false;
  if (!sameOptionalForwardingTerm(candidate, submitted, "forwardedPayoutPercent")) return false;
  return ["Assigned", "Returned", "Paid", "Void Requested", "Voided"].includes(candidate.state);
}
