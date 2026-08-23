import { canCreateOrders, loadWorkspaceState } from "../api/client";
import type { OrderRecord, UserSession, WorkspaceState } from "../types";
import { actingSessionFor, actorCanPayoutCurrency, isMasterView } from "./workspace";
import {
  brokerRoutingOrderMatches,
  clearMobileRoutingAction,
  masterRoutingOrderMatches,
  readMobileRoutingAction,
  routingOrderContentMatches,
  routingOrderIdentityMatches,
  type MobileRoutingActionRecord
} from "./routingDurability";

export type MobileRoutingRecoveryStatus = "none" | "confirmed" | "retried" | "pending";

export interface MobileRoutingRecoveryResult {
  state: WorkspaceState;
  action: MobileRoutingActionRecord | null;
  status: MobileRoutingRecoveryStatus;
}

function allWorkspaceOrders(state: WorkspaceState): OrderRecord[] {
  return [...state.orders, ...state.archives.flatMap((archive) => archive.orders || [])];
}

function routingActionIsAcknowledged(state: WorkspaceState, action: MobileRoutingActionRecord): boolean {
  return action.kind === "broker-send"
    ? allWorkspaceOrders(state).some((candidate) => brokerRoutingOrderMatches(candidate, action.order))
    : allWorkspaceOrders(state).some((candidate) => masterRoutingOrderMatches(candidate, action.order));
}

function activeOrderForAction(state: WorkspaceState, action: MobileRoutingActionRecord): OrderRecord | undefined {
  return state.orders.find((candidate) =>
    routingOrderIdentityMatches(candidate, action.order) && routingOrderContentMatches(candidate, action.order)
  );
}

function archivedOrderForAction(state: WorkspaceState, action: MobileRoutingActionRecord): OrderRecord | undefined {
  return state.archives
    .flatMap((archive) => archive.orders || [])
    .find((candidate) =>
      routingOrderIdentityMatches(candidate, action.order) && routingOrderContentMatches(candidate, action.order)
    );
}

function deletedOrderForAction(state: WorkspaceState, action: MobileRoutingActionRecord): boolean {
  return (state.deletedOrderIds || []).includes(action.order.id);
}

function returnedOrderBeingResubmitted(
  state: WorkspaceState,
  action: Extract<MobileRoutingActionRecord, { kind: "broker-send" }>
): OrderRecord | undefined {
  if (!action.editingOrderId) return undefined;
  return state.orders.find((candidate) => {
    if (candidate.id !== action.editingOrderId || candidate.state !== "Returned") return false;
    if (candidate.brokerActorId && action.order.brokerActorId) {
      return candidate.brokerActorId === action.order.brokerActorId;
    }
    return String(candidate.broker || "").trim().toLowerCase() ===
      String(action.order.broker || "").trim().toLowerCase();
  });
}

export async function recoverMobileRoutingAction(
  session: UserSession,
  initialState?: WorkspaceState
): Promise<MobileRoutingRecoveryResult> {
  const action = await readMobileRoutingAction(session);
  const state = initialState || await loadWorkspaceState();
  if (!action) return { state, action: null, status: "none" };
  if (state.offlineSnapshot) return { state, action, status: "pending" };

  if (routingActionIsAcknowledged(state, action)) {
    await clearMobileRoutingAction(session, action.attemptId);
    return { state, action: null, status: "confirmed" };
  }

  const currentOrder = activeOrderForAction(state, action);
  const archivedOrder = archivedOrderForAction(state, action);
  const wasDeleted = deletedOrderForAction(state, action);
  if (archivedOrder || wasDeleted) {
    await clearMobileRoutingAction(session, action.attemptId);
    return { state, action: null, status: "confirmed" };
  }

  if (action.kind === "broker-send") {
    const returnedOrder = returnedOrderBeingResubmitted(state, action);
    const effectiveCurrentOrder = currentOrder || returnedOrder;
    const retryingReturnedOrder = effectiveCurrentOrder?.state === "Returned" && Boolean(action.editingOrderId);
    if (effectiveCurrentOrder && !retryingReturnedOrder) {
      await clearMobileRoutingAction(session, action.attemptId);
      return { state, action: null, status: "confirmed" };
    }
    if (action.editingOrderId && !effectiveCurrentOrder) {
      await clearMobileRoutingAction(session, action.attemptId);
      return { state, action: null, status: "confirmed" };
    }
    const brokerActor = state.actors.find((actor) => actor.id === action.order.brokerActorId)
      || state.actors.find((actor) => actor.name === action.order.broker);
    if (!canCreateOrders(actingSessionFor(session, brokerActor))) {
      await clearMobileRoutingAction(session, action.attemptId);
      return { state, action: null, status: "confirmed" };
    }
    return { state, action, status: "pending" };
  }

  const targetActor = state.actors.find((actor) => actor.id === action.targetActorId && actor.active !== false);
  if (!isMasterView(session) || !currentOrder || currentOrder.state !== "Pending Forward" ||
      !targetActor || targetActor.name === currentOrder.broker || !actorCanPayoutCurrency(targetActor, currentOrder.payoutCurrency)) {
    await clearMobileRoutingAction(session, action.attemptId);
    return { state, action: null, status: "confirmed" };
  }
  return { state, action, status: "pending" };
}
