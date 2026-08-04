const currencies = new Set(["USD", "ETB", "EUR", "ERN", "SSP", "SDG", "LYD"]);
const currencyDecimals = { USD: 2, ETB: 0, EUR: 2, ERN: 0, SSP: 2, SDG: 2, LYD: 3 };
const brokerRoles = new Set(["Broker", "Special Broker"]);
const payoutRoles = new Set(["Agent", "Special Agent"]);
const specialPayoutRoles = new Set(["Special Agent", "Special Broker"]);
const commissionLiabilities = new Set(["Sender", "Master", "Receiver"]);
const maximumMinorAmount = Number.MAX_SAFE_INTEGER;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizedForComparison(value) {
  if (Array.isArray(value)) return value.map(normalizedForComparison);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizedForComparison(value[key])]));
}

function equal(left, right) {
  return JSON.stringify(normalizedForComparison(left)) === JSON.stringify(normalizedForComparison(right));
}

function deny(reason) {
  const error = new Error("This change is not permitted for your account. Refresh HaderaPay and use the available action controls.");
  error.statusCode = 403;
  error.securityReason = reason;
  throw error;
}

function cleanText(value, maximum = 500) {
  return String(value || "").trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, maximum);
}

function positiveMinor(value, label) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > maximumMinorAmount) deny(`Invalid ${label}.`);
  return amount;
}

function nonNegativeMinor(value, label) {
  const amount = Number(value || 0);
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > maximumMinorAmount) deny(`Invalid ${label}.`);
  return amount;
}

function positiveRate(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1_000_000_000) deny("Invalid exchange rate.");
  return rate;
}

function commissionPercent(value) {
  const percent = Number(value || 0);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) deny("Invalid commission percentage.");
  return percent;
}

function safeCurrency(value, label = "currency") {
  const currency = String(value || "");
  if (!currencies.has(currency)) deny(`Invalid ${label}.`);
  return currency;
}

function factor(currency) {
  return 10 ** (currencyDecimals[currency] ?? 2);
}

function majorFromMinor(value, currency) {
  return Number(value || 0) / factor(currency);
}

function minorFromMajor(value, currency) {
  return Math.round(Number(value || 0) * factor(currency));
}

function actorForSession(state, session) {
  return (state.actors || []).find((actor) => actor.id === session?.membership?.actorId)
    || (state.actors || []).find((actor) => actor.name === session?.membership?.actorName);
}

function masterActor(state) {
  return (state.actors || []).find((actor) => actor.role === "Master");
}

function recordTime(record = {}) {
  return Math.max(...[
    "voidRequestedAt", "voidRejectedAt", "voidedAt", "archivedAt", "updatedAt", "reversedAt",
    "paidAt", "assignedAt", "approvedAt", "paidOutAt", "rejectedAt", "returnedAt", "cancelledAt",
    "sentAt", "createdAt",
  ].map((key) => new Date(record[key] || 0).getTime() || 0));
}

function actorMatchesOrder(order, actor) {
  return Boolean(order && actor && (
    order.brokerActorId === actor.id || order.agentActorId === actor.id ||
    order.broker === actor.name || order.agent === actor.name
  ));
}

function actorMatchesTransfer(transfer, actor) {
  return Boolean(transfer && actor && (
    transfer.fromActorId === actor.id || transfer.toActorId === actor.id || transfer.requestedToActorId === actor.id ||
    transfer.from === actor.name || transfer.to === actor.name || transfer.requestedTo === actor.name || transfer.initiatedBy === actor.name
  ));
}

function ledgerAccountBelongsToActor(account, actorName) {
  return String(account || "") === actorName || String(account || "") === `${actorName} ACTOR_CLEARING`;
}

function visibleArchive(archive, actor) {
  return archive?.actorId === actor.id || archive?.actor === actor.name;
}

export function projectWorkspaceStateForSession(state, session) {
  if (!state || session?.membership?.role !== "Actor") return state;
  const actor = actorForSession(state, session);
  if (!actor) return { actors: [], orders: [], receivables: [], savedCustomers: [], transfers: [], ledger: [], archives: [], settlements: [], chatConversations: [] };

  const orders = (state.orders || []).filter((order) => actorMatchesOrder(order, actor));
  const orderIds = new Set(orders.map((order) => order.id));
  const transfers = (state.transfers || []).filter((transfer) => actorMatchesTransfer(transfer, actor));
  const transferIds = new Set(transfers.map((transfer) => transfer.id));
  const master = masterActor(state);
  const routingBrokerNames = new Set(orders
    .filter((order) => order.agentActorId === actor.id || order.agent === actor.name)
    .map((order) => order.broker));

  const chatConversations = (state.chatConversations || []).flatMap((chat) => {
    if ((chat.members || []).includes(actor.name)) return [chat];
    const isRoutingChat = chat.type === "direct" && master && (chat.members || []).includes(master.name) &&
      Array.from(routingBrokerNames).some((brokerName) => (chat.members || []).includes(brokerName));
    return isRoutingChat ? [{ ...chat, messages: [] }] : [];
  });

  return {
    actors: clone(state.actors || []),
    orders: clone(orders),
    receivables: clone((state.receivables || []).filter((record) =>
      record.borrowerActorId === actor.id || record.borrower === actor.name || orderIds.has(record.orderId)
    )),
    savedCustomers: clone((state.savedCustomers || []).filter((record) => record.actorId === actor.id)),
    transfers: clone(transfers),
    ledger: clone((state.ledger || []).filter((line) =>
      ledgerAccountBelongsToActor(line.account, actor.name) || orderIds.has(line.orderId) || transferIds.has(line.transferId)
    )),
    masterBankEntries: [],
    archives: clone((state.archives || []).filter((archive) => visibleArchive(archive, actor))),
    settlements: clone((state.settlements || []).filter((record) => record.actor === actor.name)),
    chatConversations: clone(chatConversations),
    buyingRates: clone(state.buyingRates || {}),
    masterRateDivisorSettings: clone(state.masterRateDivisorSettings || {}),
    orderCounter: Number(state.orderCounter || 0),
    receivableCounter: Number(state.receivableCounter || 0),
    customerCounter: Number(state.customerCounter || 0),
    transferCounter: Number(state.transferCounter || 0),
    journalCounter: Number(state.journalCounter || 0),
    chatCounter: Number(state.chatCounter || 0),
    messageCounter: Number(state.messageCounter || 0),
    masterTransactionCycle: Number(state.masterTransactionCycle || 0),
    transferRecordCounter: Number(state.transferRecordCounter || 0),
    manualJournalCounter: Number(state.manualJournalCounter || 0),
    withdrawalCounter: Number(state.withdrawalCounter || 0),
  };
}

function nextNumericId(items, expression, prefix, counterValue = 0) {
  const highest = (items || []).reduce((value, item) => {
    const match = String(item?.id || "").match(expression);
    return match ? Math.max(value, Number(match[1])) : value;
  }, 0);
  return `${prefix}${Math.max(highest, Number(counterValue || 0)) + 1}`;
}

function nextJournalId(state) {
  const highest = (state.ledger || []).reduce((value, line) => {
    const match = String(line?.journal || "").match(/^JRN-(\d+)$/);
    return match ? Math.max(value, Number(match[1]) - 1000) : value;
  }, 0);
  state.journalCounter = Math.max(Number(state.journalCounter || 0), highest) + 1;
  return `JRN-${1000 + state.journalCounter}`;
}

function activeFile(files, session, attachmentId, contextId, purposes) {
  const file = (files || []).find((item) => item.id === attachmentId && item.workspaceId === session.workspace.id && item.status === "active");
  if (!file || file.contextId !== contextId || !purposes.includes(file.purpose)) deny("Invalid or unauthorized attachment.");
  return file;
}

function paymentProof(files, session, candidate, orderId) {
  if (!candidate) return undefined;
  if (!candidate.attachmentId) deny("Payment photos must finish uploading before the order is paid.");
  const file = activeFile(files, session, candidate.attachmentId, orderId, ["payment-proof", "order-photo"]);
  return {
    attachmentId: file.id,
    size: file.size,
    fileName: file.fileName,
    attachedAt: new Date().toISOString(),
    mediaType: "image",
    mimeType: file.mimeType,
    orderNumber: cleanText(candidate.orderNumber, 100),
    compressed: candidate.compressed === true,
  };
}

function orderDetails(order) {
  return [
    `Order: ${order.brokerOrderNumber || order.id}`,
    order.senderName ? `Sender: ${order.senderName}` : "",
    order.receiverName ? `Receiver: ${order.receiverName}` : "",
    order.receiverCity ? `Receiver City: ${order.receiverCity}` : "",
    order.accountNumber ? `Account: ${order.accountNumber}` : "",
    order.phoneNumber ? `Phone: ${order.phoneNumber}` : "",
    order.remarks ? `Remarks: ${order.remarks}` : "",
  ].filter(Boolean).join(" - ");
}

function rateSetting(value) {
  return {
    enabled: value?.enabled === true,
    divider: Number(value?.divider) > 0 ? Number(value.divider) : 1,
    percent: Number(value?.percent) > 0 ? Number(value.percent) : 0,
  };
}

function payingActorStatement(state, order) {
  const actor = (state.actors || []).find((candidate) => candidate.name === order.agent);
  const payoutCurrency = order.payoutCurrency || order.sourceCurrency;
  const payoutAmountMinor = Number(order.payoutAmountMinor || order.sourceAmountMinor || 0);
  const forwardedDivider = Number(order.forwardedPayoutDivider || 0);
  const forwardedPercent = Number(order.forwardedPayoutPercent || 0);
  const hasForwardedDivider = forwardedDivider > 0;
  const hasForwardedPercent = forwardedPercent >= 0 && Object.prototype.hasOwnProperty.call(order, "forwardedPayoutPercent");
  const applyTerms = (amountMinor, currency) => {
    let major = majorFromMinor(amountMinor, currency);
    if (hasForwardedDivider) major /= forwardedDivider;
    if (hasForwardedPercent) major *= 1 + forwardedPercent / 100;
    return minorFromMajor(major, currency);
  };
  if (!actor || !specialPayoutRoles.has(actor.role)) {
    return { currency: payoutCurrency, amountMinor: hasForwardedDivider || hasForwardedPercent ? applyTerms(payoutAmountMinor, payoutCurrency) : payoutAmountMinor };
  }
  const baseCurrency = actor.currency;
  const special = rateSetting(actor.specialPayoutSettings?.[payoutCurrency]);
  const finish = (baseMajor, fallbackPercent) => ({
    currency: baseCurrency,
    amountMinor: minorFromMajor(baseMajor * (1 + (hasForwardedPercent ? forwardedPercent : fallbackPercent) / 100), baseCurrency),
  });
  if (hasForwardedDivider) return finish(majorFromMinor(payoutAmountMinor, payoutCurrency) / forwardedDivider, 0);
  if (special.enabled) return finish(majorFromMinor(payoutAmountMinor, payoutCurrency) / special.divider, special.percent);
  const manualDivider = Number(order.manualSpecialPayoutDivider || 0);
  const manualPercent = Number(order.manualSpecialPayoutPercent || 0);
  if (manualDivider > 0 || manualPercent > 0) return finish(majorFromMinor(payoutAmountMinor, payoutCurrency) / (manualDivider > 0 ? manualDivider : 1), manualPercent);
  if (baseCurrency === payoutCurrency) return { currency: baseCurrency, amountMinor: applyTerms(payoutAmountMinor, baseCurrency) };
  if (baseCurrency === order.sourceCurrency) return { currency: baseCurrency, amountMinor: applyTerms(Number(order.sourceAmountMinor || 0), baseCurrency) };
  return { currency: baseCurrency, amountMinor: applyTerms(minorFromMajor(majorFromMinor(payoutAmountMinor, payoutCurrency) / (Number(order.rate || 1) || 1), baseCurrency), baseCurrency) };
}

function buyingRates(state) {
  return {
    eurToUsd: Number(state.buyingRates?.eurToUsd) > 0 ? Number(state.buyingRates.eurToUsd) : 1,
    usdToEtb: Number(state.buyingRates?.usdToEtb) > 0 ? Number(state.buyingRates.usdToEtb) : 1,
    usdToErn: Number(state.buyingRates?.usdToErn) > 0 ? Number(state.buyingRates.usdToErn) : 1,
    usdToSsp: Number(state.buyingRates?.usdToSsp) > 0 ? Number(state.buyingRates.usdToSsp) : 1,
    usdToSdg: Number(state.buyingRates?.usdToSdg) > 0 ? Number(state.buyingRates.usdToSdg) : 1,
    usdToLyd: Number(state.buyingRates?.usdToLyd) > 0 ? Number(state.buyingRates.usdToLyd) : 1,
  };
}

function usdToLocalRate(rates, currency) {
  return ({ ETB: rates.usdToEtb, ERN: rates.usdToErn, SSP: rates.usdToSsp, SDG: rates.usdToSdg, LYD: rates.usdToLyd })[currency] || 0;
}

function currencyToUsd(state, currency, amountMinor) {
  if (currency === "USD") return amountMinor;
  const major = majorFromMinor(amountMinor, currency);
  const rates = buyingRates(state);
  if (currency === "EUR") return minorFromMajor(major * rates.eurToUsd, "USD");
  const localRate = usdToLocalRate(rates, currency);
  return localRate > 0 ? minorFromMajor(major / localRate, "USD") : 0;
}

function applyOrderIncomeSnapshot(state, order, lines) {
  const sourceCurrency = order.sourceCurrency;
  const payoutCurrency = order.payoutCurrency;
  const collectedMinor = Number(order.sourceAmountMinor || 0) + Number(order.commissionMinor || 0);
  const rates = buyingRates(state);
  const payerLine = lines.find((line) => line.account === `${order.agent} ACTOR_CLEARING` && line.direction === "Credit");
  const payingActor = (state.actors || []).find((actor) => actor.name === order.agent);
  const usdPayerLine = lines.find((line) => line.account === `${order.agent} ACTOR_CLEARING` && line.direction === "Credit" && line.currency === "USD");
  const usdSetting = rateSetting(payingActor?.incomeUsdPayoutSetting);
  const usdPayoutActorBaseMinor = payoutCurrency === "USD" && payingActor?.role === "Agent" && payingActor.currency === "USD"
    ? minorFromMajor(majorFromMinor(usdPayerLine?.amountMinor || Number(order.payoutAmountMinor || 0), "USD") / usdSetting.divider * (1 + usdSetting.percent / 100), "USD")
    : 0;
  let baseAmountMinor = 0;
  if (usdPayoutActorBaseMinor > 0) baseAmountMinor = usdPayoutActorBaseMinor;
  else if (payingActor && specialPayoutRoles.has(payingActor.role) && payerLine) baseAmountMinor = currencyToUsd(state, payerLine.currency, payerLine.amountMinor);
  else if (payoutCurrency === "USD") baseAmountMinor = payerLine?.currency === "USD" ? payerLine.amountMinor : Number(order.payoutAmountMinor || 0);
  else {
    const masterRate = rateSetting(state.masterRateDivisorSettings?.[payoutCurrency]);
    const manualDivider = Number(order.manualMasterRateDivider || 0);
    const manualPercent = Number(order.manualMasterRatePercent || 0);
    const divider = masterRate.enabled ? masterRate.divider : manualDivider > 0 ? manualDivider : manualPercent > 0 ? 1 : 0;
    const percent = masterRate.enabled ? masterRate.percent : manualPercent > 0 ? manualPercent : 0;
    if (divider > 0) baseAmountMinor = minorFromMajor(majorFromMinor(order.payoutAmountMinor, payoutCurrency) / divider * (1 + percent / 100), "USD");
    else if (payerLine) baseAmountMinor = currencyToUsd(state, payerLine.currency, payerLine.amountMinor);
  }
  const collectedUsdMinor = sourceCurrency === "USD" ? collectedMinor : sourceCurrency === "EUR"
    ? minorFromMajor(majorFromMinor(collectedMinor, "EUR") * rates.eurToUsd, "USD")
    : sourceCurrency === "LYD" ? currencyToUsd(state, sourceCurrency, collectedMinor) : 0;
  let profitMinor = collectedUsdMinor - baseAmountMinor;
  const broker = (state.actors || []).find((actor) => actor.name === order.broker);
  if (sourceCurrency === "EUR" && broker?.currency === "EUR") {
    const collectedEur = majorFromMinor(collectedMinor, "EUR");
    const payoutMajor = majorFromMinor(order.payoutAmountMinor, payoutCurrency);
    const localRate = payoutCurrency === "USD" ? rates.usdToEtb : usdToLocalRate(rates, payoutCurrency);
    if (["ETB", "ERN", "SSP", "SDG", "LYD", "USD"].includes(payoutCurrency) && localRate > 0) {
      const payoutLocal = payoutCurrency === "USD" ? payoutMajor * rates.usdToEtb : payoutMajor;
      profitMinor = minorFromMajor(((collectedEur * rates.eurToUsd * localRate) - payoutLocal) / localRate, "USD");
      if (!usdPayoutActorBaseMinor && !(payingActor && specialPayoutRoles.has(payingActor.role))) baseAmountMinor = collectedUsdMinor - profitMinor;
    }
  }
  if ((usdPayoutActorBaseMinor > 0 || (payingActor && specialPayoutRoles.has(payingActor.role))) && baseAmountMinor > 0) profitMinor = collectedUsdMinor - baseAmountMinor;
  order.incomeBaseCurrency = "USD";
  order.incomeBaseAmountMinor = baseAmountMinor;
  order.incomeCollectedCurrency = sourceCurrency;
  order.incomeCollectedOriginalMinor = collectedMinor;
  order.incomeCollectedEurMinor = sourceCurrency === "EUR" ? collectedMinor : 0;
  order.incomeCollectedUsdMinor = collectedUsdMinor;
  order.incomeProfitMinor = profitMinor;
  order.incomeSnapshotAt = order.paidAt;
  order.incomeMasterRateSnapshot = { ...rateSetting(state.masterRateDivisorSettings?.[payoutCurrency]), payoutCurrency };
  if (payoutCurrency === "USD" && payingActor?.role === "Agent" && payingActor.currency === "USD") {
    order.incomeUsdAgentRateSnapshot = { actorId: payingActor.id, actorName: payingActor.name, divider: usdSetting.divider, percent: usdSetting.percent };
  }
}

function postOrderPayment(state, order) {
  const journal = nextJournalId(state);
  const postedAt = new Date().toISOString();
  const payer = payingActorStatement(state, order);
  if (!Number.isSafeInteger(payer.amountMinor) || payer.amountMinor <= 0) deny("Invalid calculated payout amount.");
  const details = orderDetails(order);
  const lines = [
    { journal, orderId: order.id, source: "ORDER_PAYMENT", account: `${order.broker} ACTOR_CLEARING`, direction: "Debit", currency: order.sourceCurrency, amountMinor: Number(order.sourceAmountMinor), details, postedAt },
    { journal, orderId: order.id, source: "ORDER_PAYMENT", account: `${order.broker} ACTOR_CLEARING`, direction: "Debit", currency: order.sourceCurrency, amountMinor: Number(order.commissionMinor || 0), details, postedAt },
    { journal, orderId: order.id, source: "ORDER_PAYMENT", account: "MASTER_FX_CLEARING", direction: "Credit", currency: order.sourceCurrency, amountMinor: Number(order.sourceAmountMinor), details, postedAt },
    { journal, orderId: order.id, source: "ORDER_PAYMENT", account: "MASTER_FEE_REVENUE", direction: "Credit", currency: order.sourceCurrency, amountMinor: Number(order.commissionMinor || 0), details, postedAt },
    { journal, orderId: order.id, source: "ORDER_PAYMENT", account: "MASTER_FX_CLEARING", direction: "Debit", currency: payer.currency, amountMinor: payer.amountMinor, details, postedAt },
    { journal, orderId: order.id, source: "ORDER_PAYMENT", account: `${order.agent} ACTOR_CLEARING`, direction: "Credit", currency: payer.currency, amountMinor: payer.amountMinor, details, postedAt },
  ].filter((line) => line.amountMinor > 0);
  order.journal = journal;
  order.state = "Paid";
  order.paidAt = postedAt;
  order.updatedAt = postedAt;
  order.returnedBy = "";
  order.returnedReason = "";
  state.ledger = [...lines, ...(state.ledger || [])];
  applyOrderIncomeSnapshot(state, order, lines);
  return { lines, postedAt };
}

function transferCommissionMinor(transfer) {
  const stored = Number(transfer.commissionMinor || 0);
  return stored > 0 ? stored : Math.round(Number(transfer.sourceAmountMinor || 0) * commissionPercent(transfer.commissionPercent) / 100);
}

function normalizedCommissionLiability(value, commissionMinor) {
  if (commissionLiabilities.has(value)) return value;
  return commissionMinor > 0 ? "Sender" : "";
}

function requestedTransferCommissionMinor(transfer) {
  const stored = Number(transfer.requestedCommissionMinor);
  if (Number.isSafeInteger(stored) && stored >= 0) return stored;
  const percent = Number(transfer.requestedCommissionPercent);
  return Number.isFinite(percent) && percent >= 0 ? Math.round(Number(transfer.sourceAmountMinor || 0) * percent / 100) : 0;
}

function originalSenderCommissionMinor(transfer) {
  const currentPercent = commissionPercent(transfer.commissionPercent);
  const requestedPercent = Number(transfer.requestedCommissionPercent);
  const changed = Boolean(transfer.forwardedAt && Number.isFinite(requestedPercent) && Math.abs(requestedPercent - currentPercent) > 0.000000001);
  return normalizedCommissionLiability(transfer.commissionLiability, transferCommissionMinor(transfer)) === "Receiver" && changed
    ? requestedTransferCommissionMinor(transfer)
    : 0;
}

function commissionPartyAccount(state, name, masterAccount = "MASTER_COMMISSION_EXPENSE") {
  const master = masterActor(state);
  if (!name || name === "Master" || name === master?.name) return { account: masterAccount, actorName: "" };
  return { account: name, actorName: name };
}

function commissionLedgerRouting(state, liability, senderName, receiverName) {
  const senderDebit = commissionPartyAccount(state, senderName);
  const senderCredit = commissionPartyAccount(state, senderName, "MASTER_COMMISSION_CLEARING");
  const receiverDebit = commissionPartyAccount(state, receiverName);
  if (liability === "Sender") return { debit: senderDebit, credit: { account: "MASTER_FEE_REVENUE", actorName: "" } };
  if (liability === "Receiver") return { debit: receiverDebit, credit: { account: "MASTER_FEE_REVENUE", actorName: "" } };
  return { debit: { account: "MASTER_COMMISSION_EXPENSE", actorName: "" }, credit: senderCredit };
}

function transferDetails(transfer) {
  const commission = transferCommissionMinor(transfer);
  const liability = normalizedCommissionLiability(transfer.commissionLiability, commission);
  return [
    `${transfer.from} -> ${transfer.to}`,
    transfer.forwardedAt && transfer.requestedTo ? `Originally sent to ${transfer.requestedTo}` : "",
    `Source: ${transfer.sourceCurrency}${majorFromMinor(transfer.sourceAmountMinor, transfer.sourceCurrency)}`,
    `Payout: ${transfer.currency}${majorFromMinor(transfer.amountMinor, transfer.currency)}`,
    `Rate: ${transfer.rate || 1}`,
    commission > 0 ? `Commission: ${transfer.sourceCurrency}${majorFromMinor(commission, transfer.sourceCurrency)} - Liability: ${liability}` : "",
    transfer.remarks ? `Remarks: ${transfer.remarks}` : "",
  ].filter(Boolean).join(" - ");
}

function candidateActorLedgerNumber(incomingLedger, expected, candidateJournal) {
  const match = (incomingLedger || []).find((line) =>
    line.journal === candidateJournal && line.source === expected.source && line.account === expected.account &&
    line.direction === expected.direction && line.currency === expected.currency && Number(line.amountMinor) === expected.amountMinor
  );
  const value = String(match?.actorLedgerNumber || "");
  return /^\d{1,8}_[A-Z0-9-]{1,80}$/i.test(value) ? value : "";
}

function postTransferLedger(state, transfer, incomingLedger = [], candidateJournal = "") {
  if (transfer.journal) deny("This transfer has already been posted.");
  const journal = nextJournalId(state);
  const postedAt = new Date().toISOString();
  const commission = transferCommissionMinor(transfer);
  const liability = normalizedCommissionLiability(transfer.commissionLiability, commission);
  transfer.commissionLiability = liability || undefined;
  const senderCommission = originalSenderCommissionMinor(transfer);
  const details = transferDetails(transfer);
  const lines = [
    { journal, transferId: transfer.id, source: "TRANSFER", account: transfer.to, direction: "Debit", currency: transfer.currency, amountMinor: transfer.amountMinor, details, postedAt },
    { journal, transferId: transfer.id, source: "TRANSFER", account: "MASTER_FX_CLEARING", direction: "Credit", currency: transfer.currency, amountMinor: transfer.amountMinor, details, postedAt },
    { journal, transferId: transfer.id, source: "TRANSFER", account: "MASTER_FX_CLEARING", direction: "Debit", currency: transfer.sourceCurrency, amountMinor: transfer.sourceAmountMinor, details, postedAt },
    { journal, transferId: transfer.id, source: "TRANSFER", account: transfer.from, direction: "Credit", currency: transfer.sourceCurrency, amountMinor: transfer.sourceAmountMinor, details, postedAt },
  ];
  if (commission > 0) {
    const routing = commissionLedgerRouting(state, liability || "Sender", transfer.from, transfer.to);
    lines.push(
      { journal, transferId: transfer.id, source: "TRANSFER", account: routing.debit.account, direction: "Debit", currency: transfer.sourceCurrency, amountMinor: commission, commissionLiability: liability, details, postedAt },
      { journal, transferId: transfer.id, source: "TRANSFER", account: routing.credit.account, direction: "Credit", currency: transfer.sourceCurrency, amountMinor: commission, commissionLiability: liability, details, postedAt },
    );
  }
  if (senderCommission > 0) {
    lines.push(
      { journal, transferId: transfer.id, source: "TRANSFER", account: "MASTER_COMMISSION_EXPENSE", direction: "Debit", currency: transfer.sourceCurrency, amountMinor: senderCommission, commissionLiability: "Master", commissionComponent: "ORIGINAL_SENDER", details, postedAt },
      { journal, transferId: transfer.id, source: "TRANSFER", account: transfer.from, direction: "Credit", currency: transfer.sourceCurrency, amountMinor: senderCommission, commissionLiability: "Master", commissionComponent: "ORIGINAL_SENDER", details, postedAt },
    );
  }
  lines.forEach((line) => {
    if (line.account === transfer.from || line.account === transfer.to) {
      const actorLedgerNumber = candidateActorLedgerNumber(incomingLedger, line, candidateJournal);
      if (actorLedgerNumber) line.actorLedgerNumber = actorLedgerNumber;
    }
  });
  transfer.journal = journal;
  transfer.approvedAt = transfer.approvedAt || postedAt;
  transfer.paidOutAt = transfer.paidOutAt || postedAt;
  state.ledger = [...lines, ...(state.ledger || [])];
}

function actorTransferCurrencies(actor) {
  if (!actor) return [];
  return actor.transferReceiveMultiCurrencyEnabled === true ? Array.from(currencies) : [actor.currency];
}

function transferTargetAllowed(actor, target) {
  if (!actor || !target || actor.id === target.id || target.active === false) return false;
  const mode = actor.transferEnabled === false ? "none" : actor.transferMode || "master";
  if (mode === "both") return true;
  if (mode === "actor") return target.role !== "Master";
  if (mode === "master") return target.role === "Master";
  return false;
}

function canonicalTransferInput(candidate, actor, target, existing = null) {
  if (!transferTargetAllowed(actor, target)) deny("The transfer destination is not permitted.");
  const sourceCurrency = safeCurrency(candidate.sourceCurrency, "source currency");
  const payoutCurrency = safeCurrency(candidate.currency, "payout currency");
  if (!actorTransferCurrencies(actor).includes(sourceCurrency)) deny("The sending currency is not permitted.");
  if (!(target.role === "Master" || target.transferReceiveMultiCurrencyEnabled === true || target.currency === payoutCurrency)) {
    deny("The receiving currency is not permitted.");
  }
  const sourceAmountMinor = positiveMinor(candidate.sourceAmountMinor, "source amount");
  const amountMinor = positiveMinor(candidate.amountMinor, "payout amount");
  const percent = commissionPercent(candidate.commissionPercent);
  const commissionMinor = Math.round(sourceAmountMinor * percent / 100);
  if (Number(candidate.commissionMinor || 0) !== commissionMinor) deny("The transfer commission does not match its percentage.");
  const liability = percent > 0 ? String(candidate.commissionLiability || "") : "";
  if (percent > 0 && !commissionLiabilities.has(liability)) deny("Choose the commission liability.");
  const now = new Date().toISOString();
  return {
    ...(existing || {}),
    id: existing?.id || cleanText(candidate.id, 80),
    from: actor.name,
    fromActorId: actor.id,
    to: target.name,
    toActorId: target.id,
    sourceCurrency,
    sourceAmountMinor,
    currency: payoutCurrency,
    amountMinor,
    rate: positiveRate(candidate.rate),
    commissionPercent: percent,
    commissionMinor,
    commissionLiability: liability || undefined,
    remarks: cleanText(candidate.remarks, 1000),
    state: "Pending Approval",
    journal: "",
    initiatedBy: actor.name,
    createdAt: existing?.createdAt || now,
    sentAt: now,
    updatedAt: now,
    approvedAt: "",
    paidOutAt: "",
    returnedAt: "",
    returnedBy: "",
    returnedReason: "",
    rejectedAt: "",
    rejectedBy: "",
  };
}

function canonicalOrderFinancial(candidate, actor, existing = null) {
  const sourceCurrency = safeCurrency(candidate.sourceCurrency, "source currency");
  const payoutCurrency = safeCurrency(candidate.payoutCurrency, "payout currency");
  if (actor.orderMultiCurrencyEnabled !== true && sourceCurrency !== actor.currency) deny("The order source currency is not permitted.");
  const sourceAmountMinor = positiveMinor(candidate.sourceAmountMinor, "source amount");
  const payoutAmountMinor = positiveMinor(candidate.payoutAmountMinor, "payout amount");
  const percent = commissionPercent(candidate.commissionPercent);
  const commissionMinor = Math.round(sourceAmountMinor * percent / 100);
  if (Number(candidate.commissionMinor || 0) !== commissionMinor) deny("The order commission does not match its percentage.");
  if (Number(candidate.grossMinor || 0) !== sourceAmountMinor + commissionMinor) deny("The order gross amount is invalid.");
  const fundingType = candidate.fundingType === "credit" ? "credit" : candidate.fundingType === "cash" ? "cash" : "";
  if (!fundingType) deny("Choose Cash or Credit.");
  const now = new Date().toISOString();
  return {
    ...(existing || {}),
    id: existing?.id || cleanText(candidate.id, 80),
    brokerOrderNumber: existing?.brokerOrderNumber || cleanText(candidate.brokerOrderNumber, 100),
    brokerOrderNumberCycle: existing?.brokerOrderNumberCycle ?? Math.max(0, Math.floor(Number(actor.numberingCycle || 0))),
    brokerActorId: actor.id,
    broker: actor.name,
    agent: "Unassigned",
    agentActorId: "",
    sourceCurrency,
    payoutCurrency,
    sourceAmountMinor,
    payoutAmountMinor,
    commissionMinor,
    grossMinor: sourceAmountMinor + commissionMinor,
    moneyUnitVersion: 2,
    rate: positiveRate(candidate.rate),
    commissionPercent: percent,
    senderName: cleanText(candidate.senderName, 200),
    receiverName: cleanText(candidate.receiverName, 200),
    receiverCity: cleanText(candidate.receiverCity, 200),
    accountNumber: cleanText(candidate.accountNumber, 200),
    phoneNumber: cleanText(candidate.phoneNumber, 100),
    remarks: cleanText(candidate.remarks, 1000),
    amount: cleanText(candidate.amount, 100),
    fundingType,
    state: "Pending Forward",
    journal: "",
    createdAt: existing?.createdAt || now,
    sentAt: existing?.sentAt || now,
    paidAt: existing?.paidAt || "",
    returnedBy: "",
    returnedReason: "",
    returnedAt: "",
    updatedAt: now,
    assignedAt: undefined,
    paymentProof: undefined,
    forwardedPayoutDivider: undefined,
    forwardedPayoutPercent: undefined,
    manualSpecialPayoutDivider: undefined,
    manualSpecialPayoutPercent: undefined,
    manualMasterRateDivider: undefined,
    manualMasterRatePercent: undefined,
  };
}

function recordById(records, id) {
  return (records || []).find((record) => record?.id === id);
}

function upsertById(records, record) {
  const index = (records || []).findIndex((item) => item.id === record.id);
  if (index >= 0) records.splice(index, 1, record);
  else records.unshift(record);
}

function removeById(records, id) {
  const index = (records || []).findIndex((item) => item.id === id);
  if (index >= 0) records.splice(index, 1);
}

function orderBalanceWasClosed(state, order) {
  if (order.locked === true) return true;
  const createdAt = new Date(order.createdAt || order.sentAt || 0).getTime();
  return (state.archives || []).some((archive) => (archive.orders || []).some((reportedOrder) => {
    if (reportedOrder.id !== order.id && reportedOrder.internalOrderId !== order.id) return false;
    const closedAt = new Date(archive.closedAt || 0).getTime();
    return !(Number.isFinite(createdAt) && createdAt > 0 && Number.isFinite(closedAt) && closedAt < createdAt);
  }));
}

function nextChatId(state) {
  const highest = (state.chatConversations || []).reduce((value, chat) => {
    const match = String(chat?.id || "").match(/^CHAT-(\d+)$/);
    return match ? Math.max(value, Number(match[1])) : value;
  }, 0);
  state.chatCounter = Math.max(Number(state.chatCounter || 0), highest) + 1;
  return `CHAT-${state.chatCounter}`;
}

function nextMessageId(state) {
  state.messageCounter = Number(state.messageCounter || 0) + 1;
  return `MSG-${state.messageCounter}-${Date.now().toString(36)}`;
}

function ensureDirectChat(state, leftName, rightName) {
  let chat = (state.chatConversations || []).find((item) =>
    item.type === "direct" && (item.members || []).includes(leftName) && (item.members || []).includes(rightName)
  );
  if (chat) return chat;
  chat = {
    id: nextChatId(state),
    type: "direct",
    name: rightName,
    members: [leftName, rightName],
    messages: [],
    createdAt: new Date().toISOString(),
  };
  state.chatConversations = [...(state.chatConversations || []), chat];
  return chat;
}

function appendPaymentProofToBroker(state, order, proof, files, session) {
  if (!proof?.attachmentId) return;
  const master = masterActor(state);
  const broker = (state.actors || []).find((actor) => actor.id === order.brokerActorId)
    || (state.actors || []).find((actor) => actor.name === order.broker);
  if (!master || !broker) deny("The original Broker chat is unavailable.");
  const chat = ensureDirectChat(state, master.name, broker.name);
  if ((chat.messages || []).some((message) => message.attachmentId === proof.attachmentId && message.orderId === order.id)) return;
  const file = activeFile(files, session, proof.attachmentId, order.id, ["payment-proof", "order-photo"]);
  file.contextIds = Array.from(new Set([...(file.contextIds || [file.contextId]), chat.id]));
  const orderNumber = order.brokerOrderNumber || order.id;
  chat.messages.push({
    id: nextMessageId(state),
    from: master.name,
    text: `Payment photo for order ${orderNumber}.`,
    kind: "photo",
    attachmentId: file.id,
    fileName: file.fileName,
    mimeType: file.mimeType,
    fileSize: file.size,
    orderId: order.id,
    orderNumber,
    replyTo: "",
    reactions: {},
    readBy: [master.name],
    createdAt: new Date().toISOString(),
  });
}

function safeMessageId(state, candidate) {
  const requested = cleanText(candidate, 120);
  const alreadyUsed = (state.chatConversations || []).some((chat) => (chat.messages || []).some((message) => message.id === requested));
  if (requested && !alreadyUsed) {
    const sequence = requested.match(/^MSG-(\d+)(?:-|$)/)?.[1];
    if (sequence) state.messageCounter = Math.max(Number(state.messageCounter || 0), Number(sequence));
    return requested;
  }
  return nextMessageId(state);
}

function processActorChats(state, incomingState, actor, files, session, actions) {
  const master = masterActor(state);
  for (const incomingChat of Array.isArray(incomingState.chatConversations) ? incomingState.chatConversations : []) {
    let chat = recordById(state.chatConversations, incomingChat?.id);
    if (!chat) {
      const allowedDirect = incomingChat?.type === "direct" && master && Array.isArray(incomingChat.members) &&
        incomingChat.members.includes(master.name) && incomingChat.members.includes(actor.name) && incomingChat.members.length === 2;
      if (!allowedDirect) continue; // Clients may locally synthesize other direct chats; the server ignores them.
      chat = ensureDirectChat(state, master.name, actor.name);
    }
    const actorIsMember = (chat.members || []).includes(actor.name);
    for (const candidate of Array.isArray(incomingChat.messages) ? incomingChat.messages : []) {
      const existing = (chat.messages || []).find((message) => message.id === candidate?.id);
      if (existing) {
        const immutableExisting = { ...existing, readBy: undefined, reactions: undefined };
        const immutableCandidate = { ...candidate, readBy: undefined, reactions: undefined };
        if (!equal(immutableExisting, immutableCandidate)) {
          if (recordTime(candidate) <= recordTime(existing)) continue;
          deny("An existing chat message was modified.");
        }
        if (!actorIsMember) continue;
        existing.readBy = Array.from(new Set([...(existing.readBy || []), ...((candidate.readBy || []).includes(actor.name) ? [actor.name] : [])]));
        const candidateReaction = candidate.reactions?.[actor.name];
        existing.reactions = { ...(existing.reactions || {}) };
        if (candidateReaction) existing.reactions[actor.name] = cleanText(candidateReaction, 20);
        else delete existing.reactions[actor.name];
        continue;
      }

      const linkedOrder = candidate?.orderId ? recordById(state.orders, candidate.orderId) : null;
      const routedToBroker = Boolean(master && linkedOrder && (linkedOrder.agentActorId === actor.id || linkedOrder.agent === actor.name) &&
        candidate.from === master.name && chat.type === "direct" && (chat.members || []).includes(master.name) &&
        (chat.members || []).includes(linkedOrder.broker));
      if (routedToBroker) {
        if (!candidate.attachmentId) deny("A routed order photo must include an attachment.");
        const file = activeFile(files, session, candidate.attachmentId, linkedOrder.id, ["order-photo", "payment-proof"]);
        if (file.uploaderUserId !== session.user.id) deny("The routed attachment was uploaded by another account.");
        if ((chat.messages || []).some((message) => message.attachmentId === file.id && message.orderId === linkedOrder.id)) continue;
        file.contextIds = Array.from(new Set([...(file.contextIds || [file.contextId]), chat.id]));
        const orderNumber = linkedOrder.brokerOrderNumber || linkedOrder.id;
        chat.messages.push({
          id: safeMessageId(state, candidate.id),
          from: master.name,
          text: `Payment photo for order ${orderNumber}.`,
          kind: "photo",
          attachmentId: file.id,
          fileName: file.fileName,
          mimeType: file.mimeType,
          fileSize: file.size,
          orderId: linkedOrder.id,
          orderNumber,
          replyTo: "",
          reactions: {},
          readBy: [master.name],
          createdAt: new Date().toISOString(),
        });
        actions.push(`routed order photo ${linkedOrder.id}`);
        continue;
      }

      if (!actorIsMember || candidate.from !== actor.name) continue;
      const kind = ["text", "photo", "voice", "file"].includes(candidate.kind) ? candidate.kind : "text";
      const message = {
        id: safeMessageId(state, candidate.id),
        from: actor.name,
        text: cleanText(candidate.text, 10_000),
        kind,
        replyTo: cleanText(candidate.replyTo, 120),
        reactions: {},
        readBy: [actor.name],
        createdAt: new Date().toISOString(),
      };
      if (message.replyTo && !(chat.messages || []).some((item) => item.id === message.replyTo)) deny("The replied message is unavailable.");
      if (kind !== "text") {
        const allowedPurposes = kind === "voice" ? ["chat-voice"] : kind === "file" ? ["chat-file"] : ["chat-photo"];
        const file = activeFile(files, session, candidate.attachmentId, chat.id, allowedPurposes);
        if (file.uploaderUserId !== session.user.id) deny("The attachment was uploaded by another account.");
        Object.assign(message, { attachmentId: file.id, fileName: file.fileName, mimeType: file.mimeType, fileSize: file.size });
      }
      if (!message.text && kind === "text") continue;
      chat.messages.push(message);
      actions.push(`sent chat message ${chat.id}`);
    }
  }
}

function processActorReceivables(state, incomingState, actor, actions) {
  const incomingReceivables = Array.isArray(incomingState.receivables) ? incomingState.receivables : [];
  for (const candidate of incomingReceivables) {
    if (!candidate?.id) continue;
    const existing = recordById(state.receivables, candidate.id);
    if (existing && equal(existing, candidate)) continue;
    if (existing && recordTime(candidate) < recordTime(existing)) continue;
    const order = recordById(state.orders, candidate.orderId || existing?.orderId);
    if (!order || (order.brokerActorId !== actor.id && order.broker !== actor.name)) deny("A receivable outside the Actor account was modified.");
    if (order.fundingType !== "credit") continue;
    if (!existing) {
      const expectedId = nextNumericId(state.receivables, /^REC-(\d+)$/, "REC-", state.receivableCounter);
      if (candidate.id !== expectedId) deny("Invalid receivable number.");
    }
    const previousPayments = existing?.payments || [];
    const candidatePayments = Array.isArray(candidate.payments) ? candidate.payments : [];
    let payments = clone(previousPayments);
    if (candidatePayments.length === previousPayments.length + 1 && equal(candidatePayments.slice(0, -1), previousPayments)) {
      const paymentCandidate = candidatePayments[candidatePayments.length - 1];
      const amountMinor = positiveMinor(paymentCandidate.amountMinor, "receivable payment");
      const paidMinor = previousPayments.reduce((sum, payment) => sum + Number(payment.amountMinor || 0), 0);
      if (amountMinor > Number(order.sourceAmountMinor) - paidMinor) deny("The receivable payment exceeds its balance.");
      payments.push({ id: `PAY-${Date.now()}`, amountMinor, paidAt: new Date().toISOString(), receivedBy: actor.name });
      actions.push(`collected receivable ${candidate.id}`);
    } else if (!equal(candidatePayments, previousPayments)) {
      deny("Receivable payment history was modified.");
    }
    const now = new Date().toISOString();
    upsertById(state.receivables, {
      ...(existing || {}),
      id: candidate.id,
      orderId: order.id,
      brokerOrderNumber: order.brokerOrderNumber || order.id,
      agentOrderNumber: order.agentOrderNumber || existing?.agentOrderNumber || "",
      borrower: actor.name,
      borrowerActorId: actor.id,
      currency: order.sourceCurrency,
      principalMinor: order.sourceAmountMinor,
      senderName: order.senderName,
      receiverName: order.receiverName,
      receiverCity: order.receiverCity,
      accountNumber: order.accountNumber,
      phoneNumber: order.phoneNumber,
      remarks: order.remarks,
      creditReminder: cleanText(candidate.creditReminder, 1000),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      createdBy: existing?.createdBy || actor.name,
      payments,
    });
  }

  for (const order of state.orders || []) {
    if (order.brokerActorId !== actor.id && order.broker !== actor.name) continue;
    const receivable = (state.receivables || []).find((item) => item.orderId === order.id);
    if (order.fundingType === "cash" && receivable && !(receivable.payments || []).length) removeById(state.receivables, receivable.id);
    if (order.fundingType === "credit" && !receivable) deny(`Credit order ${order.id} is missing its receivable.`);
  }
}

function processActorCustomers(state, incomingState, actor) {
  const candidates = (Array.isArray(incomingState.savedCustomers) ? incomingState.savedCustomers : [])
    .slice()
    .sort((left, right) => Number(String(left?.id || "").match(/^CUST-(\d+)$/)?.[1] || 0) - Number(String(right?.id || "").match(/^CUST-(\d+)$/)?.[1] || 0));
  for (const candidate of candidates) {
    if (!candidate?.id || candidate.actorId !== actor.id) continue;
    const existing = recordById(state.savedCustomers, candidate.id);
    if (existing && equal(existing, candidate)) continue;
    if (!existing) {
      const expectedId = nextNumericId(state.savedCustomers, /^CUST-(\d+)$/, "CUST-", state.customerCounter);
      if (candidate.id !== expectedId) deny("Invalid saved-customer number.");
    } else if (existing.actorId !== actor.id) {
      deny("A saved customer outside the Actor account was modified.");
    }
    upsertById(state.savedCustomers, {
      ...(existing || {}),
      id: candidate.id,
      actorId: actor.id,
      kind: candidate.kind === "receiver" ? "receiver" : "sender",
      name: cleanText(candidate.name, 200),
      receiverCity: cleanText(candidate.receiverCity, 200),
      accountNumber: cleanText(candidate.accountNumber, 200),
      phoneNumber: cleanText(candidate.phoneNumber, 100),
      remarks: cleanText(candidate.remarks, 1000),
      updatedAt: new Date().toISOString(),
    });
  }
}

function assertActorCannotChangeConfiguration(currentState, incomingState) {
  if (Array.isArray(incomingState.actors) && !equal(incomingState.actors, currentState.actors || [])) deny("Actor settings were modified.");
  if (incomingState.buyingRates && !equal(incomingState.buyingRates, currentState.buyingRates || {})) deny("Buying rates were modified.");
  if (incomingState.masterRateDivisorSettings && !equal(incomingState.masterRateDivisorSettings, currentState.masterRateDivisorSettings || {})) {
    deny("Master rate settings were modified.");
  }
  // Closed reports remain exclusively server-owned below. Web and Android normalize
  // legacy snapshots for display, so comparing their read-only copies byte-for-byte
  // would incorrectly block otherwise authorized Actor actions.
}

export function authorizeActorWorkspaceUpdate({ currentState, incomingState, session, files = [] }) {
  if (session?.membership?.role !== "Actor") return { state: incomingState, actions: ["master workspace update"] };
  if (!incomingState || typeof incomingState !== "object") deny("Invalid workspace state.");
  const state = clone(currentState || {});
  state.actors = Array.isArray(state.actors) ? state.actors : [];
  state.orders = Array.isArray(state.orders) ? state.orders : [];
  state.receivables = Array.isArray(state.receivables) ? state.receivables : [];
  state.savedCustomers = Array.isArray(state.savedCustomers) ? state.savedCustomers : [];
  state.transfers = Array.isArray(state.transfers) ? state.transfers : [];
  state.ledger = Array.isArray(state.ledger) ? state.ledger : [];
  state.archives = Array.isArray(state.archives) ? state.archives : [];
  state.chatConversations = Array.isArray(state.chatConversations) ? state.chatConversations : [];
  const actor = actorForSession(state, session);
  if (!actor || actor.active === false) deny("The Actor account is inactive.");
  const actions = [];
  assertActorCannotChangeConfiguration(state, incomingState);

  for (const candidate of Array.isArray(incomingState.orders) ? incomingState.orders : []) {
    if (!candidate?.id) continue;
    const existing = recordById(state.orders, candidate.id);
    if (existing && equal(existing, candidate)) continue;
    if (existing && candidate.state === existing.state && recordTime(candidate) <= recordTime(existing)) continue;
    if (existing && recordTime(candidate) < recordTime(existing)) continue;
    if (!existing) {
      if (!brokerRoles.has(actor.role)) deny("Only Brokers can create orders.");
      const expectedId = nextNumericId(state.orders, /^ORD-(\d+)$/, "ORD-", state.orderCounter);
      if (candidate.id !== expectedId) deny("Invalid order number.");
      const order = canonicalOrderFinancial(candidate, actor);
      if (!order.brokerOrderNumber || state.orders.some((item) => item.brokerOrderNumber === order.brokerOrderNumber)) deny("Invalid Broker order number.");
      state.orders.unshift(order);
      actions.push(`created order ${order.id}`);
      continue;
    }

    const isBroker = existing.brokerActorId === actor.id || existing.broker === actor.name;
    const isAgent = existing.agentActorId === actor.id || existing.agent === actor.name;
    if (isBroker && existing.state === "Returned" && candidate.state === "Pending Forward" && !existing.journal) {
      upsertById(state.orders, canonicalOrderFinancial(candidate, actor, existing));
      actions.push(`resubmitted order ${existing.id}`);
      continue;
    }
    if (isBroker && existing.state === "Returned" && candidate.state === "Cancelled" && !existing.journal) {
      const now = new Date().toISOString();
      upsertById(state.orders, { ...existing, state: "Cancelled", agent: "Cancelled", agentActorId: "", cancelledBy: actor.name, cancelledAt: now, updatedAt: now });
      actions.push(`cancelled order ${existing.id}`);
      continue;
    }
    if (isAgent && existing.state === "Assigned" && candidate.state === "Returned" && !existing.journal) {
      const returnedReason = cleanText(candidate.returnedReason, 500);
      if (!returnedReason) deny("Enter the reason for returning this order.");
      const now = new Date().toISOString();
      upsertById(state.orders, { ...existing, state: "Returned", agent: "Unassigned", agentActorId: "", returnedBy: actor.name, returnedReason, returnedAt: now, updatedAt: now });
      actions.push(`returned order ${existing.id}`);
      continue;
    }
    if (isAgent && payoutRoles.has(actor.role) && existing.state === "Assigned" && candidate.state === "Paid" && !existing.journal) {
      const order = { ...existing };
      const proof = paymentProof(files, session, candidate.paymentProof, existing.id);
      if (proof) order.paymentProof = proof;
      postOrderPayment(state, order);
      upsertById(state.orders, order);
      if (proof) appendPaymentProofToBroker(state, order, proof, files, session);
      actions.push(`paid order ${existing.id}`);
      continue;
    }
    if ((isBroker || isAgent) && existing.state === "Paid" && candidate.state === "Void Requested" && existing.journal && !existing.voidJournal && !orderBalanceWasClosed(state, existing)) {
      const now = new Date().toISOString();
      upsertById(state.orders, { ...existing, state: "Void Requested", voidRequested: true, excludedFromCalculations: false, voidRequestedBy: actor.name, voidRequestedAt: now, updatedAt: now });
      actions.push(`requested void ${existing.id}`);
      continue;
    }
    deny(`Unauthorized order transition ${existing.id}: ${existing.state} to ${candidate.state}.`);
  }

  for (const candidate of Array.isArray(incomingState.transfers) ? incomingState.transfers : []) {
    if (!candidate?.id) continue;
    const existing = recordById(state.transfers, candidate.id);
    if (existing && equal(existing, candidate)) continue;
    if (existing && candidate.state === existing.state && recordTime(candidate) <= recordTime(existing)) continue;
    if (existing && recordTime(candidate) < recordTime(existing)) continue;
    if (!existing) {
      const expectedId = nextNumericId(state.transfers, /^TRF-(\d+)$/, "TRF-", state.transferCounter);
      if (candidate.id !== expectedId) deny("Invalid transfer number.");
      const target = (state.actors || []).find((item) => item.id === candidate.toActorId);
      if (!target) deny("The receiving Actor is unavailable.");
      const transfer = canonicalTransferInput(candidate, actor, target);
      state.transfers.unshift(transfer);
      actions.push(`created transfer ${transfer.id}`);
      continue;
    }
    const isSender = existing.fromActorId === actor.id || existing.from === actor.name;
    const isReceiver = existing.toActorId === actor.id || existing.to === actor.name;
    if (isSender && existing.state === "Returned" && candidate.state === "Pending Approval" && !existing.journal) {
      const target = (state.actors || []).find((item) => item.id === candidate.toActorId);
      if (!target) deny("The receiving Actor is unavailable.");
      upsertById(state.transfers, canonicalTransferInput(candidate, actor, target, existing));
      actions.push(`resubmitted transfer ${existing.id}`);
      continue;
    }
    if (isReceiver && actor.role !== "Master" && existing.state === "Pending Acceptance" && !existing.journal && candidate.state === "Rejected") {
      const now = new Date().toISOString();
      upsertById(state.transfers, { ...existing, state: "Rejected", rejectedBy: actor.name, rejectedAt: now, updatedAt: now });
      actions.push(`rejected transfer ${existing.id}`);
      continue;
    }
    if (isReceiver && actor.role !== "Master" && existing.state === "Pending Acceptance" && !existing.journal && candidate.state === "Approved") {
      const transfer = { ...existing, state: "Approved", acceptedBy: actor.name, acceptedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      postTransferLedger(state, transfer, incomingState.ledger, candidate.journal);
      upsertById(state.transfers, transfer);
      actions.push(`accepted transfer ${existing.id}`);
      continue;
    }
    deny(`Unauthorized transfer transition ${existing.id}: ${existing.state} to ${candidate.state}.`);
  }

  processActorReceivables(state, incomingState, actor, actions);
  processActorCustomers(state, incomingState, actor);
  processActorChats(state, incomingState, actor, files, session, actions);
  return { state, actions };
}
