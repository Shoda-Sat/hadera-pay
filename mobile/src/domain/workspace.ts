import { updateWorkspaceState } from "../api/client";
import type {
  ActorRecord,
  ChatConversationRecord,
  Currency,
  InternalTransferDraft,
  InternalTransferRecord,
  LedgerLine,
  OrderRecord,
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
  if (actorHasSpecialPayout(actor.role)) {
    return Array.from(new Set([actor.currency, ...(actor.workingCurrencies || [])]))
      .filter((currency): currency is Currency => supportedCurrencies.includes(currency as Currency));
  }
  return [actor.currency];
}

export function actorCanPayoutCurrency(actor: ActorRecord | undefined, currency: Currency): boolean {
  return Boolean(actor && actorCanReceivePayouts(actor.role) && actorTransferCurrencies(actor).includes(currency));
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

export async function returnOrder(orderId: string): Promise<WorkspaceState> {
  return updateWorkspaceState((state) => {
    const order = state.orders.find((item) => item.id === orderId);
    if (!order || order.state !== "Pending Forward") return;
    order.state = "Returned";
    order.returnedBy = "Master";
    order.returnedAt = new Date().toISOString();
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

export async function markOrderPaid(orderId: string, actorId: string, proof?: { dataUri: string; fileName: string }): Promise<WorkspaceState> {
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
    if (proof) order.paymentProof = { ...proof, attachedAt: postedAt };
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
    if (!order || order.state !== "Paid" || !order.journal || order.voidJournal) throw new Error("This order cannot request a void.");
    order.state = "Void Requested";
    order.voidRequested = true;
    order.voidRequestedBy = actorName;
    order.voidRequestedAt = new Date().toISOString();
    order.updatedAt = order.voidRequestedAt;
  });
}

export async function rejectOrderVoid(orderId: string, actorName: string): Promise<WorkspaceState> {
  return updateWorkspaceState((state) => {
    const order = state.orders.find((item) => item.id === orderId);
    if (!order || order.state !== "Void Requested") return;
    order.state = "Paid";
    order.voidRequested = false;
    order.voidRejectedBy = actorName;
    order.voidRejectedAt = new Date().toISOString();
    order.updatedAt = order.voidRejectedAt;
  });
}

export async function approveOrderVoid(orderId: string, actorName: string): Promise<WorkspaceState> {
  return updateWorkspaceState((state) => {
    const order = state.orders.find((item) => item.id === orderId);
    if (!order?.journal || order.state !== "Void Requested" || order.voidJournal) throw new Error("This void request is no longer available.");
    const paidLines = state.ledger.filter((line) => line.source === "ORDER_PAYMENT" && line.journal === order.journal);
    if (!paidLines.length) throw new Error("The payment journal could not be found.");
    const journal = nextJournalId(state);
    const postedAt = new Date().toISOString();
    state.ledger.unshift(...paidLines.map((line) => ({
      ...line,
      journal,
      source: "ORDER_VOID",
      direction: line.direction === "Debit" ? "Credit" as const : "Debit" as const,
      postedAt
    })));
    order.state = "Voided";
    order.voidJournal = journal;
    order.voidRequested = false;
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
    `Source: ${compactAmount(transfer.sourceCurrency, majorFromMinor(transfer.sourceAmountMinor, transfer.sourceCurrency))}`,
    `Payout: ${compactAmount(transfer.currency, majorFromMinor(transfer.amountMinor, transfer.currency))}`,
    `Rate: ${transfer.rate || 1}`,
    commission > 0 ? `Commission: ${compactAmount(transfer.sourceCurrency, majorFromMinor(commission, transfer.sourceCurrency))}` : "",
    transfer.remarks ? `Remarks: ${transfer.remarks}` : ""
  ].filter(Boolean).join(" - ");
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
    const sourceMajor = parseAmount(draft.sourceAmount);
    const rate = Number(draft.rate || 0);
    const payoutMajor = parseAmount(draft.payoutAmount) || sourceMajor * rate;
    const commissionPercent = Math.max(0, Number(draft.commissionPercent || 0));
    if (sourceMajor <= 0 || payoutMajor <= 0 || rate <= 0) throw new Error("Enter source amount, payout amount, and rate greater than zero.");
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
  });
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
  visibility?: ActorRecord["orderVisibilityPermissions"];
}): Promise<WorkspaceState> {
  return updateWorkspaceState((state) => {
    const actor = state.actors.find((item) => item.id === actorId);
    if (!actor || actor.role === "Master") throw new Error("Choose an actor.");
    if (typeof input.orderMultiCurrencyEnabled === "boolean") actor.orderMultiCurrencyEnabled = input.orderMultiCurrencyEnabled;
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
