import { updateWorkspaceState } from "../api/client";
import type {
  ActorRecord,
  ChatConversationRecord,
  Currency,
  InternalTransferDraft,
  InternalTransferForwardDraft,
  InternalTransferRecord,
  LedgerLine,
  MasterBankEntryRecord,
  OrderRecord,
  PreparedPaymentProof,
  RateSetting,
  ReceivableRecord,
  UserSession,
  WorkspaceState
} from "../types";
import { compactAmount, majorFromMinor, minorFromMajor, parseAmount } from "../utils/money";

export const supportedCurrencies: Currency[] = ["USD", "ETB", "EUR", "ERN"];
export const pendingCancelledOrderStates = new Set<OrderRecord["state"]>(["Assigned", "Returned", "Voided", "Cancelled"]);
const processingOrderIds = new Set<string>();
const processingTransferIds = new Set<string>();

export function isMasterView(session: UserSession): boolean {
  return session.role === "Master" && session.actorRole === "Master";
}

export function actorCanInitiateOrders(role: ActorRecord["role"]): boolean {
  return role === "Broker" || role === "Special Broker";
}

export function actorCanReceivePayouts(role: ActorRecord["role"]): boolean {
  return role === "Agent" || role === "Special Agent" || role === "Special Broker";
}

export function actorHasSpecialPayout(role: ActorRecord["role"]): boolean {
  return role === "Special Agent" || role === "Special Broker";
}

export function activeActors(state: WorkspaceState): ActorRecord[] {
  return state.actors.filter((actor) => actor.active !== false);
}

export function actorForSession(session: UserSession, state: WorkspaceState | null): ActorRecord | undefined {
  return state?.actors.find((actor) => actor.id === session.actorId) ||
    state?.actors.find((actor) => actor.name === session.actorName);
}

export function actingSessionFor(loginSession: UserSession, actor: ActorRecord | undefined): UserSession {
  if (loginSession.role !== "Master" || !actor || actor.role === "Master") {
    return { ...loginSession, managedByMaster: false };
  }
  if (actor.managedByMaster !== true) return { ...loginSession, managedByMaster: false };
  return {
    ...loginSession,
    actorId: actor.id,
    actorName: actor.name,
    actorRole: actor.role,
    currency: actor.currency,
    workingCurrencies: actor.workingCurrencies || [actor.currency],
    managedByMaster: true
  };
}

export function actorTransferCurrencies(actor: ActorRecord | undefined): Currency[] {
  if (!actor) return [];
  if (actor.role === "Master") return supportedCurrencies;
  if (actor.transferReceiveMultiCurrencyEnabled === true) return supportedCurrencies;
  return [actor.currency];
}

export function actorTransferReceiveCurrencies(actor: ActorRecord | undefined): Currency[] {
  if (!actor) return [];
  if (actor.role === "Master" || actor.transferReceiveMultiCurrencyEnabled === true) {
    return supportedCurrencies;
  }
  return [actor.currency];
}

export function actorCanPayoutCurrency(actor: ActorRecord | undefined, currency: Currency): boolean {
  if (!actor || !actorCanReceivePayouts(actor.role)) return false;
  if (actorHasSpecialPayout(actor.role)) {
    return Array.from(new Set([actor.currency, ...(actor.workingCurrencies || [])])).includes(currency);
  }
  return actor.currency === currency;
}

export function orderSortForSession(session: UserSession): (left: OrderRecord, right: OrderRecord) => number {
  const loginStartedAt = new Date(session.loginStartedAt || 0).getTime();
  const needsPriority = (order: OrderRecord) => {
    if (!Number.isFinite(loginStartedAt) || loginStartedAt <= 0) return false;
    const actionAt = new Date(isMasterView(session)
      ? order.sentAt || order.createdAt
      : order.assignedAt || order.sentAt || order.createdAt).getTime();
    if (!Number.isFinite(actionAt) || actionAt <= 0 || actionAt >= loginStartedAt) return false;
    if (isMasterView(session)) return order.state === "Pending Forward";
    return actorCanReceivePayouts(session.actorRole) && order.state === "Assigned" &&
      (order.agentActorId === session.actorId || order.agent === session.actorName);
  };
  return (left, right) => {
    const priority = Number(needsPriority(right)) - Number(needsPriority(left));
    if (priority) return priority;
    return new Date(right.createdAt || right.updatedAt || 0).getTime() - new Date(left.createdAt || left.updatedAt || 0).getTime();
  };
}

export function transferTargetsFor(session: UserSession, state: WorkspaceState): ActorRecord[] {
  const actor = actorForSession(session, state);
  if (!actor) return [];
  const others = activeActors(state).filter((candidate) => candidate.id !== actor.id);
  if (isMasterView(session)) return others;
  const mode = actor.transferEnabled === false ? "none" : actor.transferMode || "master";
  if (mode === "both") return others;
  if (mode === "actor") return others.filter((candidate) => candidate.role !== "Master");
  if (mode === "master") return others.filter((candidate) => candidate.role === "Master");
  return [];
}

function nextJournalId(state: WorkspaceState): string {
  const highest = state.ledger.reduce((value, line) => {
    const match = String(line.journal || "").match(/^JRN-(\d+)$/);
    return match ? Math.max(value, Number(match[1]) - 1000) : value;
  }, 0);
  state.journalCounter = Math.max(Number(state.journalCounter || 0), highest) + 1;
  return `JRN-${1000 + state.journalCounter}`;
}

function nextTransferId(state: WorkspaceState): string {
  const highest = state.transfers.reduce((value, transfer) => {
    const match = String(transfer.id || "").match(/^TRF-(\d+)$/);
    return match ? Math.max(value, Number(match[1])) : value;
  }, 0);
  state.transferCounter = Math.max(Number(state.transferCounter || 0), highest) + 1;
  return `TRF-${state.transferCounter}`;
}

function brokerOrderNumber(order: OrderRecord): string {
  return order.brokerOrderNumber || order.id;
}

function allNumberedOrders(state: WorkspaceState): Array<{ order: OrderRecord; current: boolean; closedAt: string }> {
  return [
    ...state.orders.map((order) => ({ order, current: true, closedAt: "" })),
    ...state.archives.flatMap((archive) => (archive.orders || []).map((order) => ({
      order,
      current: false,
      closedAt: archive.closedAt || ""
    })))
  ];
}

export function orderRecordIsVoided(order: OrderRecord | undefined): boolean {
  return order?.state === "Voided" || Boolean(order?.voidedAt || order?.voidJournal || order?.excludedFromCalculations);
}

export function orderForLedgerLine(state: WorkspaceState, line: LedgerLine): OrderRecord | undefined {
  if (!String(line.source || "").startsWith("ORDER_")) return undefined;
  const liveOrder = line.orderId
    ? state.orders.find((order) => order.id === line.orderId)
    : state.orders.find((order) => order.journal === line.journal || order.voidJournal === line.journal);
  if (liveOrder) return liveOrder;
  const reportedOrders = state.archives.flatMap((archive) => archive.orders || []);
  if (line.orderId) {
    return reportedOrders.find((order) => order.id === line.orderId || order.internalOrderId === line.orderId);
  }
  return reportedOrders.find((order) => order.journal === line.journal || order.voidJournal === line.journal);
}

export function ledgerLineIsForVoidedOrder(state: WorkspaceState, line: LedgerLine): boolean {
  if (line.voided === true || line.excludedFromCalculations === true) return true;
  return orderRecordIsVoided(orderForLedgerLine(state, line));
}

export function calculableLedgerLines(state: WorkspaceState, lines: LedgerLine[] = state.ledger): LedgerLine[] {
  return lines.filter((line) => line.archived !== true && !ledgerLineIsForVoidedOrder(state, line));
}

function orderBalanceWasClosed(state: WorkspaceState, order: OrderRecord): boolean {
  if (order.locked === true) return true;
  const createdAt = new Date(order.createdAt || order.sentAt || 0).getTime();
  return state.archives.some((archive) => (archive.orders || []).some((reportedOrder) => {
    if (reportedOrder.id !== order.id && reportedOrder.internalOrderId !== order.id) return false;
    const closedAt = new Date(archive.closedAt || 0).getTime();
    if (Number.isFinite(createdAt) && createdAt > 0 && Number.isFinite(closedAt) && closedAt < createdAt) return false;
    return true;
  }));
}

function latestCloseForActor(state: WorkspaceState, actorName: string): number {
  return state.archives
    .filter((archive) => archive.actor === actorName)
    .reduce((latest, archive) => Math.max(latest, new Date(archive.closedAt || 0).getTime() || 0), 0);
}

function nextAgentSequence(state: WorkspaceState, agentName: string): number {
  const latestClose = latestCloseForActor(state, agentName);
  const used = new Set<number>();
  allNumberedOrders(state).forEach((record) => {
    const numbers = Object.entries(record.order.agentOrderNumbers || {})
      .filter(([name]) => name === agentName)
      .map(([, number]) => number);
    if ((record.order.agentOrderActor === agentName || record.order.agent === agentName) && record.order.agentOrderNumber) {
      numbers.push(record.order.agentOrderNumber);
    }
    const reserve = record.current || record.order.state === "Voided" || Boolean(record.order.voidJournal) ||
      !latestClose || new Date(record.closedAt || 0).getTime() > latestClose;
    if (!reserve) return;
    numbers.forEach((number) => {
      const match = String(number || "").match(/^(\d+)_/);
      if (match) used.add(Number(match[1]));
    });
  });
  let next = 1;
  while (used.has(next)) next += 1;
  return next;
}

function assignAgentNumber(state: WorkspaceState, order: OrderRecord, agentName: string): void {
  order.agentOrderNumbers = { ...(order.agentOrderNumbers || {}) };
  if (order.agentOrderNumber && order.agentOrderActor && !order.agentOrderNumbers[order.agentOrderActor]) {
    order.agentOrderNumbers[order.agentOrderActor] = order.agentOrderNumber;
  }
  if (!order.agentOrderNumbers[agentName]) {
    order.agentOrderNumbers[agentName] = `${String(nextAgentSequence(state, agentName)).padStart(4, "0")}_${brokerOrderNumber(order)}`;
  }
  order.agentOrderNumber = order.agentOrderNumbers[agentName];
  order.agentOrderActor = agentName;
}

function orderDetails(order: OrderRecord): string {
  return [
    `Order: ${brokerOrderNumber(order)}`,
    order.senderName ? `Sender: ${order.senderName}` : "",
    order.receiverName ? `Receiver: ${order.receiverName}` : "",
    order.receiverCity ? `Receiver City: ${order.receiverCity}` : "",
    order.accountNumber ? `Account: ${order.accountNumber}` : "",
    order.phoneNumber ? `Phone: ${order.phoneNumber}` : "",
    order.remarks ? `Remarks: ${order.remarks}` : ""
  ].filter(Boolean).join(" - ");
}

function rateSetting(value: RateSetting | undefined): Required<RateSetting> {
  return {
    enabled: value?.enabled === true,
    divider: Number(value?.divider) > 0 ? Number(value?.divider) : 1,
    percent: Number(value?.percent) > 0 ? Number(value?.percent) : 0
  };
}

function payingActorStatement(state: WorkspaceState, order: OrderRecord): { currency: Currency; amountMinor: number } {
  const actor = activeActors(state).find((candidate) => candidate.name === order.agent);
  const payoutCurrency = order.payoutCurrency || order.sourceCurrency;
  const payoutAmountMinor = Number(order.payoutAmountMinor || order.sourceAmountMinor || 0);
  const forwardedDivider = Number(order.forwardedPayoutDivider || 0);
  const forwardedPercent = Number(order.forwardedPayoutPercent || 0);
  const hasForwardedDivider = forwardedDivider > 0;
  const hasForwardedPercent = forwardedPercent >= 0 && Object.prototype.hasOwnProperty.call(order, "forwardedPayoutPercent");
  const applyTerms = (amountMinor: number, currency: Currency) => {
    let major = majorFromMinor(amountMinor, currency);
    if (hasForwardedDivider) major /= forwardedDivider;
    if (hasForwardedPercent) major *= 1 + forwardedPercent / 100;
    return minorFromMajor(major, currency);
  };
  if (!actor || !actorHasSpecialPayout(actor.role)) {
    return { currency: payoutCurrency, amountMinor: hasForwardedDivider || hasForwardedPercent ? applyTerms(payoutAmountMinor, payoutCurrency) : payoutAmountMinor };
  }
  const baseCurrency = actor.currency;
  const special = rateSetting(actor.specialPayoutSettings?.[payoutCurrency]);
  const finish = (baseMajor: number, fallbackPercent: number) => ({
    currency: baseCurrency,
    amountMinor: minorFromMajor(baseMajor * (1 + (hasForwardedPercent ? forwardedPercent : fallbackPercent) / 100), baseCurrency)
  });
  if (hasForwardedDivider) return finish(majorFromMinor(payoutAmountMinor, payoutCurrency) / forwardedDivider, 0);
  if (special.enabled) return finish(majorFromMinor(payoutAmountMinor, payoutCurrency) / special.divider, special.percent);
  const manualDivider = Number(order.manualSpecialPayoutDivider || 0);
  const manualPercent = Number(order.manualSpecialPayoutPercent || 0);
  if (manualDivider > 0 || manualPercent > 0) {
    return finish(majorFromMinor(payoutAmountMinor, payoutCurrency) / (manualDivider > 0 ? manualDivider : 1), manualPercent);
  }
  if (baseCurrency === payoutCurrency) return { currency: baseCurrency, amountMinor: applyTerms(payoutAmountMinor, baseCurrency) };
  if (baseCurrency === order.sourceCurrency) return { currency: baseCurrency, amountMinor: applyTerms(Number(order.sourceAmountMinor || 0), baseCurrency) };
  const rate = Number(order.rate || 1) || 1;
  return { currency: baseCurrency, amountMinor: applyTerms(minorFromMajor(majorFromMinor(payoutAmountMinor, payoutCurrency) / rate, baseCurrency), baseCurrency) };
}

function buyingRates(state: WorkspaceState): { eurToUsd: number; usdToEtb: number; usdToErn: number } {
  return {
    eurToUsd: Number(state.buyingRates?.eurToUsd) > 0 ? Number(state.buyingRates?.eurToUsd) : 1,
    usdToEtb: Number(state.buyingRates?.usdToEtb) > 0 ? Number(state.buyingRates?.usdToEtb) : 1,
    usdToErn: Number(state.buyingRates?.usdToErn) > 0 ? Number(state.buyingRates?.usdToErn) : 1
  };
}

function currencyToUsd(state: WorkspaceState, currency: Currency, amountMinor: number): number {
  if (currency === "USD") return amountMinor;
  const major = majorFromMinor(amountMinor, currency);
  const rates = buyingRates(state);
  if (currency === "EUR") return minorFromMajor(major * rates.eurToUsd, "USD");
  if (currency === "ETB") return minorFromMajor(major / rates.usdToEtb, "USD");
  return minorFromMajor(major / rates.usdToErn, "USD");
}

export function applyUsdAgentIncomeRate(amountMinor: number, setting: RateSetting | undefined): number {
  if (amountMinor <= 0) return 0;
  const divider = Number(setting?.divider) > 0 ? Number(setting?.divider) : 1;
  const percent = Number(setting?.percent) > 0 ? Number(setting?.percent) : 0;
  const dividedPayoutMajor = majorFromMinor(amountMinor, "USD") / divider;
  const percentageAddition = dividedPayoutMajor * percent / 100;
  return minorFromMajor(dividedPayoutMajor + percentageAddition, "USD");
}

function freezeIncome(state: WorkspaceState, order: OrderRecord, lines: LedgerLine[]): void {
  const sourceCurrency = order.sourceCurrency;
  const payoutCurrency = order.payoutCurrency;
  const collectedMinor = Number(order.sourceAmountMinor || 0) + Number(order.commissionMinor || 0);
  const rates = buyingRates(state);
  const payerLine = lines.find((line) => line.account === `${order.agent} ACTOR_CLEARING` && line.direction === "Credit");
  const payingActor = activeActors(state).find((actor) => actor.name === order.agent);
  const usdPayerLine = lines.find((line) => line.account === `${order.agent} ACTOR_CLEARING` && line.direction === "Credit" && line.currency === "USD");
  const usdPayoutActorBaseMinor = payoutCurrency === "USD" && payingActor?.role === "Agent" && payingActor.currency === "USD"
    ? applyUsdAgentIncomeRate(usdPayerLine?.amountMinor || Number(order.payoutAmountMinor || 0), payingActor.incomeUsdPayoutSetting)
    : 0;
  let baseAmountMinor = 0;
  if (usdPayoutActorBaseMinor > 0) {
    baseAmountMinor = usdPayoutActorBaseMinor;
  } else if (payingActor && actorHasSpecialPayout(payingActor.role) && payerLine) {
    baseAmountMinor = currencyToUsd(state, payerLine.currency, payerLine.amountMinor);
  } else if (payoutCurrency === "USD") {
    baseAmountMinor = payerLine?.currency === "USD" ? payerLine.amountMinor : Number(order.payoutAmountMinor || 0);
  } else {
    const masterRate = rateSetting(state.masterRateDivisorSettings?.[payoutCurrency]);
    const manualDivider = Number(order.manualMasterRateDivider || 0);
    const manualPercent = Number(order.manualMasterRatePercent || 0);
    const divider = masterRate.enabled ? masterRate.divider : manualDivider > 0 ? manualDivider : manualPercent > 0 ? 1 : 0;
    const percent = masterRate.enabled ? masterRate.percent : manualPercent > 0 ? manualPercent : 0;
    if (divider > 0) baseAmountMinor = minorFromMajor(majorFromMinor(order.payoutAmountMinor, payoutCurrency) / divider * (1 + percent / 100), "USD");
    else if (payerLine) baseAmountMinor = currencyToUsd(state, payerLine.currency, payerLine.amountMinor);
  }
  let collectedUsdMinor = sourceCurrency === "USD" ? collectedMinor : sourceCurrency === "EUR"
    ? minorFromMajor(majorFromMinor(collectedMinor, "EUR") * rates.eurToUsd, "USD")
    : 0;
  let profitMinor = collectedUsdMinor - baseAmountMinor;
  const broker = activeActors(state).find((actor) => actor.name === order.broker);
  if (sourceCurrency === "EUR" && broker?.currency === "EUR") {
    const collectedEur = majorFromMinor(collectedMinor, "EUR");
    const payoutMajor = majorFromMinor(order.payoutAmountMinor, payoutCurrency);
    const localRate = payoutCurrency === "ETB" ? rates.usdToEtb : payoutCurrency === "ERN" ? rates.usdToErn : rates.usdToEtb;
    if (["ETB", "ERN", "USD"].includes(payoutCurrency) && localRate > 0) {
      const payoutLocal = payoutCurrency === "USD" ? payoutMajor * rates.usdToEtb : payoutMajor;
      profitMinor = minorFromMajor(((collectedEur * rates.eurToUsd * localRate) - payoutLocal) / localRate, "USD");
      if (!usdPayoutActorBaseMinor && !(payingActor && actorHasSpecialPayout(payingActor.role))) baseAmountMinor = collectedUsdMinor - profitMinor;
    }
  }
  if ((usdPayoutActorBaseMinor > 0 || (payingActor && actorHasSpecialPayout(payingActor.role))) && baseAmountMinor > 0) {
    profitMinor = collectedUsdMinor - baseAmountMinor;
  }
  order.incomeBaseCurrency = "USD";
  order.incomeBaseAmountMinor = baseAmountMinor;
  order.incomeCollectedCurrency = sourceCurrency;
  order.incomeCollectedOriginalMinor = collectedMinor;
  order.incomeCollectedEurMinor = sourceCurrency === "EUR" ? collectedMinor : 0;
  order.incomeCollectedUsdMinor = collectedUsdMinor;
  order.incomeProfitMinor = profitMinor;
  order.incomeSnapshotAt = order.paidAt || new Date().toISOString();
  order.incomeMasterRateSnapshot = { ...rateSetting(state.masterRateDivisorSettings?.[payoutCurrency]), payoutCurrency };
  if (payoutCurrency === "USD" && payingActor?.role === "Agent" && payingActor.currency === "USD") {
    const setting = rateSetting(payingActor.incomeUsdPayoutSetting);
    order.incomeUsdAgentRateSnapshot = { actorId: payingActor.id, actorName: payingActor.name, divider: setting.divider, percent: setting.percent };
  }
}

export async function assignOrder(orderId: string, agentId: string, dividerText = "", percentText = ""): Promise<WorkspaceState> {
  return updateWorkspaceState((state) => {
    const order = state.orders.find((item) => item.id === orderId);
    const agent = activeActors(state).find((actor) => actor.id === agentId);
    if (!order || order.state !== "Pending Forward") throw new Error("This order is no longer waiting for forwarding.");
    if (!agent || agent.name === order.broker || !actorCanPayoutCurrency(agent, order.payoutCurrency)) throw new Error(`Choose a ${order.payoutCurrency} payout actor.`);
    const divider = Number(dividerText || 0);
    const percent = Number(percentText || 0);
    if (dividerText && divider <= 0) throw new Error("Enter a payout divisor greater than zero.");
    if (percentText && percent < 0) throw new Error("Enter zero or a positive percentage.");
    order.agent = agent.name;
    order.agentActorId = agent.id;
    assignAgentNumber(state, order, agent.name);
    if (dividerText) order.forwardedPayoutDivider = divider;
    else delete order.forwardedPayoutDivider;
    if (percentText) order.forwardedPayoutPercent = percent;
    else delete order.forwardedPayoutPercent;
    order.state = "Assigned";
    order.assignedAt = new Date().toISOString();
    order.updatedAt = order.assignedAt;
    appendOrderAssignmentMessage(state, order, agent);
    const receivable = state.receivables.find((item) => item.orderId === order.id);
    if (receivable) receivable.updatedAt = order.updatedAt;
  });
}

export async function returnOrder(orderId: string, actorName = "Master"): Promise<WorkspaceState> {
  return updateWorkspaceState((state) => {
    const order = state.orders.find((item) => item.id === orderId);
    if (!order) throw new Error("This order is no longer available.");
    const masterReturn = order.state === "Pending Forward";
    const payerReturn = order.state === "Assigned" && order.agent === actorName;
    if (!masterReturn && !payerReturn) throw new Error("This order can no longer be returned.");
    order.state = "Returned";
    order.returnedBy = actorName;
    order.returnedAt = new Date().toISOString();
    order.returnedReason = "";
    order.agent = "Unassigned";
    order.agentActorId = "";
    order.updatedAt = order.returnedAt;
  });
}

export async function cancelOrder(orderId: string): Promise<WorkspaceState> {
  return updateWorkspaceState((state) => {
    const order = state.orders.find((item) => item.id === orderId);
    if (!order || order.state !== "Pending Forward") return;
    order.state = "Cancelled";
    order.agent = "Cancelled";
    order.cancelledAt = new Date().toISOString();
    order.updatedAt = order.cancelledAt;
  });
}

function appendPaymentProofToMaster(state: WorkspaceState, order: OrderRecord, actor: ActorRecord, proof: PreparedPaymentProof, postedAt: string): void {
  ensureDirectChats(state);
  const master = activeActors(state).find((item) => item.role === "Master");
  const chat = master && state.chatConversations.find((item) =>
    item.type === "direct" && item.members.includes(master.name) && item.members.includes(actor.name)
  );
  if (!master || !chat) throw new Error("The payment file could not be forwarded because the Master chat is unavailable.");
  const displayNumber = proof.orderNumber || order.agentOrderNumbers?.[actor.name] || order.agentOrderNumber || brokerOrderNumber(order);
  const payoutCurrency = order.payoutCurrency || order.sourceCurrency;
  const payoutAmount = majorFromMinor(Number(order.payoutAmountMinor || order.sourceAmountMinor || 0), payoutCurrency);
  chat.messages.push({
    id: nextMessageId(state),
    from: actor.name,
    text: `Payment proof for order ${displayNumber}. Paid ${compactAmount(payoutCurrency, payoutAmount)}.`,
    kind: proof.mediaType === "image" ? "photo" : "file",
    media: proof.dataUri,
    fileName: proof.fileName,
    mimeType: proof.mimeType,
    orderNumber: displayNumber,
    replyTo: "",
    reactions: {},
    readBy: [actor.name],
    createdAt: postedAt
  });
}

export async function markOrderPaid(orderId: string, actorId: string, proof?: PreparedPaymentProof): Promise<WorkspaceState> {
  if (processingOrderIds.has(orderId)) throw new Error("This payment is already being posted.");
  processingOrderIds.add(orderId);
  try {
    return await updateWorkspaceState((state) => {
    const order = state.orders.find((item) => item.id === orderId);
    const actor = activeActors(state).find((item) => item.id === actorId);
    if (!order || order.state !== "Assigned" || order.journal) throw new Error("This order has already changed. Refresh and try again.");
    if (!actor || !actorCanReceivePayouts(actor.role) || (order.agentActorId !== actor.id && order.agent !== actor.name)) throw new Error("Only the assigned payer can mark this order as paid.");
    const journal = nextJournalId(state);
    const postedAt = new Date().toISOString();
    const payer = payingActorStatement(state, order);
    const details = orderDetails(order);
    const lines: LedgerLine[] = [
      { journal, orderId: order.id, source: "ORDER_PAYMENT", account: `${order.broker} ACTOR_CLEARING`, direction: "Debit" as const, currency: order.sourceCurrency, amountMinor: Number(order.sourceAmountMinor || 0), details, postedAt },
      { journal, orderId: order.id, source: "ORDER_PAYMENT", account: `${order.broker} ACTOR_CLEARING`, direction: "Debit" as const, currency: order.sourceCurrency, amountMinor: Number(order.commissionMinor || 0), details, postedAt },
      { journal, orderId: order.id, source: "ORDER_PAYMENT", account: "MASTER_FX_CLEARING", direction: "Credit" as const, currency: order.sourceCurrency, amountMinor: Number(order.sourceAmountMinor || 0), details, postedAt },
      { journal, orderId: order.id, source: "ORDER_PAYMENT", account: "MASTER_FEE_REVENUE", direction: "Credit" as const, currency: order.sourceCurrency, amountMinor: Number(order.commissionMinor || 0), details, postedAt },
      { journal, orderId: order.id, source: "ORDER_PAYMENT", account: "MASTER_FX_CLEARING", direction: "Debit" as const, currency: payer.currency, amountMinor: payer.amountMinor, details, postedAt },
      { journal, orderId: order.id, source: "ORDER_PAYMENT", account: `${order.agent} ACTOR_CLEARING`, direction: "Credit" as const, currency: payer.currency, amountMinor: payer.amountMinor, details, postedAt }
    ].filter((line) => line.amountMinor > 0);
    order.journal = journal;
    order.state = "Paid";
    order.paidAt = postedAt;
    order.updatedAt = postedAt;
    order.returnedBy = "";
    order.returnedReason = "";
    if (proof) {
      appendPaymentProofToMaster(state, order, actor, proof, postedAt);
      order.paymentProof = { ...proof, dataUri: "", attachedAt: postedAt };
    }
    freezeIncome(state, order, lines);
    state.ledger.unshift(...lines);
    });
  } finally {
    processingOrderIds.delete(orderId);
  }
}

export async function requestOrderVoid(orderId: string, actorName: string): Promise<WorkspaceState> {
  return updateWorkspaceState((state) => {
    const order = state.orders.find((item) => item.id === orderId);
    if (!order || order.state !== "Paid" || !order.journal || order.voidJournal || orderBalanceWasClosed(state, order)) {
      throw new Error("This order cannot request a void because it is unavailable or its balance is closed.");
    }
    order.state = "Void Requested";
    order.voidRequested = true;
    order.excludedFromCalculations = false;
    order.voidRequestedBy = actorName;
    order.voidRequestedAt = new Date().toISOString();
    order.updatedAt = order.voidRequestedAt;
  });
}

export async function rejectOrderVoid(orderId: string, actorName: string): Promise<WorkspaceState> {
  return updateWorkspaceState((state) => {
    const order = state.orders.find((item) => item.id === orderId);
    if (!order || order.state !== "Void Requested" || order.voidJournal || orderBalanceWasClosed(state, order)) {
      throw new Error("This void request is no longer available or its balance is closed.");
    }
    order.state = "Paid";
    order.voidRequested = false;
    order.excludedFromCalculations = false;
    order.voidRejectedBy = actorName;
    order.voidRejectedAt = new Date().toISOString();
    order.updatedAt = order.voidRejectedAt;
  });
}

export async function approveOrderVoid(orderId: string, actorName: string): Promise<WorkspaceState> {
  return updateWorkspaceState((state) => {
    const order = state.orders.find((item) => item.id === orderId);
    if (!order?.journal || order.state !== "Void Requested" || order.voidJournal || orderBalanceWasClosed(state, order)) {
      throw new Error("This void request is no longer available or its balance is closed.");
    }
    const paidLines = state.ledger.filter((line) => line.archived !== true && line.source === "ORDER_PAYMENT" && line.journal === order.journal);
    if (!paidLines.length) throw new Error("The payment journal could not be found.");
    const journal = nextJournalId(state);
    const postedAt = new Date().toISOString();
    paidLines.forEach((line) => {
      line.orderId = order.id;
      line.voided = true;
      line.excludedFromCalculations = true;
      line.voidedAt = postedAt;
    });
    state.ledger.unshift(...paidLines.map((line) => ({
      ...line,
      journal,
      source: "ORDER_VOID",
      direction: line.direction === "Debit" ? "Credit" as const : "Debit" as const,
      details: `Void of ${brokerOrderNumber(order)}`,
      voided: true,
      excludedFromCalculations: true,
      voidedAt: postedAt,
      postedAt
    })));
    order.state = "Voided";
    order.voidJournal = journal;
    order.voidRequested = false;
    order.excludedFromCalculations = true;
    order.voidedAt = postedAt;
    order.voidedBy = actorName;
    order.updatedAt = postedAt;
    const receivable = state.receivables.find((item) => item.orderId === order.id);
    if (receivable) {
      receivable.voided = true;
      receivable.voidedAt = postedAt;
      receivable.voidedBy = actorName;
      receivable.updatedAt = postedAt;
    }
  });
}

function transferDetails(transfer: InternalTransferRecord): string {
  const commission = Number(transfer.commissionMinor || 0);
  return [
    `${transfer.from} -> ${transfer.to}`,
    transfer.forwardedAt && transfer.requestedTo ? `Originally sent to ${transfer.requestedTo}` : "",
    `Source: ${compactAmount(transfer.sourceCurrency, majorFromMinor(transfer.sourceAmountMinor, transfer.sourceCurrency))}`,
    `Payout: ${compactAmount(transfer.currency, majorFromMinor(transfer.amountMinor, transfer.currency))}`,
    `Rate: ${transfer.rate || 1}`,
    commission > 0 ? `Commission: ${compactAmount(transfer.sourceCurrency, majorFromMinor(commission, transfer.sourceCurrency))}` : "",
    transfer.forwardedBy ? `Forwarded by: ${transfer.forwardedBy}` : "",
    transfer.acceptedBy ? `Accepted by: ${transfer.acceptedBy}` : "",
    transfer.remarks ? `Remarks: ${transfer.remarks}` : ""
  ].filter(Boolean).join(" - ");
}

function transferCommissionMinor(transfer: Partial<InternalTransferRecord>): number {
  const stored = Number(transfer.commissionMinor || 0);
  if (stored > 0) return stored;
  return Math.round(Number(transfer.sourceAmountMinor || 0) * Math.max(0, Number(transfer.commissionPercent || 0)) / 100);
}

function normalizeMasterBankEntries(entries: MasterBankEntryRecord[] | undefined): MasterBankEntryRecord[] {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && entry.id && ["Credit", "Debit"].includes(entry.direction) && supportedCurrencies.includes(entry.currency) && Number(entry.amountMinor) > 0)
    .map((entry) => ({ ...entry, amountMinor: Number(entry.amountMinor) }));
}

export type MasterBankStatementEntry = MasterBankEntryRecord & { runningMinor: number };

export function masterBankEntriesWithRunningBalances(state: WorkspaceState): MasterBankStatementEntry[] {
  const entries = new Map(normalizeMasterBankEntries(state.masterBankEntries).map((entry) => [entry.id, entry]));
  const record = (entry: MasterBankEntryRecord) => {
    if (!entries.has(entry.id) && entry.amountMinor > 0) entries.set(entry.id, entry);
  };
  const master = activeActors(state).find((actor) => actor.role === "Master");
  const masterNames = new Set(["Master", master?.name].filter(Boolean));
  const isMasterName = (name: string | undefined) => Boolean(name && masterNames.has(name));
  const transfers = new Map<string, Partial<InternalTransferRecord>>();
  state.transfers.forEach((transfer) => transfers.set(transfer.id, transfer));
  state.archives.forEach((archive) => (archive.transfers || []).forEach((transfer) => {
    if (!transfer.id) return;
    transfers.set(transfer.id, { ...(transfers.get(transfer.id) || {}), ...transfer } as Partial<InternalTransferRecord>);
  }));

  transfers.forEach((transfer) => {
    if (!transfer.id || !transfer.journal || !["Approved", "Reversed"].includes(String(transfer.state))) return;
    const sourceCurrency = transfer.sourceCurrency || transfer.currency || "USD";
    const payoutCurrency = transfer.currency || sourceCurrency;
    const sourceAmountMinor = Number(transfer.sourceAmountMinor || transfer.amountMinor || 0);
    const payoutAmountMinor = Number(transfer.amountMinor || 0);
    const details = transfer.details || transferDetails(transfer as InternalTransferRecord);
    const postedAt = transfer.paidOutAt || transfer.approvedAt || transfer.sentAt || transfer.createdAt || new Date(0).toISOString();
    if (isMasterName(transfer.to) && !isMasterName(transfer.from)) {
      record({ id: `BANK-TRANSFER-${transfer.id}-IN`, type: "Transfer In", reference: transfer.id, direction: "Credit", currency: payoutCurrency, amountMinor: payoutAmountMinor, details, postedAt });
    } else if (isMasterName(transfer.from) && !isMasterName(transfer.to)) {
      record({ id: `BANK-TRANSFER-${transfer.id}-OUT`, type: "Transfer Out", reference: transfer.id, direction: "Debit", currency: sourceCurrency, amountMinor: sourceAmountMinor, details, postedAt });
      if (transfer.reversalJournal) {
        record({ id: `BANK-TRANSFER-${transfer.id}-REVERSAL`, type: "Transfer Reversal", reference: transfer.reversalJournal, direction: "Credit", currency: sourceCurrency, amountMinor: sourceAmountMinor, details: `Reversal of ${transfer.id}${details ? ` - ${details}` : ""}`, postedAt: transfer.reversedAt || postedAt });
      }
    } else if (!isMasterName(transfer.from) && !isMasterName(transfer.to)) {
      const commissionMinor = transferCommissionMinor(transfer);
      if (commissionMinor > 0) {
        record({ id: `BANK-TRANSFER-${transfer.id}-FEE`, type: "Transfer Fee Expense", reference: transfer.id, direction: "Debit", currency: sourceCurrency, amountMinor: commissionMinor, details: `Fee expense for ${transfer.from} to ${transfer.to}${transfer.remarks ? ` - ${transfer.remarks}` : ""}`, postedAt });
      }
    }
  });

  state.ledger.filter((line) => line.source === "JOURNAL").forEach((line) => {
    record({
      id: `BANK-JOURNAL-${line.entryId || line.journal}`,
      type: "Journal",
      reference: String(line.entryId || line.journal || ""),
      direction: "Debit",
      currency: (line.sourceCurrency as Currency) || line.currency,
      amountMinor: Number(line.sourceAmountMinor || line.amountMinor || 0),
      details: String(line.details || "Master journal to Actor"),
      postedAt: String(line.postedAt || new Date(0).toISOString())
    });
  });

  state.ledger.filter((line) => line.source === "WITHDRAWAL" && line.direction === "Credit" && String(line.account).endsWith(" ACTOR_CLEARING")).forEach((line) => {
    record({ id: `BANK-WITHDRAWAL-${line.entryId || line.journal}`, type: "Withdrawal", reference: String(line.entryId || line.journal || ""), direction: "Credit", currency: line.currency, amountMinor: Number(line.amountMinor || 0), details: String(line.details || "Withdrawal from Actor"), postedAt: String(line.postedAt || new Date(0).toISOString()) });
  });

  state.archives.forEach((archive) => {
    const archivedActor = state.actors.find((actor) => actor.id === archive.actorId || actor.name === archive.actor);
    const role = archive.actorRole || archivedActor?.role;
    const incomeProfitMinor = Number(archive.incomeProfitMinor || 0);
    if (!archive.id || !["Agent", "Special Agent"].includes(String(role)) || incomeProfitMinor === 0) return;
    record({ id: `BANK-INCOME-${archive.id}`, type: "Income Statement Close", reference: archive.id, direction: incomeProfitMinor > 0 ? "Credit" : "Debit", currency: archive.incomeProfitCurrency || "USD", amountMinor: Math.abs(incomeProfitMinor), details: `${archive.actor || "Actor"} closed Income Statement`, postedAt: archive.closedAt || new Date(0).toISOString() });
  });

  const runningByCurrency: Partial<Record<Currency, number>> = {};
  return Array.from(entries.values())
    .sort((a, b) => new Date(a.postedAt || 0).getTime() - new Date(b.postedAt || 0).getTime() || a.id.localeCompare(b.id))
    .map((entry) => {
      runningByCurrency[entry.currency] = Number(runningByCurrency[entry.currency] || 0) + (entry.direction === "Credit" ? entry.amountMinor : -entry.amountMinor);
      return { ...entry, runningMinor: Number(runningByCurrency[entry.currency]) };
    });
}

function syncMasterBankAccount(state: WorkspaceState): void {
  state.masterBankEntries = masterBankEntriesWithRunningBalances(state).map(({ runningMinor: _runningMinor, ...entry }) => entry);
}

export async function fundMasterBankAccount(input: { currency: Currency; amount: string; reason: string; postedBy: string }): Promise<WorkspaceState> {
  return updateWorkspaceState((state) => {
    const amountMinor = minorFromMajor(parseAmount(input.amount), input.currency);
    const reason = input.reason.trim();
    if (amountMinor <= 0 || !reason) throw new Error("Enter a funding amount and state the reason.");
    syncMasterBankAccount(state);
    const reference = `FUND-${Date.now()}`;
    state.masterBankEntries = [{ id: `BANK-${reference}`, type: "Funding", reference, direction: "Credit", currency: input.currency, amountMinor, details: `Reason: ${reason}`, postedAt: new Date().toISOString(), postedBy: input.postedBy }, ...(state.masterBankEntries || [])];
  });
}

function postTransferLedger(state: WorkspaceState, transfer: InternalTransferRecord): void {
  if (transfer.journal) return;
  const journal = nextJournalId(state);
  const postedAt = new Date().toISOString();
  const commission = Number(transfer.commissionMinor || 0);
  const details = transferDetails(transfer);
  transfer.journal = journal;
  transfer.approvedAt = transfer.approvedAt || postedAt;
  transfer.paidOutAt = transfer.paidOutAt || postedAt;
  state.ledger.unshift(
    { journal, transferId: transfer.id, source: "TRANSFER", account: transfer.to, direction: "Debit", currency: transfer.currency, amountMinor: transfer.amountMinor, details, postedAt },
    { journal, transferId: transfer.id, source: "TRANSFER", account: "MASTER_FX_CLEARING", direction: "Credit", currency: transfer.currency, amountMinor: transfer.amountMinor, details, postedAt },
    { journal, transferId: transfer.id, source: "TRANSFER", account: "MASTER_FX_CLEARING", direction: "Debit", currency: transfer.sourceCurrency, amountMinor: transfer.sourceAmountMinor, details, postedAt },
    { journal, transferId: transfer.id, source: "TRANSFER", account: transfer.from, direction: "Credit", currency: transfer.sourceCurrency, amountMinor: transfer.sourceAmountMinor, details, postedAt }
  );
  if (commission > 0) {
    state.ledger.unshift(
      { journal, transferId: transfer.id, source: "TRANSFER", account: transfer.from, direction: "Debit", currency: transfer.sourceCurrency, amountMinor: commission, details, postedAt },
      { journal, transferId: transfer.id, source: "TRANSFER", account: "MASTER_FEE_REVENUE", direction: "Credit", currency: transfer.sourceCurrency, amountMinor: commission, details, postedAt }
    );
  }
}

export async function createInternalTransfer(session: UserSession, draft: InternalTransferDraft): Promise<WorkspaceState> {
  return updateWorkspaceState((state) => {
    const from = actorForSession(session, state);
    const to = activeActors(state).find((actor) => actor.id === draft.toActorId);
    if (!from || !to || from.id === to.id) throw new Error("Choose a receiving actor.");
    if (!transferTargetsFor(session, state).some((actor) => actor.id === to.id)) throw new Error("This transfer destination is not permitted.");
    if (!actorTransferCurrencies(from).includes(draft.sourceCurrency)) {
      throw new Error(`${from.name} can only send transfers in ${from.currency}.`);
    }
    if (!actorTransferReceiveCurrencies(to).includes(draft.payoutCurrency)) {
      throw new Error(`${to.name} can only receive this transfer in ${to.currency}.`);
    }
    const sourceMajor = parseAmount(draft.sourceAmount);
    const rate = Number(draft.rate || 0);
    const payoutMajor = parseAmount(draft.payoutAmount) || sourceMajor * rate;
    const commissionPercent = Number(draft.commissionPercent || 0);
    if (sourceMajor <= 0 || payoutMajor <= 0 || rate <= 0 || !Number.isFinite(commissionPercent) || commissionPercent < 0) {
      throw new Error("Enter source amount, payout amount, rate, and a percentage of zero or more.");
    }
    const now = new Date().toISOString();
    const transfer: InternalTransferRecord = {
      id: nextTransferId(state),
      from: from.name,
      fromActorId: from.id,
      to: to.name,
      toActorId: to.id,
      sourceCurrency: draft.sourceCurrency,
      sourceAmountMinor: minorFromMajor(sourceMajor, draft.sourceCurrency),
      currency: draft.payoutCurrency,
      amountMinor: minorFromMajor(payoutMajor, draft.payoutCurrency),
      rate,
      commissionPercent,
      commissionMinor: minorFromMajor(sourceMajor * commissionPercent / 100, draft.sourceCurrency),
      remarks: draft.remarks.trim(),
      state: isMasterView(session) ? "Approved" : "Pending Approval",
      initiatedBy: from.name,
      createdAt: now,
      sentAt: now
    };
    if (isMasterView(session)) postTransferLedger(state, transfer);
    state.transfers.unshift(transfer);
    syncMasterBankAccount(state);
  });
}

export async function forwardInternalTransfer(
  session: UserSession,
  transferId: string,
  draft: InternalTransferForwardDraft
): Promise<WorkspaceState> {
  if (!isMasterView(session)) throw new Error("Only Master can forward a pending transfer.");
  if (processingTransferIds.has(transferId)) throw new Error("This transfer is already being processed.");
  processingTransferIds.add(transferId);
  try {
    return await updateWorkspaceState((state) => {
      const transfer = state.transfers.find((item) => item.id === transferId);
      const master = actorForSession(session, state);
      const receiver = activeActors(state).find((actor) => actor.id === draft.toActorId);
      const arrivedAtMaster = Boolean(master && transfer && (transfer.toActorId === master.id || transfer.to === master.name));
      if (!transfer || transfer.state !== "Pending Approval" || transfer.journal || !arrivedAtMaster || transfer.fromActorId === master?.id || transfer.from === master?.name) {
        throw new Error("Only an Actor transfer awaiting Master can be forwarded.");
      }
      if (!receiver || receiver.role === "Master" || receiver.id === transfer.fromActorId || receiver.name === transfer.from) {
        throw new Error("Choose another receiving Actor.");
      }
      if (!actorTransferReceiveCurrencies(receiver).includes(draft.payoutCurrency)) {
        throw new Error(`${receiver.name} can only receive this transfer in ${receiver.currency}.`);
      }
      const sourceMajor = majorFromMinor(transfer.sourceAmountMinor, transfer.sourceCurrency);
      const rate = Number(draft.rate || 0);
      const payoutMajor = parseAmount(draft.payoutAmount) || sourceMajor * rate;
      const commissionPercent = Number(draft.commissionPercent || 0);
      if (sourceMajor <= 0 || rate <= 0 || payoutMajor <= 0 || !Number.isFinite(commissionPercent) || commissionPercent < 0) {
        throw new Error("Enter a receiving Actor, payout currency, rate, payout amount, and percentage of zero or more.");
      }
      const now = new Date().toISOString();
      transfer.requestedTo = transfer.requestedTo || transfer.to;
      transfer.requestedToActorId = transfer.requestedToActorId || transfer.toActorId;
      transfer.requestedCurrency = transfer.requestedCurrency || transfer.currency;
      transfer.requestedAmountMinor = Number(transfer.requestedAmountMinor || transfer.amountMinor);
      transfer.requestedRate = transfer.requestedRate || transfer.rate;
      transfer.requestedCommissionPercent = Number.isFinite(Number(transfer.requestedCommissionPercent))
        ? Number(transfer.requestedCommissionPercent)
        : Number(transfer.commissionPercent || 0);
      transfer.requestedCommissionMinor = Number.isFinite(Number(transfer.requestedCommissionMinor))
        ? Number(transfer.requestedCommissionMinor)
        : Number(transfer.commissionMinor || 0);
      transfer.to = receiver.name;
      transfer.toActorId = receiver.id;
      transfer.currency = draft.payoutCurrency;
      transfer.amountMinor = minorFromMajor(payoutMajor, draft.payoutCurrency);
      transfer.rate = rate;
      transfer.commissionPercent = commissionPercent;
      transfer.commissionMinor = minorFromMajor(sourceMajor * commissionPercent / 100, transfer.sourceCurrency);
      transfer.state = "Pending Acceptance";
      transfer.forwardedBy = session.actorName;
      transfer.forwardedAt = now;
      transfer.approvedAt = "";
      transfer.paidOutAt = "";
      transfer.returnedAt = "";
      transfer.rejectedAt = "";
      transfer.rejectedBy = "";
      transfer.updatedAt = now;
    });
  } finally {
    processingTransferIds.delete(transferId);
  }
}

export async function respondToForwardedTransfer(
  session: UserSession,
  transferId: string,
  accept: boolean
): Promise<WorkspaceState> {
  if (processingTransferIds.has(transferId)) throw new Error("This transfer is already being processed.");
  processingTransferIds.add(transferId);
  try {
    return await updateWorkspaceState((state) => {
      const transfer = state.transfers.find((item) => item.id === transferId);
      const actor = actorForSession(session, state);
      const isReceiver = Boolean(actor && transfer && (transfer.toActorId === actor.id || transfer.to === actor.name));
      if (!transfer || !actor || transfer.state !== "Pending Acceptance" || transfer.journal || !isReceiver || actor.role === "Master") {
        throw new Error("Only the receiving Actor can respond to this forwarded transfer.");
      }
      const now = new Date().toISOString();
      if (accept) {
        transfer.state = "Approved";
        transfer.acceptedBy = actor.name;
        transfer.acceptedAt = now;
        transfer.approvedAt = now;
        transfer.updatedAt = now;
        postTransferLedger(state, transfer);
      } else {
        transfer.state = "Rejected";
        transfer.rejectedBy = actor.name;
        transfer.rejectedAt = now;
        transfer.updatedAt = now;
      }
      syncMasterBankAccount(state);
    });
  } finally {
    processingTransferIds.delete(transferId);
  }
}

export async function setTransferState(transferId: string, action: "approve" | "return" | "reject", actorName: string): Promise<WorkspaceState> {
  if (processingTransferIds.has(transferId)) throw new Error("This transfer is already being processed.");
  processingTransferIds.add(transferId);
  try {
    return await updateWorkspaceState((state) => {
    const transfer = state.transfers.find((item) => item.id === transferId);
    if (!transfer || transfer.state !== "Pending Approval" || transfer.journal) throw new Error("This transfer is no longer pending.");
    const now = new Date().toISOString();
    if (action === "approve") {
      transfer.state = "Approved";
      transfer.approvedAt = now;
      postTransferLedger(state, transfer);
    } else if (action === "return") {
      transfer.state = "Returned";
      transfer.returnedAt = now;
      transfer.returnedBy = actorName;
      transfer.returnedReason = "Update Details";
    } else {
      transfer.state = "Rejected";
      transfer.rejectedAt = now;
    }
    syncMasterBankAccount(state);
    });
  } finally {
    processingTransferIds.delete(transferId);
  }
}

export async function collectReceivable(receivableId: string, amountText: string, actorName: string): Promise<WorkspaceState> {
  return updateWorkspaceState((state) => {
    const receivable = state.receivables.find((item) => item.id === receivableId);
    if (!receivable || receivable.voided) throw new Error("This receivable is not available.");
    const amountMinor = minorFromMajor(parseAmount(amountText), receivable.currency);
    const paidMinor = receivable.payments.reduce((sum, payment) => sum + Number(payment.amountMinor || 0), 0);
    const balanceMinor = Math.max(0, receivable.principalMinor - paidMinor);
    if (amountMinor <= 0 || amountMinor > balanceMinor) throw new Error(`Enter an amount up to ${compactAmount(receivable.currency, majorFromMinor(balanceMinor, receivable.currency))}.`);
    receivable.payments.push({ id: `PAY-${Date.now()}`, amountMinor, paidAt: new Date().toISOString(), receivedBy: actorName });
    receivable.updatedAt = new Date().toISOString();
  });
}

function nextManagedActorId(state: WorkspaceState): string {
  const reserved = new Set([...state.actors.map((actor) => actor.id), ...(state.deletedActorIds || [])]);
  const highest = Array.from(reserved).reduce((value, actorId) => {
    const match = actorId.match(/^ACT-(\d+)$/);
    return match ? Math.max(value, Number(match[1])) : value;
  }, 0);
  let next = Math.max(Number(state.actorCounter || 0), highest) + 1;
  while (reserved.has(`ACT-${next}`)) next += 1;
  state.actorCounter = next;
  return `ACT-${next}`;
}

export async function createManagedActor(input: { name: string; role: ActorRecord["role"]; currency: Currency; workingCurrencies: Currency[] }): Promise<WorkspaceState> {
  return updateWorkspaceState((state) => {
    const name = input.name.trim();
    if (!name) throw new Error("Enter an actor name.");
    if (state.actors.some((actor) => actor.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error("Actor name must be unique.");
    state.actors.push({
      id: nextManagedActorId(state),
      name,
      role: input.role,
      currency: input.currency,
      workingCurrencies: actorHasSpecialPayout(input.role) ? Array.from(new Set([input.currency, ...input.workingCurrencies])) : [],
      active: true,
      managedByMaster: true,
      transferEnabled: true,
      transferMode: "master",
      incomeStatementVisible: true,
      incomeUsdPayoutSetting: input.role === "Agent" && input.currency === "USD" ? { divider: 1, percent: 0 } : undefined
    });
  });
}

export async function updateActorTransferMode(actorId: string, mode: ActorRecord["transferMode"]): Promise<WorkspaceState> {
  return updateWorkspaceState((state) => {
    const actor = state.actors.find((item) => item.id === actorId);
    if (!actor || actor.role === "Master") return;
    actor.transferMode = mode || "none";
    actor.transferEnabled = mode !== "none";
  });
}

export async function updateBuyingRates(rates: { eurToUsd: number; usdToEtb: number; usdToErn: number }): Promise<WorkspaceState> {
  return updateWorkspaceState((state) => {
    if (rates.eurToUsd <= 0 || rates.usdToEtb <= 0 || rates.usdToErn <= 0) throw new Error("All buying rates must be greater than zero.");
    state.buyingRates = rates;
  });
}

export async function updateMasterRateSetting(currency: Currency, setting: RateSetting): Promise<WorkspaceState> {
  return updateWorkspaceState((state) => {
    const divider = Number(setting.divider || 0);
    const percent = Number(setting.percent || 0);
    if (setting.enabled && divider <= 0) throw new Error("Enter a divisor greater than zero.");
    if (percent < 0) throw new Error("Enter zero or a positive percentage.");
    state.masterRateDivisorSettings = { ...(state.masterRateDivisorSettings || {}), [currency]: { enabled: setting.enabled === true, divider: divider || 1, percent } };
  });
}

export async function updateUsdAgentIncomeRate(actorId: string, setting: RateSetting): Promise<WorkspaceState> {
  return updateWorkspaceState((state) => {
    const actor = activeActors(state).find((item) => item.id === actorId);
    const divider = Number(setting.divider || 0);
    const percent = Number(setting.percent || 0);
    if (!actor || actor.role !== "Agent" || actor.currency !== "USD") throw new Error("Choose a USD Agent.");
    if (divider <= 0) throw new Error("Enter a divisor greater than zero.");
    if (percent < 0) throw new Error("Enter zero or a positive percentage.");
    state.orders
      .filter((order) => order.state === "Paid" && order.journal && !order.voidJournal && !Number.isFinite(Number(order.incomeBaseAmountMinor)))
      .forEach((order) => {
        const lines = state.ledger.filter((line) => line.journal === order.journal && line.source === "ORDER_PAYMENT");
        if (lines.length) freezeIncome(state, order, lines);
      });
    actor.incomeUsdPayoutSetting = { divider, percent };
  });
}

export async function updateActorOrderSettings(actorId: string, input: {
  orderMultiCurrencyEnabled?: boolean;
  transferReceiveMultiCurrencyEnabled?: boolean;
  visibility?: ActorRecord["orderVisibilityPermissions"];
}): Promise<WorkspaceState> {
  return updateWorkspaceState((state) => {
    const actor = state.actors.find((item) => item.id === actorId);
    if (!actor || actor.role === "Master") throw new Error("Choose an actor.");
    if (typeof input.orderMultiCurrencyEnabled === "boolean") actor.orderMultiCurrencyEnabled = input.orderMultiCurrencyEnabled;
    if (typeof input.transferReceiveMultiCurrencyEnabled === "boolean") {
      actor.transferReceiveMultiCurrencyEnabled = input.transferReceiveMultiCurrencyEnabled;
    }
    if (input.visibility) actor.orderVisibilityPermissions = { ...(actor.orderVisibilityPermissions || {}), ...input.visibility };
  });
}

export async function postActorJournal(input: { actorId: string; sourceCurrency: Currency; sourceAmount: string; currency: Currency; amount: string; rate: string; remarks: string }): Promise<WorkspaceState> {
  return updateWorkspaceState((state) => {
    const actor = activeActors(state).find((item) => item.id === input.actorId);
    const sourceMajor = parseAmount(input.sourceAmount);
    const rate = Number(input.rate || 0);
    const amountMajor = parseAmount(input.amount) || sourceMajor * rate;
    if (!actor || sourceMajor <= 0 || amountMajor <= 0 || rate <= 0) throw new Error("Complete the journal actor, amount, currency, and rate.");
    const journal = nextJournalId(state);
    const postedAt = new Date().toISOString();
    const sourceAmountMinor = minorFromMajor(sourceMajor, input.sourceCurrency);
    const amountMinor = minorFromMajor(amountMajor, input.currency);
    state.ledger.unshift({
      journal,
      entryId: `JNL-${journal.replace("JRN-", "")}`,
      source: "JOURNAL",
      account: `${actor.name} ACTOR_CLEARING`,
      direction: "Debit",
      currency: input.currency,
      amountMinor,
      sourceCurrency: input.sourceCurrency,
      sourceAmountMinor,
      rate,
      details: [`Journal add ${compactAmount(input.sourceCurrency, sourceMajor)} to ${compactAmount(input.currency, amountMajor)}`, `Rate ${rate}`, input.remarks ? `Remarks: ${input.remarks}` : ""].filter(Boolean).join(" - "),
      postedAt
    });
    syncMasterBankAccount(state);
  });
}

export async function postActorWithdrawal(input: { actorId: string; currency: Currency; amount: string; remarks: string }): Promise<WorkspaceState> {
  return updateWorkspaceState((state) => {
    const actor = activeActors(state).find((item) => item.id === input.actorId);
    const amountMajor = parseAmount(input.amount);
    if (!actor || amountMajor <= 0) throw new Error("Choose an actor and enter a withdrawal amount.");
    const amountMinor = minorFromMajor(amountMajor, input.currency);
    const journal = nextJournalId(state);
    const postedAt = new Date().toISOString();
    const entryId = `WDL-${journal.replace("JRN-", "")}`;
    const details = [`Withdrawal ${compactAmount(input.currency, amountMajor)} from ${actor.name}`, input.remarks ? `Remarks: ${input.remarks}` : ""].filter(Boolean).join(" - ");
    state.ledger.unshift(
      { journal, entryId, source: "WITHDRAWAL", account: `${actor.name} ACTOR_CLEARING`, direction: "Credit", currency: input.currency, amountMinor, details, postedAt },
      { journal, entryId, source: "WITHDRAWAL", account: "MASTER_FX_CLEARING", direction: "Debit", currency: input.currency, amountMinor, details, postedAt }
    );
    syncMasterBankAccount(state);
  });
}

function nextChatId(state: WorkspaceState): string {
  state.chatCounter = Number(state.chatCounter || 0) + 1;
  return `CHAT-${state.chatCounter}`;
}

function nextMessageId(state: WorkspaceState): string {
  state.messageCounter = Number(state.messageCounter || 0) + 1;
  return `MSG-${state.messageCounter}-${Date.now().toString(36)}`;
}

function appendOrderAssignmentMessage(state: WorkspaceState, order: OrderRecord, payer: ActorRecord): void {
  ensureDirectChats(state);
  const master = activeActors(state).find((actor) => actor.role === "Master");
  const chat = master && state.chatConversations.find((item) =>
    item.type === "direct" && item.members.includes(master.name) && item.members.includes(payer.name)
  );
  if (!master || !chat) throw new Error("The payout actor chat is not available.");
  const displayNumber = order.agentOrderNumbers?.[payer.name] || order.agentOrderNumber || brokerOrderNumber(order);
  const payoutCurrency = order.payoutCurrency || order.sourceCurrency;
  const payoutAmount = majorFromMinor(Number(order.payoutAmountMinor || order.sourceAmountMinor || 0), payoutCurrency);
  const receiver = order.receiverName || order.accountNumber || order.phoneNumber || "the receiver";
  chat.messages.push({
    id: nextMessageId(state),
    from: master.name,
    text: `Order ${displayNumber} assigned to you. Pay ${compactAmount(payoutCurrency, payoutAmount)} to ${receiver}.`,
    kind: "text",
    replyTo: "",
    reactions: {},
    readBy: [master.name],
    createdAt: order.assignedAt || new Date().toISOString()
  });
}

export function ensureDirectChats(state: WorkspaceState): void {
  const actors = activeActors(state);
  const master = actors.find((actor) => actor.role === "Master")?.name || "Master";
  actors.filter((actor) => actor.role !== "Master").forEach((actor) => {
    const exists = state.chatConversations.some((chat) => chat.type === "direct" && chat.members.includes(master) && chat.members.includes(actor.name));
    if (!exists) state.chatConversations.push({ id: nextChatId(state), type: "direct", name: actor.name, members: [master, actor.name], messages: [], createdAt: new Date().toISOString() });
  });
}

export async function sendChatMessage(chatId: string, from: string, text: string, replyTo = ""): Promise<WorkspaceState> {
  return updateWorkspaceState((state) => {
    ensureDirectChats(state);
    const chat = state.chatConversations.find((item) => item.id === chatId);
    const clean = text.trim();
    if (!chat || !clean || !chat.members.includes(from)) throw new Error("Choose a chat and enter a message.");
    const reply = replyTo ? chat.messages.find((item) => item.id === replyTo) : undefined;
    if (replyTo && !reply) throw new Error("The message being replied to is no longer available.");
    chat.messages.push({ id: nextMessageId(state), from, text: clean, kind: "text", replyTo: reply?.id || "", reactions: {}, readBy: [from], createdAt: new Date().toISOString() });
  });
}

export async function reactToChatMessage(chatId: string, messageId: string, from: string, reaction: string): Promise<WorkspaceState> {
  return updateWorkspaceState((state) => {
    const chat = state.chatConversations.find((item) => item.id === chatId);
    const message = chat?.messages.find((item) => item.id === messageId);
    if (!chat || !message || !chat.members.includes(from)) throw new Error("This message is no longer available.");
    message.reactions = { ...(message.reactions || {}) };
    if (message.reactions[from] === reaction) delete message.reactions[from];
    else message.reactions[from] = reaction;
  });
}

export async function forwardChatMessage(sourceChatId: string, messageId: string, targetChatId: string, from: string): Promise<WorkspaceState> {
  return updateWorkspaceState((state) => {
    ensureDirectChats(state);
    const master = activeActors(state).find((actor) => actor.role === "Master" && actor.name === from);
    const source = state.chatConversations.find((item) => item.id === sourceChatId);
    const target = state.chatConversations.find((item) => item.id === targetChatId);
    const message = source?.messages.find((item) => item.id === messageId);
    if (!master || !source || !target || !message || source.id === target.id || !source.members.includes(from) || !target.members.includes(from)) {
      throw new Error("Choose another chat to forward this message.");
    }
    target.messages.push({
      id: nextMessageId(state),
      from,
      text: message.text || "",
      kind: message.kind || (message.media ? "photo" : "text"),
      media: message.media || "",
      fileName: message.fileName || "",
      forwardedFrom: message.from,
      replyTo: "",
      reactions: {},
      readBy: [from],
      createdAt: new Date().toISOString()
    });
  });
}

export async function remindOrderActor(orderId: string, masterName: string): Promise<WorkspaceState> {
  return updateWorkspaceState((state) => {
    const order = state.orders.find((item) => item.id === orderId);
    if (!order || !pendingCancelledOrderStates.has(order.state)) throw new Error("This order is no longer available for a reminder.");
    const master = activeActors(state).find((actor) => actor.role === "Master" && actor.name === masterName)
      || activeActors(state).find((actor) => actor.role === "Master");
    if (!master) throw new Error("Only Master can send an order reminder.");
    const payer = activeActors(state).find((actor) => actor.id === order.agentActorId)
      || activeActors(state).find((actor) => actor.name === order.agent);
    if (!payer || !actorCanReceivePayouts(payer.role)) throw new Error("This order does not have an available payout actor.");
    ensureDirectChats(state);
    const chat = state.chatConversations.find((item) => item.type === "direct" && item.members.includes(master.name) && item.members.includes(payer.name));
    if (!chat) throw new Error("The payout actor chat is not available.");
    const sentAt = new Date().toISOString();
    const displayNumber = order.agentOrderNumbers?.[payer.name] || order.agentOrderNumber || order.brokerOrderNumber || order.id;
    chat.messages.push({
      id: nextMessageId(state),
      from: master.name,
      text: `${displayNumber}: Master is reminding you to pay this order.`,
      kind: "text",
      reactions: {},
      readBy: [master.name],
      createdAt: sentAt
    });
    order.lastReminderAt = sentAt;
    order.lastReminderBy = master.name;
  });
}

export async function createChatGroup(name: string, memberNames: string[]): Promise<WorkspaceState> {
  return updateWorkspaceState((state) => {
    const clean = name.trim();
    const master = activeActors(state).find((actor) => actor.role === "Master")?.name || "Master";
    if (!clean || !memberNames.length) throw new Error("Enter a group name and choose members.");
    state.chatConversations.push({ id: nextChatId(state), type: "group", name: clean, members: Array.from(new Set([master, ...memberNames])), messages: [], createdAt: new Date().toISOString() });
  });
}

export async function deleteChatGroup(chatId: string): Promise<WorkspaceState> {
  return updateWorkspaceState((state) => {
    const chat = state.chatConversations.find((item) => item.id === chatId);
    if (!chat || chat.type !== "group") return;
    state.deletedChatIds = Array.from(new Set([...(state.deletedChatIds || []), chatId]));
    state.chatConversations = state.chatConversations.filter((item) => item.id !== chatId);
  });
}

export function visibleChatsFor(session: UserSession, state: WorkspaceState): ChatConversationRecord[] {
  ensureDirectChats(state);
  return isMasterView(session) ? state.chatConversations : state.chatConversations.filter((chat) => chat.members.includes(session.actorName));
}

export function receivableBalance(receivable: ReceivableRecord): number {
  return Math.max(0, receivable.principalMinor - receivable.payments.reduce((sum, payment) => sum + Number(payment.amountMinor || 0), 0));
}
