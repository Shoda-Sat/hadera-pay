function clean(value) {
  return String(value ?? "").trim();
}

function normalized(value) {
  return clean(value).toLocaleLowerCase();
}

function actorIdentityMatches(left = {}, right = {}) {
  const leftId = clean(left?.brokerActorId || left?.id);
  const rightId = clean(right?.brokerActorId || right?.id);
  if (leftId && rightId) return leftId === rightId;
  return normalized(left?.broker || left?.name) === normalized(right?.broker || right?.name);
}

export function actorOrderPrefix(actorName) {
  const value = clean(actorName || "ACT").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return `${value}XXX`.slice(0, 3);
}

function stableOrderMoment(order = {}) {
  return clean(order?.createdAt || order?.sentAt);
}

export function recoveredOrderMatches(left = {}, right = {}) {
  if (!actorIdentityMatches(left, right)) return false;
  const leftMoment = stableOrderMoment(left);
  const rightMoment = stableOrderMoment(right);
  if (leftMoment && rightMoment && leftMoment !== rightMoment) return false;
  return clean(left?.sourceCurrency) === clean(right?.sourceCurrency) &&
    Number(left?.sourceAmountMinor || 0) === Number(right?.sourceAmountMinor || 0) &&
    clean(left?.payoutCurrency) === clean(right?.payoutCurrency) &&
    Number(left?.payoutAmountMinor || 0) === Number(right?.payoutAmountMinor || 0) &&
    normalized(left?.receiverName) === normalized(right?.receiverName) &&
    clean(left?.accountNumber) === clean(right?.accountNumber) &&
    clean(left?.phoneNumber) === clean(right?.phoneNumber);
}

export function removeRecoveredOrderAliases(orders = []) {
  const values = Array.isArray(orders) ? orders.filter((order) => order && typeof order === "object") : [];
  const recovered = values.filter((order) => clean(order?.collisionSourceOrderId));
  if (!recovered.length) return values;
  return values.filter((candidate) => !recovered.some((order) =>
    candidate !== order &&
    clean(candidate?.id) === clean(order?.collisionSourceOrderId) &&
    recoveredOrderMatches(candidate, order)
  ));
}

function orderBelongsToBroker(order, actor) {
  const orderActorId = clean(order?.brokerActorId);
  const actorId = clean(actor?.id);
  if (orderActorId && actorId) return orderActorId === actorId;
  return normalized(order?.broker) === normalized(actor?.name);
}

function allOrderRecords(state = {}, reservedOrders = []) {
  return [
    ...(Array.isArray(state?.orders) ? state.orders : []),
    ...(Array.isArray(state?.archives) ? state.archives : [])
      .flatMap((archive) => Array.isArray(archive?.orders) ? archive.orders : []),
    ...(Array.isArray(reservedOrders) ? reservedOrders : []),
  ];
}

export function nextBrokerOrderNumberForActor(state = {}, actor = {}, reservedOrders = []) {
  const actorName = clean(actor?.name);
  const prefix = actorOrderPrefix(actorName);
  const numberingCycle = Math.max(0, Math.floor(Number(actor?.numberingCycle || 0)));
  const used = new Set();
  allOrderRecords(state, reservedOrders).forEach((order) => {
    if (orderBelongsToBroker(order, actor) && Number(order?.brokerOrderNumberCycle || 0) === numberingCycle) {
      const match = clean(order?.brokerOrderNumber).match(new RegExp(`^${prefix}(\\d+)$`, "i"));
      if (match) used.add(Number(match[1]));
    }
    if (Number(order?.agentOrderNumberCycles?.[actorName] || 0) === numberingCycle) {
      const actorNumbers = [order?.agentOrderNumbers?.[actorName]];
      if (order?.agentOrderActor === actorName || order?.agent === actorName) actorNumbers.push(order?.agentOrderNumber);
      actorNumbers.forEach((value) => {
        const match = clean(value).match(/^(\d+)_/);
        if (match) used.add(Number(match[1]));
      });
    }
  });
  (Array.isArray(state?.ledger) ? state.ledger : [])
    .filter((line) => line?.archived !== true && line?.source !== "TRANSFER_REVERSAL" &&
      (clean(line?.account) === actorName || clean(line?.account) === `${actorName} ACTOR_CLEARING`))
    .forEach((line) => {
      const match = clean(line?.actorLedgerNumber).match(/^(\d+)_/);
      if (match) used.add(Number(match[1]));
    });
  const next = Math.max(0, ...used) + 1;
  return {
    brokerOrderNumber: `${prefix}${String(next).padStart(3, "0")}`,
    brokerOrderNumberCycle: numberingCycle,
  };
}

function actorForOrder(state, order) {
  const actors = Array.isArray(state?.actors) ? state.actors : [];
  const actorId = clean(order?.brokerActorId);
  if (actorId) return actors.find((actor) => clean(actor?.id) === actorId) || null;
  const actorName = normalized(order?.broker);
  return actorName ? actors.find((actor) => normalized(actor?.name) === actorName) || null : null;
}

function orderFingerprint(order) {
  return JSON.stringify({
    brokerActorId: clean(order?.brokerActorId),
    broker: clean(order?.broker),
    brokerOrderNumber: clean(order?.brokerOrderNumber),
    brokerOrderNumberCycle: Number(order?.brokerOrderNumberCycle || 0),
    agent: clean(order?.agent),
    agentActorId: clean(order?.agentActorId),
    sourceCurrency: clean(order?.sourceCurrency),
    sourceAmountMinor: Number(order?.sourceAmountMinor || 0),
    payoutCurrency: clean(order?.payoutCurrency),
    payoutAmountMinor: Number(order?.payoutAmountMinor || 0),
    commissionMinor: Number(order?.commissionMinor || 0),
    grossMinor: Number(order?.grossMinor || 0),
    rate: Number(order?.rate || 0),
    commissionPercent: Number(order?.commissionPercent || 0),
    senderName: clean(order?.senderName),
    receiverName: clean(order?.receiverName),
    receiverCity: clean(order?.receiverCity),
    accountNumber: clean(order?.accountNumber),
    phoneNumber: clean(order?.phoneNumber),
    remarks: clean(order?.remarks),
    fundingType: clean(order?.fundingType),
    state: clean(order?.state),
    createdAt: clean(order?.createdAt),
    sentAt: clean(order?.sentAt),
  });
}

function linkedRecordCount(state, orderIds) {
  const ids = new Set(orderIds);
  let count = (Array.isArray(state?.ledger) ? state.ledger : []).filter((line) => ids.has(clean(line?.orderId))).length;
  count += (Array.isArray(state?.receivables) ? state.receivables : []).filter((item) => ids.has(clean(item?.orderId))).length;
  count += (Array.isArray(state?.chatConversations) ? state.chatConversations : [])
    .flatMap((chat) => Array.isArray(chat?.messages) ? chat.messages : [])
    .filter((message) => ids.has(clean(message?.orderId))).length;
  return count;
}

export function findPendingOrderIntegrityIssues(workspaceState = {}) {
  const orders = (Array.isArray(workspaceState?.orders) ? workspaceState.orders : [])
    .filter((order) => clean(order?.state) === "Pending Forward");
  const groups = new Map();
  orders.forEach((order) => {
    const actor = actorForOrder(workspaceState, order);
    const actorId = clean(actor?.id || order?.brokerActorId);
    const actorName = clean(actor?.name || order?.broker);
    const orderNumber = clean(order?.brokerOrderNumber || order?.id);
    if ((!actorId && !actorName) || !orderNumber) return;
    const actorKey = actorId ? `id:${actorId}` : `name:${normalized(actorName)}`;
    const key = `${actorKey}|${orderNumber.toUpperCase()}`;
    const group = groups.get(key) || { key, actorId, actorName, actorRole: clean(actor?.role), orderNumber, orders: [] };
    group.orders.push(order);
    groups.set(key, group);
  });

  const issues = [];
  groups.forEach((group) => {
    const prefix = actorOrderPrefix(group.actorName);
    const prefixPattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d+$`, "i");
    const wrongPrefix = !prefixPattern.test(group.orderNumber);
    const duplicate = group.orders.length > 1;
    if (!wrongPrefix && !duplicate) return;
    const fingerprints = new Set(group.orders.map(orderFingerprint));
    const orderIds = group.orders.map((order) => clean(order?.id)).filter(Boolean);
    const linkedRecords = linkedRecordCount(workspaceState, orderIds);
    const hasEmbeddedFinancialState = group.orders.some((order) =>
      Boolean(order?.journal || order?.paidAt || order?.assignedAt || order?.paymentProof) ||
      (order?.agent && !["Unassigned", "Cancelled"].includes(order.agent))
    );
    const exactDuplicates = fingerprints.size === 1;
    const safeAutoRepair = linkedRecords === 0 && !hasEmbeddedFinancialState && (!duplicate || exactDuplicates);
    const reason = linkedRecords > 0 || hasEmbeddedFinancialState
      ? "linked transaction data requires manual review"
      : duplicate && !exactDuplicates
        ? "records share a number but their details differ"
        : wrongPrefix && duplicate
          ? "wrong Broker prefix with exact duplicate copies"
          : wrongPrefix
            ? "wrong Broker prefix"
            : "exact duplicate copies";
    issues.push({
      key: group.key,
      actorId: group.actorId,
      actorName: group.actorName,
      actorRole: group.actorRole,
      orderNumber: group.orderNumber,
      expectedPrefix: prefix,
      count: group.orders.length,
      extraCopies: Math.max(0, group.orders.length - 1),
      wrongPrefix,
      duplicate,
      exactDuplicates,
      linkedRecords,
      safeAutoRepair,
      reason,
      orderIds,
    });
  });
  return issues.sort((left, right) => [left.actorName, left.orderNumber].join(":").localeCompare([right.actorName, right.orderNumber].join(":")));
}
