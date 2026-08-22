import {
  resolveParticipantOrderForLedgerLine,
  retainOrdersForOpenParticipants,
} from "./orderParticipantRetention.mjs";
import { repairOrderJournalCollisions } from "./orderJournalCollisions.mjs";
import { removeExactDuplicateOrders } from "./exactDuplicateOrderCleanup.mjs";
import {
  galaxyLedgerOnlyOrderJournals,
  removeGalaxySpecifiedOpenOrders,
} from "./galaxyOrderCleanup.mjs";
import {
  applyApprovedOrderParticipantIdentityRepair,
  orderParticipantIdentityLinkFor,
  orderParticipantIdentityLinkMatches,
} from "./orderParticipantIdentity.mjs";

const supportedCurrencies = ["USD", "ETB", "EUR", "ERN", "SSP", "SDG", "LYD"];
const currencyDecimalPlaces = { USD: 2, ETB: 0, EUR: 2, ERN: 0, SSP: 2, SDG: 2, LYD: 3 };

const asArray = (value) => Array.isArray(value) ? value : [];
const cleanText = (value) => String(value ?? "").trim();

function cloneWorkspaceState(workspaceState) {
  if (!workspaceState || typeof workspaceState !== "object" || Array.isArray(workspaceState)) {
    throw new TypeError("workspaceState must be an object.");
  }
  if (typeof structuredClone === "function") return structuredClone(workspaceState);
  return JSON.parse(JSON.stringify(workspaceState));
}

function finiteStoredNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function activeActors(state) {
  return asArray(state.actors).filter((actor) => actor?.active !== false);
}

function actorForOrderParticipant(state, order, role) {
  const participantId = cleanText(role === "broker" ? order?.brokerActorId : order?.agentActorId);
  const participantName = cleanText(role === "broker" ? order?.broker : order?.agent);
  const actors = activeActors(state);
  if (participantId) {
    const direct = actors.find((actor) => cleanText(actor?.id) === participantId);
    if (direct) return direct;
    return actors.find((actor) => orderParticipantIdentityLinkMatches(state, order, actor, role)) || null;
  }
  return actors.find((actor) => cleanText(actor?.name) === participantName) || null;
}

function currencyFactor(currency) {
  return 10 ** (currencyDecimalPlaces[currency] ?? 0);
}

function majorAmount(amountMinor, currency = "USD") {
  return Number(amountMinor || 0) / currencyFactor(currency);
}

function minorFromMajor(amountMajor, currency = "USD") {
  return Math.round(Number(amountMajor || 0) * currencyFactor(currency));
}

function normalizedBuyingRates(state) {
  const settings = state?.buyingRates || { eurToUsdDivider: state?.eurToUsdDivider };
  return {
    eurToUsd: Number(settings.eurToUsd || settings.eurToUsdDivider) > 0
      ? Number(settings.eurToUsd || settings.eurToUsdDivider)
      : 1,
    usdToEtb: Number(settings.usdToEtb) > 0 ? Number(settings.usdToEtb) : 1,
    usdToErn: Number(settings.usdToErn) > 0 ? Number(settings.usdToErn) : 1,
    usdToSsp: Number(settings.usdToSsp) > 0 ? Number(settings.usdToSsp) : 1,
    usdToSdg: Number(settings.usdToSdg) > 0 ? Number(settings.usdToSdg) : 1,
    usdToLyd: Number(settings.usdToLyd) > 0 ? Number(settings.usdToLyd) : 1,
  };
}

function normalizedRateSetting(setting) {
  return {
    enabled: setting?.enabled === true,
    divider: Number(setting?.divider) > 0 ? Number(setting.divider) : 1,
    percent: Number(setting?.percent) > 0 ? Number(setting.percent) : 0,
  };
}

function buyingRateForPayout(state, currency) {
  const rates = normalizedBuyingRates(state);
  if (currency === "ETB") return rates.usdToEtb;
  if (currency === "ERN") return rates.usdToErn;
  if (currency === "SSP") return rates.usdToSsp;
  if (currency === "SDG") return rates.usdToSdg;
  if (currency === "LYD") return rates.usdToLyd;
  return 1;
}

function actorHasSpecialPayout(role) {
  return ["Special Agent", "Special Broker"].includes(role);
}

function usdAgentIncomeSettingFor(actor) {
  if (!actor || actor.role !== "Agent" || actor.currency !== "USD") return { divider: 1, percent: 0 };
  const setting = actor.incomeUsdPayoutSetting || {};
  return {
    divider: Number(setting.divider) > 0 ? Number(setting.divider) : 1,
    percent: Number(setting.percent) > 0 ? Number(setting.percent) : 0,
  };
}

function selectActor(state, actorId, actorName) {
  const requestedId = cleanText(actorId);
  const requestedName = cleanText(actorName);
  const actors = activeActors(state);
  if (requestedId) return actors.find((actor) => cleanText(actor?.id) === requestedId) || null;
  return actors.find((actor) => cleanText(actor?.name) === requestedName) || null;
}

function participantMatchesActor(state, order, actor, role) {
  const participantId = cleanText(role === "broker" ? order?.brokerActorId : order?.agentActorId);
  const participantName = cleanText(role === "broker" ? order?.broker : order?.agent);
  const actorId = cleanText(actor?.id);
  if (actorId && participantId) {
    return actorId === participantId
      || orderParticipantIdentityLinkMatches(state, order, actor, role);
  }
  return Boolean(cleanText(actor?.name) && cleanText(actor?.name) === participantName);
}

function archiveBelongsToActor(archive, actor) {
  const archiveActorId = cleanText(archive?.actorId);
  const actorId = cleanText(actor?.id);
  if (actorId && archiveActorId) return actorId === archiveActorId;
  return Boolean(cleanText(actor?.name) && cleanText(archive?.actor) === cleanText(actor?.name));
}

function orderIdentityValues(order) {
  return Array.from(new Set([
    order?.id,
    order?.internalOrderId,
    order?.collisionSourceOrderId,
    order?.journal,
  ].map(cleanText).filter(Boolean)));
}

function orderStableIdentityValues(order) {
  return Array.from(new Set([
    order?.id,
    order?.internalOrderId,
    order?.collisionSourceOrderId,
  ].map(cleanText).filter(Boolean)));
}

function ordersReferToSameRecord(left, right) {
  const leftIds = orderStableIdentityValues(left);
  const rightIds = new Set(orderStableIdentityValues(right));
  if (leftIds.length && rightIds.size) return leftIds.some((value) => rightIds.has(value));
  const leftJournal = cleanText(left?.journal);
  const rightJournal = cleanText(right?.journal);
  if (leftJournal && rightJournal) return leftJournal === rightJournal;
  return false;
}

function uniqueOrders(orders) {
  const unique = [];
  for (const order of orders) {
    if (!order || !orderIdentityValues(order).length) continue;
    if (!unique.some((candidate) => ordersReferToSameRecord(candidate, order))) unique.push(order);
  }
  return unique;
}

function orderForLedgerLine(state, line) {
  if (!line || !cleanText(line.source).startsWith("ORDER_")) return null;
  const liveOrders = asArray(state.orders);
  const archivedOrders = asArray(state.archives).flatMap((archive) => asArray(archive?.orders));
  if (cleanText(line.source) === "ORDER_PAYMENT") {
    const resolved = resolveParticipantOrderForLedgerLine(line, liveOrders, state.archives, state);
    return resolved.conflict ? null : resolved.order;
  }
  const allOrders = [...liveOrders, ...archivedOrders];
  const lineOrderId = cleanText(line.orderId);
  if (lineOrderId) {
    const exact = allOrders.find((order) => orderStableIdentityValues(order).includes(lineOrderId));
    if (exact) return exact;
    const evidenceJournal = cleanText(line.journal);
    if (!evidenceJournal) return null;
    const legacyMatches = allOrders.filter((order) =>
      !orderStableIdentityValues(order).length
      && (cleanText(order?.journal) === evidenceJournal || cleanText(order?.voidJournal) === evidenceJournal)
    );
    return legacyMatches.length === 1 ? legacyMatches[0] : null;
  }
  const evidenceJournal = cleanText(line.journal);
  if (!evidenceJournal) return null;
  const journalMatches = allOrders.filter((order) =>
    cleanText(order?.journal) === evidenceJournal || cleanText(order?.voidJournal) === evidenceJournal
  );
  return journalMatches.length === 1 ? journalMatches[0] : null;
}

function orderArchivedForActor(state, order, actor) {
  return asArray(state.archives).some((archive) =>
    archiveBelongsToActor(archive, actor)
    && asArray(archive?.orders).some((snapshot) => ordersReferToSameRecord(snapshot, order))
  );
}

function completedOrdersForActorClose(state, actor, actorLines) {
  const candidates = uniqueOrders([
    ...asArray(state.orders),
    ...actorLines
      .filter((line) => line?.source === "ORDER_PAYMENT")
      .map((line) => orderForLedgerLine(state, line))
      .filter(Boolean),
  ]);
  return candidates.filter((order) =>
    (order?.state === "Paid" || order?.state === "Voided")
    && (participantMatchesActor(state, order, actor, "broker") || participantMatchesActor(state, order, actor, "agent"))
    && !orderArchivedForActor(state, order, actor)
  );
}

function orderPaymentIssueForActorClose(state, actor, actorLines) {
  const liveOrders = asArray(state.orders);
  for (const line of actorLines) {
    if (line?.source !== "ORDER_PAYMENT") continue;
    if (line?.voided === true || line?.excludedFromCalculations === true) continue;
    const resolved = resolveParticipantOrderForLedgerLine(line, liveOrders, state.archives, state);
    if (resolved.conflict) return { line, reason: "conflicting archived records" };
    if (!resolved.order) return { line, reason: "no recoverable order record" };
    if (
      !participantMatchesActor(state, resolved.order, actor, "broker")
      && !participantMatchesActor(state, resolved.order, actor, "agent")
    ) {
      return { line, reason: "an Actor identity conflict" };
    }
  }
  return null;
}

function cancelledOrdersForActorClose(state, actor) {
  return uniqueOrders(asArray(state.orders).filter((order) =>
    order?.state === "Cancelled" && participantMatchesActor(state, order, actor, "broker")
  ));
}

function transferIdentity(transfer) {
  if (!transfer) return "";
  return String(transfer.recordKey || [
    "TRX",
    transfer.id || "",
    transfer.createdAt || transfer.sentAt || "",
    transfer.from || "",
    transfer.to || "",
    transfer.sourceCurrency || transfer.currency || "",
    transfer.sourceAmountMinor || transfer.amountMinor || 0,
  ].join(":"));
}

function transferArchivedForActor(transfer, actor) {
  return asArray(transfer?.archivedActorIds).includes(actor?.id)
    || asArray(transfer?.archivedActorNames).includes(actor?.name);
}

function transferCommissionPercent(transfer) {
  const percent = Number(transfer?.commissionPercent);
  return Number.isFinite(percent) && percent >= 0 ? percent : 0;
}

function transferCommissionMinor(transfer) {
  const stored = Number(transfer?.commissionMinor);
  if (Number.isFinite(stored) && stored >= 0) return Math.round(stored);
  return Math.round(Number(transfer?.sourceAmountMinor || transfer?.amountMinor || 0) * transferCommissionPercent(transfer) / 100);
}

function normalizedTransferCommissionLiability(value, commissionMinor = 0) {
  const clean = cleanText(value);
  if (["Sender", "Master", "Receiver"].includes(clean)) return clean;
  return Number(commissionMinor || 0) > 0 ? "Sender" : "";
}

function transferDetails(transfer) {
  if (cleanText(transfer?.details)) return cleanText(transfer.details);
  const parts = [
    `${transfer?.from || "Unknown"} -> ${transfer?.to || "Unknown"}`,
    transfer?.remarks ? `Remarks: ${transfer.remarks}` : "",
  ];
  return parts.filter(Boolean).join(" - ");
}

function archiveTransferSnapshot(transfer, actorName, closedAt) {
  const commissionMinor = transferCommissionMinor(transfer);
  return {
    id: transfer.id,
    recordKey: transferIdentity(transfer),
    masterTransactionCycle: Number(transfer.masterTransactionCycle || 0),
    actor: actorName,
    from: transfer.from,
    to: transfer.to,
    initiatedBy: transfer.initiatedBy || transfer.from || "",
    sourceCurrency: transfer.sourceCurrency || transfer.currency || "USD",
    sourceAmountMinor: Number(transfer.sourceAmountMinor || transfer.amountMinor || 0),
    currency: transfer.currency || transfer.sourceCurrency || "USD",
    amountMinor: Number(transfer.amountMinor || 0),
    rate: transfer.rate || "1",
    commissionPercent: transferCommissionPercent(transfer),
    commissionMinor,
    commissionLiability: normalizedTransferCommissionLiability(transfer.commissionLiability, commissionMinor),
    remarks: transfer.remarks || "",
    state: transfer.state,
    journal: transfer.journal || "",
    reversalJournal: transfer.reversalJournal || "",
    createdAt: transfer.createdAt || "",
    sentAt: transfer.sentAt || "",
    approvedAt: transfer.approvedAt || "",
    paidOutAt: transfer.paidOutAt || "",
    reversedAt: transfer.reversedAt || "",
    reversedBy: transfer.reversedBy || "",
    masterTransactionClosedAt: transfer.masterTransactionClosedAt || "",
    archivedAt: closedAt,
    details: transferDetails(transfer),
  };
}

function receivablePaidMinor(receivable) {
  return asArray(receivable?.payments).reduce((sum, payment) => sum + Number(payment?.amountMinor || 0), 0);
}

function receivableIsVoided(receivable) {
  return receivable?.voided === true || Boolean(receivable?.voidedAt);
}

function receivableIsCollectedForBalanceClose(receivable, actor) {
  const principalMinor = Number(receivable?.principalMinor || 0);
  return !receivable?.archivedAt
    && !receivableIsVoided(receivable)
    && (receivable?.borrower === actor?.name || receivable?.borrowerActorId === actor?.id)
    && principalMinor > 0
    && receivablePaidMinor(receivable) >= principalMinor;
}

function archiveReceivableSnapshot(receivable, actorName, archiveId, closedAt) {
  return {
    id: receivable.id,
    orderId: receivable.orderId || "",
    brokerOrderNumber: receivable.brokerOrderNumber || receivable.orderId || "",
    agentOrderNumber: receivable.agentOrderNumber || "",
    journal: receivable.journal || "",
    voidJournal: receivable.voidJournal || "",
    actor: actorName,
    borrower: receivable.borrower || actorName,
    borrowerActorId: receivable.borrowerActorId || "",
    currency: receivable.currency || "USD",
    principalMinor: Number(receivable.principalMinor || 0),
    senderName: receivable.senderName || "",
    receiverName: receivable.receiverName || "",
    receiverCity: receivable.receiverCity || "",
    accountNumber: receivable.accountNumber || "",
    phoneNumber: receivable.phoneNumber || "",
    remarks: receivable.remarks || "",
    creditReminder: receivable.creditReminder || "",
    createdAt: receivable.createdAt || "",
    updatedAt: closedAt,
    createdBy: receivable.createdBy || "",
    payments: asArray(receivable.payments).map((payment) => ({ ...payment })),
    archivedAt: closedAt,
    archiveId,
  };
}

function orderRecordIsVoided(order) {
  return order?.state === "Voided" || Boolean(order?.voidedAt || order?.voidJournal);
}

function normalizedOrderCommissionLiability(order = {}) {
  const percent = Number(order?.commissionPercent);
  const storedMinor = Number(order?.commissionMinor);
  if ((Number.isFinite(percent) && percent < 0) || (Number.isFinite(storedMinor) && storedMinor < 0)) return "Master";
  const explicit = cleanText(order?.orderCommissionLiability);
  return ["Broker", "Master"].includes(explicit) ? explicit : "Broker";
}

function payerStatementForArchive(state, order, actor) {
  if (!participantMatchesActor(state, order, actor, "agent")) return null;
  const payerLine = asArray(state.ledger).find((line) =>
    line?.source === "ORDER_PAYMENT"
    && line?.journal === order?.journal
    && line?.account === `${actor.name} ACTOR_CLEARING`
    && line?.direction === "Credit"
    && Number(line?.amountMinor || 0) > 0
  );
  if (payerLine) return { currency: payerLine.currency, amountMinor: Number(payerLine.amountMinor || 0) };
  const frozenAmount = finiteStoredNumber(order?.payerAmountMinor);
  if (frozenAmount !== null) {
    return { currency: order?.payerCurrency || order?.payoutCurrency || order?.sourceCurrency || "USD", amountMinor: frozenAmount };
  }
  return {
    currency: order?.payoutCurrency || order?.sourceCurrency || "USD",
    amountMinor: Number(order?.payoutAmountMinor || order?.sourceAmountMinor || 0),
  };
}

function archiveOrderSnapshot(state, order, actor, closedAt, forceExcluded = false) {
  const payerStatement = payerStatementForArchive(state, order, actor);
  const frozenProfit = finiteStoredNumber(order?.incomeProfitMinor);
  const linkedBrokerIdentity = orderParticipantIdentityLinkMatches(state, order, actor, "broker");
  const linkedAgentIdentity = orderParticipantIdentityLinkMatches(state, order, actor, "agent");
  return {
    id: order.id || order.internalOrderId,
    internalOrderId: order.internalOrderId || order.id,
    brokerOrderNumber: order.brokerOrderNumber || order.id || "",
    brokerOrderNumberCycle: Number(order.brokerOrderNumberCycle || 0),
    brokerActorId: linkedBrokerIdentity ? actor.id : order.brokerActorId || "",
    agentActorId: linkedAgentIdentity ? actor.id : order.agentActorId || "",
    agentOrderNumber: order.agentOrderNumbers?.[order.agent] || order.agentOrderNumber || "",
    agentOrderActor: order.agentOrderActor || order.agent || "",
    agentOrderNumbers: order.agentOrderNumbers && typeof order.agentOrderNumbers === "object" ? { ...order.agentOrderNumbers } : {},
    agentOrderNumberCycles: order.agentOrderNumberCycles && typeof order.agentOrderNumberCycles === "object" ? { ...order.agentOrderNumberCycles } : {},
    actor: actor.name,
    broker: linkedBrokerIdentity ? actor.name : order.broker,
    agent: linkedAgentIdentity ? actor.name : order.agent,
    senderName: order.senderName || "",
    receiverName: order.receiverName || "",
    receiverCity: order.receiverCity || "",
    accountNumber: order.accountNumber || "",
    phoneNumber: order.phoneNumber || "",
    remarks: order.remarks || "",
    sourceCurrency: order.sourceCurrency || "USD",
    sourceAmountMinor: Number(order.sourceAmountMinor || 0),
    payoutCurrency: order.payoutCurrency || order.sourceCurrency || "USD",
    payoutAmountMinor: Number(order.payoutAmountMinor || order.sourceAmountMinor || 0),
    rate: Number(order.rate || 0),
    commissionPercent: Number(order.commissionPercent || 0),
    commissionMinor: Number(order.commissionMinor || 0),
    orderCommissionLiability: normalizedOrderCommissionLiability(order),
    grossMinor: Number(order.grossMinor || 0),
    amount: order.amount || "",
    moneyUnitVersion: order.moneyUnitVersion,
    forwardedPayoutDivider: order.forwardedPayoutDivider,
    forwardedPayoutPercent: order.forwardedPayoutPercent,
    manualSpecialPayoutDivider: order.manualSpecialPayoutDivider,
    manualSpecialPayoutPercent: order.manualSpecialPayoutPercent,
    manualMasterRateDivider: order.manualMasterRateDivider,
    manualMasterRatePercent: order.manualMasterRatePercent,
    payerCurrency: payerStatement?.currency || "",
    payerAmountMinor: Number(payerStatement?.amountMinor || 0),
    incomeBaseCurrency: order.incomeBaseCurrency || "USD",
    incomeBaseAmountMinor: Number(order.incomeBaseAmountMinor || 0),
    incomeCollectedCurrency: order.incomeCollectedCurrency || order.sourceCurrency || "USD",
    incomeCollectedOriginalMinor: Number(order.incomeCollectedOriginalMinor || 0),
    incomeCollectedEurMinor: Number(order.incomeCollectedEurMinor || 0),
    incomeCollectedUsdMinor: Number(order.incomeCollectedUsdMinor || 0),
    incomeProfitMinor: frozenProfit === null ? undefined : frozenProfit,
    incomeSnapshotAt: order.incomeSnapshotAt || "",
    incomeMasterRateSnapshot: order.incomeMasterRateSnapshot ? { ...order.incomeMasterRateSnapshot } : undefined,
    incomeUsdAgentRateSnapshot: order.incomeUsdAgentRateSnapshot ? { ...order.incomeUsdAgentRateSnapshot } : undefined,
    state: order.state,
    fundingType: order.fundingType || "cash",
    journal: order.journal || "",
    journalCollisionBase: order.journalCollisionBase || "",
    voidJournal: order.voidJournal || "",
    excludedFromCalculations: forceExcluded || orderRecordIsVoided(order),
    locked: true,
    createdAt: order.createdAt || "",
    sentAt: order.sentAt || "",
    assignedAt: order.assignedAt || "",
    returnedAt: order.returnedAt || "",
    returnedBy: order.returnedBy || "",
    returnedReason: order.returnedReason || "",
    paidAt: order.paidAt || "",
    cancelledAt: order.cancelledAt || "",
    cancelledBy: order.cancelledBy || "",
    voidedAt: order.voidedAt || "",
    voidedBy: order.voidedBy || "",
    archivedAt: closedAt,
  };
}

function ledgerLineIsForVoidedOrder(state, line) {
  if (line?.voided === true || line?.excludedFromCalculations === true) return true;
  return orderRecordIsVoided(orderForLedgerLine(state, line));
}

function calculableLedgerLines(state, lines) {
  return asArray(lines).filter((line) => line?.archived !== true && !ledgerLineIsForVoidedOrder(state, line));
}

function archivedBalances(state, actorName, lines) {
  return calculableLedgerLines(state, lines).reduce((balances, line) => {
    if (line?.account !== actorName && line?.account !== `${actorName} ACTOR_CLEARING`) return balances;
    const sign = line?.direction === "Debit" ? 1 : -1;
    balances[line.currency] = (balances[line.currency] || 0) + sign * Number(line.amountMinor || 0);
    return balances;
  }, {});
}

function orderCommissionAmountMinor(order = {}) {
  const storedMinor = Number(order?.commissionMinor);
  if (Number.isFinite(storedMinor) && storedMinor !== 0) return Math.abs(Math.round(storedMinor));
  const sourceAmountMinor = Number(order?.sourceAmountMinor);
  const percent = Number(order?.commissionPercent);
  if (!Number.isFinite(sourceAmountMinor) || !Number.isFinite(percent)) return 0;
  return Math.abs(Math.round(sourceAmountMinor * percent / 100));
}

function signedOrderCommissionMinor(order = {}) {
  const amountMinor = orderCommissionAmountMinor(order);
  return normalizedOrderCommissionLiability(order) === "Master" ? -amountMinor : amountMinor;
}

function payerAgentPayoutMinorForOrder(order, journalLines, currency = "USD") {
  const agentAccount = `${order.agent} ACTOR_CLEARING`;
  const agentAmountMinor = journalLines
    .filter((line) => line?.currency === currency && line?.account === agentAccount && line?.direction === "Credit")
    .reduce((sum, line) => sum + Number(line?.amountMinor || 0), 0);
  if (agentAmountMinor > 0) return agentAmountMinor;
  return journalLines
    .filter((line) => line?.currency === currency && line?.account === "MASTER_FX_CLEARING" && line?.direction === "Debit")
    .reduce((sum, line) => sum + Number(line?.amountMinor || 0), 0);
}

function currencyAmountToUsdMinor(state, currency, amountMinor) {
  const amount = Number(amountMinor || 0);
  if (amount <= 0) return 0;
  const code = currency || "USD";
  if (code === "USD") return amount;
  const major = majorAmount(amount, code);
  const rates = normalizedBuyingRates(state);
  if (code === "EUR" && rates.eurToUsd > 0) return minorFromMajor(major * rates.eurToUsd, "USD");
  if (code === "ETB" && rates.usdToEtb > 0) return minorFromMajor(major / rates.usdToEtb, "USD");
  if (code === "ERN" && rates.usdToErn > 0) return minorFromMajor(major / rates.usdToErn, "USD");
  if (code === "SSP" && rates.usdToSsp > 0) return minorFromMajor(major / rates.usdToSsp, "USD");
  if (code === "SDG" && rates.usdToSdg > 0) return minorFromMajor(major / rates.usdToSdg, "USD");
  if (code === "LYD" && rates.usdToLyd > 0) return minorFromMajor(major / rates.usdToLyd, "USD");
  return 0;
}

function applyUsdAgentIncomeRate(amountMinor, setting) {
  const amount = Number(amountMinor || 0);
  if (amount <= 0) return 0;
  const divider = Number(setting?.divider) > 0 ? Number(setting.divider) : 1;
  const percent = Number(setting?.percent) > 0 ? Number(setting.percent) : 0;
  const dividedPayoutMajor = majorAmount(amount, "USD") / divider;
  return minorFromMajor(dividedPayoutMajor * (1 + percent / 100), "USD");
}

function usdPayoutActorIncomeBaseMinorForOrder(state, order, journalLines) {
  const payingActor = actorForOrderParticipant(state, order, "agent");
  const payoutCurrency = order.payoutCurrency || order.sourceCurrency || "USD";
  if (!payingActor || payingActor.role !== "Agent" || payingActor.currency !== "USD" || payoutCurrency !== "USD") return 0;
  const recordedUsdMinor = payerAgentPayoutMinorForOrder(order, journalLines, "USD")
    || Number(order.payoutAmountMinor || order.sourceAmountMinor || 0);
  return applyUsdAgentIncomeRate(recordedUsdMinor, usdAgentIncomeSettingFor(payingActor));
}

function specialPayoutBaseUsdMinorForOrder(state, order, journalLines) {
  const payingActor = actorForOrderParticipant(state, order, "agent");
  if (!actorHasSpecialPayout(payingActor?.role)) return 0;
  const agentAccount = `${order.agent} ACTOR_CLEARING`;
  const line = journalLines.find((item) =>
    item?.account === agentAccount
    && item?.direction === "Credit"
    && Number(item?.amountMinor || 0) > 0
  );
  return line ? currencyAmountToUsdMinor(state, line.currency, line.amountMinor) : 0;
}

function masterIncomeAmountForOrder(state, order, journalLines) {
  const baseCurrency = "USD";
  const payoutCurrency = order.payoutCurrency || order.sourceCurrency || baseCurrency;
  const payoutAmountMinor = Number(order.payoutAmountMinor || order.sourceAmountMinor || 0);
  const usdPayoutActorBaseMinor = usdPayoutActorIncomeBaseMinorForOrder(state, order, journalLines);
  if (usdPayoutActorBaseMinor > 0) return usdPayoutActorBaseMinor;
  const specialPayoutBaseUsdMinor = specialPayoutBaseUsdMinorForOrder(state, order, journalLines);
  if (specialPayoutBaseUsdMinor > 0) return specialPayoutBaseUsdMinor;
  if (payoutCurrency === baseCurrency) {
    return payerAgentPayoutMinorForOrder(order, journalLines, baseCurrency) || payoutAmountMinor;
  }
  const setting = normalizedRateSetting(state?.masterRateDivisorSettings?.[payoutCurrency]);
  if (setting.enabled) {
    const baseMajor = majorAmount(payoutAmountMinor, payoutCurrency) / setting.divider;
    return minorFromMajor(baseMajor * (1 + setting.percent / 100), baseCurrency);
  }
  const manualDivider = Number(order.manualMasterRateDivider || 0);
  const manualPercent = Number(order.manualMasterRatePercent || 0);
  if ((Number.isFinite(manualDivider) && manualDivider > 0) || (Number.isFinite(manualPercent) && manualPercent > 0)) {
    const divider = Number.isFinite(manualDivider) && manualDivider > 0 ? manualDivider : 1;
    const percent = Number.isFinite(manualPercent) && manualPercent > 0 ? manualPercent : 0;
    const baseMajor = majorAmount(payoutAmountMinor, payoutCurrency) / divider;
    return minorFromMajor(baseMajor * (1 + percent / 100), baseCurrency);
  }
  return journalLines
    .filter((line) => line?.currency === baseCurrency && line?.account === "MASTER_FX_CLEARING" && line?.direction === "Debit")
    .reduce((sum, line) => sum + Number(line?.amountMinor || 0), 0);
}

function masterCollectedAmountForOrder(state, order, journalLines = []) {
  const sourceCurrency = order.sourceCurrency || "USD";
  const payoutCurrency = order.payoutCurrency || sourceCurrency;
  const sourceAmountMinor = Number(order.sourceAmountMinor || 0);
  const commissionMinor = signedOrderCommissionMinor(order);
  const collectedMinor = sourceAmountMinor + commissionMinor;
  if (sourceCurrency === "USD") {
    return {
      collectedCurrency: "USD",
      collectedOriginalMinor: collectedMinor,
      collectedEurMinor: 0,
      collectedUsdMinor: collectedMinor,
    };
  }
  if (sourceCurrency === "EUR") {
    const brokerActor = actorForOrderParticipant(state, order, "broker");
    const brokerBaseCurrency = brokerActor?.currency || sourceCurrency;
    const rates = normalizedBuyingRates(state);
    const localRate = buyingRateForPayout(state, payoutCurrency);
    const collectedEurMajor = majorAmount(collectedMinor, "EUR");
    const collectedUsdMinor = minorFromMajor(collectedEurMajor * rates.eurToUsd, "USD");
    const ledgerPayoutMinor = payoutCurrency === "USD"
      ? payerAgentPayoutMinorForOrder(order, journalLines, "USD")
      : 0;
    const payoutMajor = majorAmount(ledgerPayoutMinor || Number(order.payoutAmountMinor || 0), payoutCurrency);
    let buyingProfitMinor = null;
    if (brokerBaseCurrency === "EUR" && ["ETB", "ERN", "SSP", "SDG", "LYD"].includes(payoutCurrency) && localRate > 0) {
      buyingProfitMinor = minorFromMajor(((collectedEurMajor * rates.eurToUsd * localRate) - payoutMajor) / localRate, "USD");
    }
    if (brokerBaseCurrency === "EUR" && payoutCurrency === "USD" && rates.usdToEtb > 0) {
      const payoutEtbMajor = payoutMajor * rates.usdToEtb;
      buyingProfitMinor = minorFromMajor(((collectedEurMajor * rates.eurToUsd * rates.usdToEtb) - payoutEtbMajor) / rates.usdToEtb, "USD");
    }
    return {
      collectedCurrency: "EUR",
      collectedOriginalMinor: collectedMinor,
      collectedEurMinor: collectedMinor,
      collectedUsdMinor,
      buyingProfitMinor,
    };
  }
  return {
    collectedCurrency: sourceCurrency,
    collectedOriginalMinor: collectedMinor,
    collectedEurMinor: 0,
    collectedUsdMinor: 0,
  };
}

function calculatedIncomeStatementForOrder(state, order, journalLines) {
  let baseAmountMinor = masterIncomeAmountForOrder(state, order, journalLines);
  const collected = masterCollectedAmountForOrder(state, order, journalLines);
  let profitMinor = Number.isFinite(Number(collected.buyingProfitMinor))
    ? Number(collected.buyingProfitMinor)
    : collected.collectedUsdMinor - baseAmountMinor;
  const usdPayoutActorBaseMinor = usdPayoutActorIncomeBaseMinorForOrder(state, order, journalLines);
  const specialPayoutBaseUsdMinor = specialPayoutBaseUsdMinorForOrder(state, order, journalLines);
  if (usdPayoutActorBaseMinor > 0) {
    baseAmountMinor = usdPayoutActorBaseMinor;
    profitMinor = collected.collectedUsdMinor - baseAmountMinor;
  } else if (specialPayoutBaseUsdMinor > 0) {
    baseAmountMinor = specialPayoutBaseUsdMinor;
    profitMinor = collected.collectedUsdMinor - baseAmountMinor;
  } else if (Number.isFinite(Number(collected.buyingProfitMinor))) {
    baseAmountMinor = collected.collectedUsdMinor - profitMinor;
  }
  return { baseAmountMinor, profitMinor };
}

export function deriveOrderIncomeSnapshot(state, order, journalLines = []) {
  const calculated = calculatedIncomeStatementForOrder(state, order, journalLines);
  const collected = masterCollectedAmountForOrder(state, order, journalLines);
  if (!Number.isFinite(calculated.baseAmountMinor) || !Number.isFinite(calculated.profitMinor)) {
    throw new RangeError(`Income profit could not be calculated safely for paid order ${cleanText(order?.id || order?.internalOrderId || order?.journal)}.`);
  }
  const payoutCurrency = order?.payoutCurrency || order?.sourceCurrency || "USD";
  const payingActor = actorForOrderParticipant(state, order, "agent");
  const snapshot = {
    incomeBaseCurrency: "USD",
    incomeBaseAmountMinor: calculated.baseAmountMinor,
    incomeCollectedCurrency: collected.collectedCurrency,
    incomeCollectedOriginalMinor: collected.collectedOriginalMinor,
    incomeCollectedEurMinor: collected.collectedEurMinor,
    incomeCollectedUsdMinor: collected.collectedUsdMinor,
    incomeProfitMinor: calculated.profitMinor,
    incomeSnapshotAt: order?.paidAt || new Date().toISOString(),
    incomeMasterRateSnapshot: {
      ...normalizedRateSetting(state?.masterRateDivisorSettings?.[payoutCurrency]),
      payoutCurrency,
    },
  };
  if (payoutCurrency === "USD" && payingActor?.role === "Agent" && payingActor?.currency === "USD") {
    const setting = usdAgentIncomeSettingFor(payingActor);
    snapshot.incomeUsdAgentRateSnapshot = {
      actorId: payingActor.id,
      actorName: payingActor.name,
      divider: setting.divider,
      percent: setting.percent,
    };
  }
  return snapshot;
}

function frozenIncomeProfitMinor(state, actorLines) {
  const journals = Array.from(new Set(actorLines
    .filter((line) => line?.source === "ORDER_PAYMENT")
    .map((line) => cleanText(line?.journal))
    .filter(Boolean)));
  return journals.reduce((sum, journal) => {
    const order = orderForLedgerLine(state, { source: "ORDER_PAYMENT", journal });
    if (!order || order.state !== "Paid" || orderRecordIsVoided(order)) return sum;
    const frozen = finiteStoredNumber(order.incomeProfitMinor);
    if (frozen !== null) return sum + frozen;
    const journalLines = asArray(state.ledger).filter((line) =>
      line?.source === "ORDER_PAYMENT" && cleanText(line?.journal) === journal
    );
    const calculatedProfit = calculatedIncomeStatementForOrder(state, order, journalLines).profitMinor;
    if (!Number.isFinite(calculatedProfit)) {
      throw new RangeError(`Income profit could not be calculated safely for paid order ${cleanText(order.id || order.internalOrderId) || journal}.`);
    }
    return sum + calculatedProfit;
  }, 0);
}

function archiveLedgerSnapshot(line, actorName, closedAt) {
  return {
    actor: actorName,
    journal: line.journal || "",
    entryId: line.entryId || "",
    actorLedgerNumber: line.actorLedgerNumber || "",
    transferId: line.transferId || "",
    transferRecordKey: line.transferRecordKey || "",
    orderId: line.orderId || "",
    source: line.source || "",
    account: line.account || "",
    direction: line.direction || "",
    currency: line.currency || "USD",
    amountMinor: Number(line.amountMinor || 0),
    masterTransactionCycle: Number(line.masterTransactionCycle || 0),
    masterTransactionClosedAt: line.masterTransactionClosedAt || "",
    postedAt: line.postedAt || "",
    details: line.details || "",
    archivedAt: closedAt,
  };
}

function archiveLedgerLineIsSmart(line) {
  if (!line || line.source === "PREVIOUS_CLOSE") return false;
  if (cleanText(line.source).startsWith("ORDER_")) return false;
  if (cleanText(line.source).startsWith("TRANSFER")) return false;
  return true;
}

function nextJournalNumberFromLedger(state) {
  return asArray(state.ledger).reduce((next, line) => {
    const match = cleanText(line?.journal).match(/^JRN-(\d+)(?:\s+\(\d+\))?(?:-|$)/);
    return match ? Math.max(next, Number(match[1]) - 999) : next;
  }, 1);
}

function nextJournalId(state) {
  state.journalCounter = Math.max(Number(state.journalCounter || 0), nextJournalNumberFromLedger(state) - 1) + 1;
  return `JRN-${1000 + state.journalCounter}`;
}

function syncSettlementsFromLedger(state) {
  const balances = {};
  for (const actor of activeActors(state)) {
    if (actor?.role !== "Master") balances[actor.name] = {};
  }
  for (const line of calculableLedgerLines(state, state.ledger)) {
    const actor = activeActors(state).find((candidate) =>
      line?.account === candidate?.name || line?.account === `${candidate?.name} ACTOR_CLEARING`
    );
    if (!actor || actor.role === "Master") continue;
    const sign = line.direction === "Debit" ? 1 : -1;
    balances[actor.name] ||= {};
    balances[actor.name][line.currency] = (balances[actor.name][line.currency] || 0) + sign * Number(line.amountMinor || 0);
  }
  state.settlements = [];
  for (const actor of activeActors(state)) {
    if (actor?.role === "Master") continue;
    for (const currency of supportedCurrencies) {
      const netMinor = balances[actor.name]?.[currency] || 0;
      if (netMinor !== 0 || currency === actor.currency) state.settlements.push({ actor: actor.name, currency, netMinor });
    }
  }
}

function closeResult(state, closed, actorName, archiveId, cancelledOrderCount, policy, error = "") {
  return {
    state,
    closed,
    actorName,
    archiveId,
    cancelledOrderCount,
    includedCancelledOrderCount: closed && policy === "include" ? cancelledOrderCount : 0,
    omittedCancelledOrderCount: closed && policy === "omit" ? cancelledOrderCount : 0,
    ...(error ? { error } : {}),
  };
}

export function closeActorBalance(workspaceState, options = {}) {
  const policy = cleanText(options.cancelledOrderPolicy);
  if (!new Set(["include", "omit"]).has(policy)) {
    throw new RangeError('cancelledOrderPolicy must be either "include" or "omit".');
  }
  const closedAt = cleanText(options.closedAt);
  const requestedArchiveId = cleanText(options.archiveId);
  if (!closedAt) throw new TypeError("closedAt is required.");
  if (!requestedArchiveId) throw new TypeError("archiveId is required.");

  const state = cloneWorkspaceState(workspaceState);
  const immutableClosedArchives = cloneWorkspaceState({ archives: asArray(state.archives) }).archives;
  removeExactDuplicateOrders(state, {
    preserveOrderJournals: galaxyLedgerOnlyOrderJournals(options.workspaceName),
  });
  repairOrderJournalCollisions(state);
  removeGalaxySpecifiedOpenOrders(state, options.workspaceName);
  state.archives = immutableClosedArchives;
  const actor = selectActor(state, options.actorId, options.actorName);
  const resultActorName = actor?.name || cleanText(options.actorName);
  if (!actor || actor.role === "Master") {
    return closeResult(state, false, resultActorName, requestedArchiveId, 0, policy);
  }
  const actorNameKey = cleanText(actor.name).toLocaleLowerCase();
  const activeActorsWithName = activeActors(state).filter((candidate) =>
    candidate?.role !== "Master"
    && cleanText(candidate?.name).toLocaleLowerCase() === actorNameKey
  );
  if (!actorNameKey || activeActorsWithName.length !== 1 || cleanText(activeActorsWithName[0]?.id) !== cleanText(actor.id)) {
    return closeResult(
      state,
      false,
      resultActorName,
      requestedArchiveId,
      0,
      policy,
      `Actor ${resultActorName || "identity"} is not uniquely identified. Resolve the Actor identity conflict before closing the balance.`
    );
  }
  applyApprovedOrderParticipantIdentityRepair(state, {
    workspaceName: options.workspaceName,
    workspaceId: options.workspaceId,
    actorId: actor.id,
    actorName: actor.name,
  });

  const cancelledOrders = cancelledOrdersForActorClose(state, actor);
  const unresolvedVoid = asArray(state.orders).find((order) =>
    order?.state === "Void Requested"
    && (participantMatchesActor(state, order, actor, "broker") || participantMatchesActor(state, order, actor, "agent"))
  );
  if (unresolvedVoid) {
    const orderNumber = cleanText(unresolvedVoid.brokerOrderNumber || unresolvedVoid.orderNumber || unresolvedVoid.id);
    return closeResult(
      state,
      false,
      actor.name,
      requestedArchiveId,
      cancelledOrders.length,
      policy,
      `${orderNumber ? `Order ${orderNumber}` : "An order"} has a pending void request. Approve or reject it before closing ${actor.name}'s balance.`
    );
  }

  const previousCloseDetails = `Previous Close for ${actor.name}`;
  const accountNamesActor = (line) =>
    line?.account === actor.name || line?.account === `${actor.name} ACTOR_CLEARING`;
  const approvedLegacyPaymentLineBelongsToActor = (line) => {
    if (line?.source !== "ORDER_PAYMENT" || !accountNamesActor(line) || !cleanText(line?.actorId)) return false;
    const resolved = resolveParticipantOrderForLedgerLine(line, state.orders, state.archives, state);
    if (resolved.conflict || !resolved.order) return false;
    return ["broker", "agent"].some((role) => {
      const link = orderParticipantIdentityLinkFor(state, resolved.order, actor, role);
      return Boolean(link && cleanText(link.legacyActorId) === cleanText(line.actorId));
    });
  };
  const mismatchedPaymentLine = asArray(state.ledger).find((line) =>
    line?.archived !== true
    && line?.source === "ORDER_PAYMENT"
    && accountNamesActor(line)
    && cleanText(line?.actorId)
    && cleanText(line.actorId) !== cleanText(actor.id)
    && !approvedLegacyPaymentLineBelongsToActor(line)
  );
  if (mismatchedPaymentLine) {
    const journal = cleanText(mismatchedPaymentLine.journal);
    return closeResult(
      state,
      false,
      actor.name,
      requestedArchiveId,
      cancelledOrders.length,
      policy,
      `${journal ? `Order journal ${journal}` : "An order payment"} has an Actor identity conflict. Review it before closing ${actor.name}'s balance.`
    );
  }
  const closesWithActor = (line) => {
    if (line?.source === "ORDER_PAYMENT" && cleanText(line?.actorId)) {
      return accountNamesActor(line) && (
        cleanText(line.actorId) === cleanText(actor.id)
        || approvedLegacyPaymentLineBelongsToActor(line)
      );
    }
    return accountNamesActor(line)
      || (line?.source === "PREVIOUS_CLOSE" && line?.account === "MASTER_PREVIOUS_CLOSE" && line?.details === previousCloseDetails);
  };
  const actorLines = asArray(state.ledger).filter((line) => line?.archived !== true && closesWithActor(line));
  const closingLedgerLines = new Set(actorLines);
  const openTransactionLines = actorLines.filter((line) => line?.source !== "PREVIOUS_CLOSE");
  const orderPaymentIssue = orderPaymentIssueForActorClose(state, actor, actorLines);
  if (orderPaymentIssue) {
    const journal = cleanText(orderPaymentIssue.line?.journal);
    return closeResult(
      state,
      false,
      actor.name,
      requestedArchiveId,
      cancelledOrders.length,
      policy,
      `${journal ? `Order journal ${journal}` : "An order payment"} has ${orderPaymentIssue.reason}. Review it before closing ${actor.name}'s balance.`
    );
  }
  const archivedOrders = completedOrdersForActorClose(state, actor, actorLines);
  const archivedTransfers = asArray(state.transfers).filter((transfer) =>
    ["Approved", "Reversed"].includes(transfer?.state)
    && (transfer?.from === actor.name || transfer?.to === actor.name)
    && !transferArchivedForActor(transfer, actor)
  );
  const collectedReceivables = asArray(state.receivables).filter((receivable) =>
    receivableIsCollectedForBalanceClose(receivable, actor)
  );
  const hasCloseActivity = openTransactionLines.length
    || archivedOrders.length
    || archivedTransfers.length
    || collectedReceivables.length
    || cancelledOrders.length;
  if (!hasCloseActivity) {
    return closeResult(state, false, actor.name, requestedArchiveId, 0, policy);
  }

  state.orders = asArray(state.orders);
  state.archives = asArray(state.archives);
  state.ledger = asArray(state.ledger);
  state.transfers = asArray(state.transfers);
  state.receivables = asArray(state.receivables);

  const previousBalances = archivedBalances(state, actor.name, actorLines);
  const incomeProfitMinor = frozenIncomeProfitMinor(state, actorLines);
  const archivedOrderSnapshots = archivedOrders.map((order) => archiveOrderSnapshot(state, order, actor, closedAt));
  const includedCancelledSnapshots = policy === "include"
    ? cancelledOrders.map((order) => archiveOrderSnapshot(state, order, actor, closedAt, true))
    : [];
  const archivedTransferSnapshots = archivedTransfers.map((transfer) => archiveTransferSnapshot(transfer, actor.name, closedAt));
  const archivedReceivableSnapshots = collectedReceivables.map((receivable) =>
    archiveReceivableSnapshot(receivable, actor.name, requestedArchiveId, closedAt)
  );
  const archivedLedgerSnapshots = openTransactionLines
    .filter(archiveLedgerLineIsSmart)
    .map((line) => archiveLedgerSnapshot(line, actor.name, closedAt));

  state.archives.unshift({
    id: requestedArchiveId,
    actor: actor.name,
    actorId: actor.id,
    actorRole: actor.role,
    actorCurrency: actor.currency || "USD",
    closedAt,
    balances: previousBalances,
    incomeProfitMinor,
    incomeProfitCurrency: "USD",
    incomeSummary: `Closed Profit/Loss for ${actor.name}`,
    ledger: archivedLedgerSnapshots,
    orders: [...archivedOrderSnapshots, ...includedCancelledSnapshots],
    receivables: archivedReceivableSnapshots,
    transfers: archivedTransferSnapshots,
  });

  state.ledger = state.ledger.map((line) =>
    closingLedgerLines.has(line) && line?.archived !== true ? { ...line, archived: true, closedAt } : line
  );

  const tombstones = new Set(asArray(state.deletedOrderIds).map(cleanText).filter(Boolean));
  cancelledOrders.forEach((order) => {
    const orderId = cleanText(order?.id || order?.internalOrderId);
    if (orderId) tombstones.add(orderId);
  });
  state.deletedOrderIds = Array.from(tombstones);
  const cancelledRecords = new Set(cancelledOrders);
  state.orders = retainOrdersForOpenParticipants({
    ...state,
    orders: state.orders.filter((order) => !cancelledRecords.has(order)),
  }).orders;

  const archivedTransferIds = new Set(archivedTransfers.map(transferIdentity));
  state.transfers = state.transfers.map((transfer) => {
    if (!archivedTransferIds.has(transferIdentity(transfer))) return transfer;
    return {
      ...transfer,
      archivedAt: transfer.archivedAt || closedAt,
      archivedActorIds: Array.from(new Set([...asArray(transfer.archivedActorIds), actor.id])),
      archivedActorNames: Array.from(new Set([...asArray(transfer.archivedActorNames), actor.name])),
      archiveIdsByActor: { ...(transfer.archiveIdsByActor || {}), [actor.id]: requestedArchiveId },
      updatedAt: closedAt,
    };
  });

  const collectedReceivableIds = new Set(collectedReceivables.map((receivable) => receivable?.id));
  state.receivables = state.receivables.map((receivable) =>
    collectedReceivableIds.has(receivable?.id)
      ? { ...receivable, archivedAt: closedAt, archiveId: requestedArchiveId, updatedAt: closedAt }
      : receivable
  );

  const openingLines = supportedCurrencies
    .filter((currency) => (previousBalances[currency] || 0) !== 0)
    .flatMap((currency) => {
      const netMinor = previousBalances[currency];
      const amountMinor = Math.abs(netMinor);
      const actorDirection = netMinor > 0 ? "Debit" : "Credit";
      const offsetDirection = actorDirection === "Debit" ? "Credit" : "Debit";
      const journal = nextJournalId(state);
      return [
        {
          journal,
          source: "PREVIOUS_CLOSE",
          account: `${actor.name} ACTOR_CLEARING`,
          direction: actorDirection,
          currency,
          amountMinor,
          postedAt: closedAt,
          details: previousCloseDetails,
        },
        {
          journal,
          source: "PREVIOUS_CLOSE",
          account: "MASTER_PREVIOUS_CLOSE",
          direction: offsetDirection,
          currency,
          amountMinor,
          postedAt: closedAt,
          details: previousCloseDetails,
        },
      ];
    });
  if (openingLines.length) state.ledger.unshift(...openingLines);

  actor.numberingCycle = Math.max(0, Math.floor(Number(actor.numberingCycle || 0))) + 1;
  if (actorLines.length || openingLines.length) syncSettlementsFromLedger(state);

  return closeResult(state, true, actor.name, requestedArchiveId, cancelledOrders.length, policy);
}
