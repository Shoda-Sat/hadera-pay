import * as ImagePicker from "expo-image-picker";
import React, { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  Check,
  ChevronDown,
  ChevronUp,
  ImagePlus,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  UserPlus
} from "lucide-react-native";
import {
  changePassword,
  createOwnerMaster,
  createInvite,
  extendOwnerSubscription,
  loadOwnerMasters,
  loadInvites,
  removeWorkspaceActor,
  resetWorkspaceData,
  setOwnerMasterActive
} from "../api/client";
import { Button, Field, Panel, Pill, SelectRow, SummaryRow } from "../components/ui";
import {
  activeActors,
  actorCanPayoutCurrency,
  actorCanReceivePayouts,
  actorForSession,
  actorTransferCurrencies,
  approveOrderVoid,
  assignOrder,
  cancelOrder,
  collectReceivable,
  createChatGroup,
  createInternalTransfer,
  createManagedActor,
  deleteChatGroup,
  isMasterView,
  markOrderPaid,
  postActorJournal,
  postActorWithdrawal,
  pendingCancelledOrderStates,
  receivableBalance,
  remindOrderActor,
  rejectOrderVoid,
  requestOrderVoid,
  returnOrder,
  sendChatMessage,
  setTransferState,
  supportedCurrencies,
  transferTargetsFor,
  updateActorOrderSettings,
  updateActorTransferMode,
  updateBuyingRates,
  updateMasterRateSetting,
  visibleChatsFor
} from "../domain/workspace";
import { colors, radius, spacing } from "../theme";
import type {
  ActorRecord,
  ActorRole,
  AppScreen,
  Currency,
  InternalTransferDraft,
  InviteRecord,
  OrderRecord,
  OwnerMasterRecord,
  OwnerPlan,
  UserSession,
  WorkspaceState
} from "../types";
import { compactAmount, inputAmount, majorFromMinor, parseAmount } from "../utils/money";

type CommonProps = {
  session: UserSession;
  state: WorkspaceState;
  offline: boolean;
  onState: (state: WorkspaceState) => void;
  onNavigate: (screen: AppScreen) => void;
  onRefresh: () => void;
};

function ScreenTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <View style={styles.titleWrap}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.subtitle}>{subtitle}</Text>
    </View>
  );
}

function OfflineGuard({ offline }: { offline: boolean }) {
  if (!offline) return null;
  return <Text style={styles.offlineText}>Offline snapshot. Reconnect to make changes.</Text>;
}

function ToggleChoice({ label, checked, onPress, disabled = false }: { label: string; checked: boolean; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="checkbox" accessibilityState={{ checked, disabled }} disabled={disabled} onPress={onPress} style={[styles.toggleRow, disabled && styles.disabled]}><View style={[styles.checkBox, checked && styles.checkBoxActive]}>{checked ? <Check size={15} color="#fff" /> : null}</View><Text style={styles.toggleLabel}>{label}</Text></Pressable>;
}

function tone(value: string): "neutral" | "good" | "warn" | "danger" {
  if (["Paid", "Approved"].includes(value)) return "good";
  if (["Voided", "Cancelled", "Rejected"].includes(value)) return "danger";
  if (["Assigned", "Pending Forward", "Pending Approval", "Void Requested", "Returned"].includes(value)) return "warn";
  return "neutral";
}

function orderNumber(order: OrderRecord, session: UserSession): string {
  const payer = order.agent === session.actorName || order.agentActorId === session.actorId;
  if (payer && ["Agent", "Special Agent", "Special Broker"].includes(session.actorRole)) {
    return order.agentOrderNumbers?.[session.actorName] || order.agentOrderNumber || order.brokerOrderNumber || order.id;
  }
  return order.brokerOrderNumber || order.id;
}

function visibleOrders(session: UserSession, state: WorkspaceState): OrderRecord[] {
  return state.orders
    .filter((order) => isMasterView(session) || order.broker === session.actorName || order.agent === session.actorName || order.agentActorId === session.actorId)
    .filter((order) => isMasterView(session) || (!["Cancelled", "Voided"].includes(order.state) && order.locked !== true))
    .slice()
    .sort((a, b) => new Date(b.createdAt || b.updatedAt).getTime() - new Date(a.createdAt || a.updatedAt).getTime());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The action could not be completed.";
}

export function OrdersScreen(props: CommonProps & { onNewOrder: () => void; onEditReturnedOrder: (order: OrderRecord) => void }) {
  const { session, state, offline, onState, onNavigate, onRefresh, onNewOrder, onEditReturnedOrder } = props;
  const [expanded, setExpanded] = useState<string[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<Record<string, string>>({});
  const [divider, setDivider] = useState<Record<string, string>>({});
  const [percent, setPercent] = useState<Record<string, string>>({});
  const [proofs, setProofs] = useState<Record<string, { dataUri: string; fileName: string }>>({});
  const [busy, setBusy] = useState("");
  const orders = visibleOrders(session, state);

  const run = async (id: string, task: () => Promise<WorkspaceState>) => {
    if (offline) return Alert.alert("Offline", "Reconnect before making this change.");
    setBusy(id);
    try {
      onState(await task());
    } catch (error) {
      Alert.alert("Could not continue", errorMessage(error));
    } finally {
      setBusy("");
    }
  };

  const chooseProof = async (orderId: string) => {
    if (offline) return Alert.alert("Offline", "Reconnect before attaching a payment file.");
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return Alert.alert("Photo access", "Allow photo access to attach proof of payment.");
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.65, base64: true });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (Number(asset.fileSize || 0) > 8 * 1024 * 1024) return Alert.alert("File too large", "Choose a photo smaller than 8 MB.");
    if (!asset.base64) return Alert.alert("Attachment", "The selected photo could not be prepared.");
    setProofs((current) => ({
      ...current,
      [orderId]: { dataUri: `data:${asset.mimeType || "image/jpeg"};base64,${asset.base64}`, fileName: asset.fileName || `payment-${orderId}.jpg` }
    }));
  };

  const confirmPaid = (order: OrderRecord) => {
    Alert.alert("Mark as paid?", `Post ${orderNumber(order, session)} to the ledger now?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Mark Paid", onPress: () => run(`paid-${order.id}`, () => markOrderPaid(order.id, session.actorId, proofs[order.id])) }
    ]);
  };

  return (
    <View style={styles.screen}>
      <ScreenTitle title="Orders" subtitle={isMasterView(session) ? "Forward, review, and void orders" : "Your active orderbook"} />
      <OfflineGuard offline={offline} />
      <View style={styles.rowButtons}>
        {["Broker", "Special Broker"].includes(session.actorRole) ? (
          <Button label="New order" icon={<Plus size={17} color="#fff" />} onPress={onNewOrder} style={styles.flexButton} />
        ) : null}
        {isMasterView(session) ? (
          <Button label="Pending & Cancelled" variant="secondary" onPress={() => onNavigate("pendingCancelled")} style={styles.flexButton} />
        ) : null}
        <Button label="Refresh" icon={<RefreshCw size={17} color={colors.ink} />} variant="secondary" onPress={onRefresh} style={styles.flexButton} />
      </View>
      {orders.length ? orders.map((order) => {
        const isExpanded = expanded.includes(order.id);
        const isPayer = order.agent === session.actorName || order.agentActorId === session.actorId;
        const payerOptions = activeActors(state).filter((actor) => actor.name !== order.broker && actorCanPayoutCurrency(actor, order.payoutCurrency));
        const stateLabel = isMasterView(session) && order.state === "Assigned" ? `Assigned to ${order.agent}` : order.state;
        return (
          <Panel key={order.id} title={orderNumber(order, session)} badge={stateLabel}>
            <Text style={styles.amountLine}>
              {compactAmount(order.sourceCurrency, majorFromMinor(order.sourceAmountMinor, order.sourceCurrency))} to {compactAmount(order.payoutCurrency, majorFromMinor(order.payoutAmountMinor, order.payoutCurrency))}
            </Text>
            <Text style={styles.primaryLine}>{order.receiverName || order.accountNumber || order.phoneNumber || "Receiver not entered"}</Text>
            <Pressable style={styles.showMore} onPress={() => setExpanded((current) => isExpanded ? current.filter((id) => id !== order.id) : [...current, order.id])}>
              <Text style={styles.linkText}>{isExpanded ? "Show less" : "Show more"}</Text>
              {isExpanded ? <ChevronUp size={17} color={colors.accent} /> : <ChevronDown size={17} color={colors.accent} />}
            </Pressable>
            {isExpanded ? (
              <View style={styles.detailBlock}>
                {isMasterView(session) ? <SummaryRow label="Ordering broker" value={order.broker} /> : null}
                {order.senderName ? <SummaryRow label="Sender" value={order.senderName} /> : null}
                {order.receiverName ? <SummaryRow label="Receiver" value={order.receiverName} /> : null}
                {order.phoneNumber ? <SummaryRow label="Phone" value={order.phoneNumber} /> : null}
                {order.accountNumber ? <SummaryRow label="Account" value={order.accountNumber} /> : null}
                {order.remarks ? <SummaryRow label="Remarks" value={order.remarks} /> : null}
                <SummaryRow label="Rate" value={String(order.rate)} />
                <SummaryRow label="Commission" value={`${order.commissionPercent || 0}%`} />
                <SummaryRow label="Funding" value={order.fundingType === "credit" ? "Credit" : "Cash"} />
              </View>
            ) : null}
            {isMasterView(session) && order.state === "Pending Forward" ? (
              <View style={styles.actionBlock}>
                <Text style={styles.fieldLabel}>Paying actor</Text>
                <View style={styles.choiceWrap}>
                  {payerOptions.map((actor) => (
                    <Pressable key={actor.id} onPress={() => setSelectedAgent((current) => ({ ...current, [order.id]: actor.id }))} style={[styles.choice, selectedAgent[order.id] === actor.id && styles.choiceActive]}>
                      <Text style={[styles.choiceText, selectedAgent[order.id] === actor.id && styles.choiceTextActive]}>{actor.name}</Text>
                    </Pressable>
                  ))}
                </View>
                {payerOptions.some((actor) => actor.id === selectedAgent[order.id] && ["Special Agent", "Special Broker"].includes(actor.role)) ? (
                  <View style={styles.twoColumns}>
                    <Field label="Payout divisor" value={divider[order.id] || ""} onChangeText={(value) => setDivider((current) => ({ ...current, [order.id]: value }))} keyboardType="decimal-pad" />
                    <Field label="Percent" value={percent[order.id] || ""} onChangeText={(value) => setPercent((current) => ({ ...current, [order.id]: value }))} keyboardType="decimal-pad" />
                  </View>
                ) : null}
                <Button label="Forward order" disabled={!selectedAgent[order.id] || offline} loading={busy === `assign-${order.id}`} onPress={() => run(`assign-${order.id}`, () => assignOrder(order.id, selectedAgent[order.id], divider[order.id], percent[order.id]))} />
                <View style={styles.rowButtons}>
                  <Button label="Return" variant="secondary" disabled={offline} onPress={() => run(`return-${order.id}`, () => returnOrder(order.id))} style={styles.flexButton} />
                  <Button label="Cancel" variant="danger" disabled={offline} onPress={() => run(`cancel-${order.id}`, () => cancelOrder(order.id))} style={styles.flexButton} />
                </View>
              </View>
            ) : null}
            {isPayer && order.state === "Assigned" ? (
              <View style={styles.actionBlock}>
                <Button label={proofs[order.id] ? "Photo ready" : "Attach payment photo"} variant="secondary" icon={proofs[order.id] ? <Check size={17} color={colors.good} /> : <ImagePlus size={17} color={colors.ink} />} onPress={() => chooseProof(order.id)} disabled={offline || busy !== ""} />
                <Button label={busy === `paid-${order.id}` ? "Uploading and posting..." : "Mark as Paid"} loading={busy === `paid-${order.id}`} disabled={offline || busy !== ""} onPress={() => confirmPaid(order)} />
              </View>
            ) : null}
            {isPayer && order.state === "Paid" ? <Button label="Request Void" variant="danger" disabled={offline} onPress={() => run(`void-${order.id}`, () => requestOrderVoid(order.id, session.actorName))} /> : null}
            {["Broker", "Special Broker"].includes(session.actorRole) && order.state === "Returned" && order.broker === session.actorName ? <Button label="Modify returned order" icon={<Pencil size={17} color={colors.ink} />} variant="secondary" onPress={() => onEditReturnedOrder(order)} /> : null}
            {isMasterView(session) && order.state === "Void Requested" ? (
              <View style={styles.rowButtons}>
                <Button label="Approve void" variant="danger" disabled={offline} onPress={() => run(`approve-void-${order.id}`, () => approveOrderVoid(order.id, session.actorName))} style={styles.flexButton} />
                <Button label="Reject" variant="secondary" disabled={offline} onPress={() => run(`reject-void-${order.id}`, () => rejectOrderVoid(order.id, session.actorName))} style={styles.flexButton} />
              </View>
            ) : null}
          </Panel>
        );
      }) : <Panel><Text style={styles.muted}>No active orders.</Text></Panel>}
    </View>
  );
}

function pendingCancelledDate(order: OrderRecord): string {
  if (order.state === "Assigned") return order.assignedAt || order.updatedAt || order.createdAt;
  if (order.state === "Returned") return order.returnedAt || order.updatedAt || order.createdAt;
  if (order.state === "Voided") return order.voidedAt || order.updatedAt || order.createdAt;
  if (order.state === "Cancelled") return order.cancelledAt || order.updatedAt || order.createdAt;
  return order.updatedAt || order.createdAt;
}

function reminderPayer(state: WorkspaceState, order: OrderRecord): ActorRecord | undefined {
  const payer = activeActors(state).find((actor) => actor.id === order.agentActorId)
    || activeActors(state).find((actor) => actor.name === order.agent);
  return payer && actorCanReceivePayouts(payer.role) ? payer : undefined;
}

export function PendingCancelledScreen({ session, state, offline, onState, onNavigate }: CommonProps) {
  const [busy, setBusy] = useState("");
  const orders = state.orders
    .filter((order) => pendingCancelledOrderStates.has(order.state))
    .slice()
    .sort((a, b) => new Date(pendingCancelledDate(b)).getTime() - new Date(pendingCancelledDate(a)).getTime());

  const sendReminder = async (order: OrderRecord) => {
    if (offline) return Alert.alert("Offline", "Reconnect before sending an order reminder.");
    setBusy(order.id);
    try {
      const nextState = await remindOrderActor(order.id, session.actorName);
      onState(nextState);
      const payer = reminderPayer(nextState, order);
      Alert.alert("Reminder sent", `${orderNumber(order, session)} reminder sent${payer ? ` to ${payer.name}` : ""}.`);
    } catch (error) {
      Alert.alert("Could not send reminder", errorMessage(error));
    } finally {
      setBusy("");
    }
  };

  return (
    <View style={styles.screen}>
      <ScreenTitle title="Pending & Cancelled" subtitle="Assigned, returned, voided, and cancelled orders" />
      <OfflineGuard offline={offline} />
      <Button label="Orderbook" variant="secondary" onPress={() => onNavigate("orders")} />
      {orders.length ? orders.map((order) => {
        const payer = reminderPayer(state, order);
        const payoutActor = payer?.name || (!["Unassigned", "Cancelled", "Forwarded"].includes(order.agent) ? order.agent : "Unassigned");
        const stateLabel = order.state === "Assigned" && payoutActor !== "Unassigned" ? `Assigned to ${payoutActor}` : order.state;
        return (
          <Panel key={order.id} title={orderNumber(order, session)} badge={stateLabel}>
            <SummaryRow label="Broker" value={order.broker} />
            <SummaryRow label="Payout actor" value={payoutActor} />
            <SummaryRow label="Amount" value={`${compactAmount(order.sourceCurrency, majorFromMinor(order.sourceAmountMinor, order.sourceCurrency))} to ${compactAmount(order.payoutCurrency, majorFromMinor(order.payoutAmountMinor, order.payoutCurrency))}`} />
            <SummaryRow label="State" value={stateLabel} />
            <Button label="Remind Actor" variant="secondary" disabled={offline || !payer || busy !== ""} loading={busy === order.id} onPress={() => sendReminder(order)} />
            {!payer ? <Text style={styles.muted}>No payout actor is available for this order.</Text> : order.lastReminderAt ? <Text style={styles.muted}>Last reminder: {new Date(order.lastReminderAt).toLocaleString()}</Text> : null}
          </Panel>
        );
      }) : <Panel><Text style={styles.muted}>No assigned, returned, voided, or cancelled orders.</Text></Panel>}
    </View>
  );
}

const emptyTransfer: InternalTransferDraft = {
  toActorId: "",
  sourceCurrency: "USD",
  payoutCurrency: "USD",
  sourceAmount: "",
  payoutAmount: "",
  rate: "1",
  commissionPercent: "",
  remarks: ""
};

export function TransfersScreen(props: CommonProps) {
  const { session, state, offline, onState } = props;
  const [mode, setMode] = useState<"Transfer" | "Journal" | "Withdrawal">("Transfer");
  const actor = actorForSession(session, state);
  const currencies = actorTransferCurrencies(actor);
  const [draft, setDraft] = useState<InternalTransferDraft>({ ...emptyTransfer, sourceCurrency: currencies[0] || session.currency, payoutCurrency: currencies[0] || session.currency });
  const [busy, setBusy] = useState(false);
  const [journal, setJournal] = useState({ actorId: "", sourceCurrency: "USD" as Currency, sourceAmount: "", currency: "USD" as Currency, amount: "", rate: "1", remarks: "" });
  const targets = transferTargetsFor(session, state);
  const transfers = state.transfers.filter((item) => isMasterView(session) || item.from === session.actorName || item.to === session.actorName);
  const master = isMasterView(session);

  const run = async (task: () => Promise<WorkspaceState>) => {
    if (offline) return Alert.alert("Offline", "Reconnect before making this change.");
    setBusy(true);
    try { onState(await task()); } catch (error) { Alert.alert("Could not continue", errorMessage(error)); } finally { setBusy(false); }
  };

  const estimated = parseAmount(draft.sourceAmount) * Number(draft.rate || 0);
  return (
    <View style={styles.screen}>
      <ScreenTitle title="Transfers" subtitle="Transfers, journals, and withdrawals" />
      <OfflineGuard offline={offline} />
      {master ? <SelectRow label="Action" options={["Transfer", "Journal", "Withdrawal"]} value={mode} onChange={setMode} /> : null}
      {mode === "Transfer" ? (
        <Panel title="New transfer" badge={master ? "Posts now" : "Needs approval"}>
          <Text style={styles.fieldLabel}>Receiving actor</Text>
          <View style={styles.choiceWrap}>{targets.map((target) => <Pressable key={target.id} onPress={() => setDraft({ ...draft, toActorId: target.id })} style={[styles.choice, draft.toActorId === target.id && styles.choiceActive]}><Text style={[styles.choiceText, draft.toActorId === target.id && styles.choiceTextActive]}>{target.name}</Text></Pressable>)}</View>
          <SelectRow label="Source currency" options={currencies.length ? currencies : [session.currency]} value={draft.sourceCurrency} onChange={(value) => setDraft({ ...draft, sourceCurrency: value })} />
          <Field label="Source amount" value={draft.sourceAmount} onChangeText={(value) => setDraft({ ...draft, sourceAmount: value })} keyboardType="decimal-pad" />
          <SelectRow label="Payout currency" options={supportedCurrencies} value={draft.payoutCurrency} onChange={(value) => setDraft({ ...draft, payoutCurrency: value })} />
          <Field label="Rate" value={draft.rate} onChangeText={(value) => setDraft({ ...draft, rate: value, payoutAmount: inputAmount(draft.payoutCurrency, parseAmount(draft.sourceAmount) * Number(value || 0)) })} keyboardType="decimal-pad" />
          <Field label="Payout amount" value={draft.payoutAmount || inputAmount(draft.payoutCurrency, estimated)} onChangeText={(value) => setDraft({ ...draft, payoutAmount: value })} keyboardType="decimal-pad" />
          <Field label="Percent" value={draft.commissionPercent} onChangeText={(value) => setDraft({ ...draft, commissionPercent: value })} keyboardType="decimal-pad" />
          <Field label="Remarks" value={draft.remarks} onChangeText={(value) => setDraft({ ...draft, remarks: value })} multiline />
          <Button label="Send transfer" loading={busy} disabled={offline} onPress={() => run(() => createInternalTransfer(session, draft))} />
        </Panel>
      ) : (
        <Panel title={mode}>
          <Text style={styles.fieldLabel}>Actor</Text>
          <View style={styles.choiceWrap}>{activeActors(state).filter((item) => item.role !== "Master").map((item) => <Pressable key={item.id} onPress={() => setJournal({ ...journal, actorId: item.id })} style={[styles.choice, journal.actorId === item.id && styles.choiceActive]}><Text style={[styles.choiceText, journal.actorId === item.id && styles.choiceTextActive]}>{item.name}</Text></Pressable>)}</View>
          {mode === "Journal" ? <>
            <SelectRow label="Source currency" options={supportedCurrencies} value={journal.sourceCurrency} onChange={(value) => setJournal({ ...journal, sourceCurrency: value })} />
            <Field label="Source amount" value={journal.sourceAmount} onChangeText={(value) => setJournal({ ...journal, sourceAmount: value })} keyboardType="decimal-pad" />
            <SelectRow label="Ledger currency" options={supportedCurrencies} value={journal.currency} onChange={(value) => setJournal({ ...journal, currency: value })} />
            <Field label="Rate" value={journal.rate} onChangeText={(value) => setJournal({ ...journal, rate: value, amount: inputAmount(journal.currency, parseAmount(journal.sourceAmount) * Number(value || 0)) })} keyboardType="decimal-pad" />
            <Field label="Converted amount" value={journal.amount} onChangeText={(value) => setJournal({ ...journal, amount: value })} keyboardType="decimal-pad" />
          </> : <><SelectRow label="Currency" options={supportedCurrencies} value={journal.currency} onChange={(value) => setJournal({ ...journal, currency: value })} /><Field label="Amount" value={journal.amount} onChangeText={(value) => setJournal({ ...journal, amount: value })} keyboardType="decimal-pad" /></>}
          <Field label="Remarks" value={journal.remarks} onChangeText={(value) => setJournal({ ...journal, remarks: value })} multiline />
          <Button label={`Post ${mode.toLowerCase()}`} loading={busy} disabled={offline} onPress={() => run(() => mode === "Journal" ? postActorJournal(journal) : postActorWithdrawal({ actorId: journal.actorId, currency: journal.currency, amount: journal.amount, remarks: journal.remarks }))} />
        </Panel>
      )}
      <Panel title="Transfer history" badge={String(transfers.length)}>
        {transfers.map((transfer) => <View key={transfer.id} style={styles.recordRow}><View style={styles.recordMain}><Text style={styles.primaryLine}>{transfer.id}: {transfer.from} to {transfer.to}</Text><Text style={styles.muted}>{compactAmount(transfer.sourceCurrency, majorFromMinor(transfer.sourceAmountMinor, transfer.sourceCurrency))} to {compactAmount(transfer.currency, majorFromMinor(transfer.amountMinor, transfer.currency))}{transfer.remarks ? ` - ${transfer.remarks}` : ""}</Text></View><Pill label={transfer.state} tone={tone(transfer.state)} />{master && transfer.state === "Pending Approval" ? <View style={styles.rowButtons}><Button label="Approve" disabled={offline} onPress={() => run(() => setTransferState(transfer.id, "approve", session.actorName))} style={styles.flexButton} /><Button label="Return" variant="secondary" disabled={offline} onPress={() => run(() => setTransferState(transfer.id, "return", session.actorName))} style={styles.flexButton} /><Button label="Reject" variant="danger" disabled={offline} onPress={() => run(() => setTransferState(transfer.id, "reject", session.actorName))} style={styles.flexButton} /></View> : null}</View>)}
      </Panel>
    </View>
  );
}

export function SearchScreen({ session, state, onNavigate }: CommonProps) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLocaleLowerCase();
  const orders = visibleOrders(session, { ...state, orders: state.orders.filter((order) => JSON.stringify(order).toLocaleLowerCase().includes(needle)) });
  const transfers = state.transfers.filter((item) => (isMasterView(session) || item.from === session.actorName || item.to === session.actorName) && JSON.stringify(item).toLocaleLowerCase().includes(needle));
  const ledger = state.ledger.filter((line) => (isMasterView(session) || String(line.account).includes(session.actorName)) && JSON.stringify(line).toLocaleLowerCase().includes(needle));
  const archives = state.archives.filter((archive) => (isMasterView(session) || archive.actor === session.actorName) && JSON.stringify(archive).toLocaleLowerCase().includes(needle));
  const count = needle ? orders.length + transfers.length + ledger.length + archives.length : 0;
  return <View style={styles.screen}><ScreenTitle title="Search" subtitle="Find any permitted workspace record" /><Field label="Search names, numbers, remarks, transfers..." value={query} onChangeText={setQuery} autoCapitalize="none" />{!needle ? <Panel><Text style={styles.muted}>Start typing to filter matching records.</Text></Panel> : <><Pill label={`${count} result${count === 1 ? "" : "s"}`} tone={count ? "good" : "neutral"} />{orders.map((order) => <Pressable key={`o-${order.id}`} onPress={() => onNavigate("orders")}><Panel title={orderNumber(order, session)} badge={order.state}><Text style={styles.primaryLine}>{order.senderName} to {order.receiverName}</Text><Text style={styles.muted}>{compactAmount(order.sourceCurrency, majorFromMinor(order.sourceAmountMinor, order.sourceCurrency))} to {compactAmount(order.payoutCurrency, majorFromMinor(order.payoutAmountMinor, order.payoutCurrency))} - {order.remarks}</Text></Panel></Pressable>)}{transfers.map((transfer) => <Pressable key={`t-${transfer.id}`} onPress={() => onNavigate("transfers")}><Panel title={transfer.id} badge={transfer.state}><Text style={styles.primaryLine}>{transfer.from} to {transfer.to}</Text><Text style={styles.muted}>{transfer.remarks}</Text></Panel></Pressable>)}{ledger.map((line, index) => <Pressable key={`l-${line.journal}-${index}`} onPress={() => onNavigate("ledger")}><Panel title={String(line.journal || line.entryId || "Ledger")} badge={line.direction}><Text style={styles.primaryLine}>{line.account}</Text><Text style={styles.muted}>{compactAmount(line.currency, majorFromMinor(line.amountMinor, line.currency))} - {String(line.details || "")}</Text></Panel></Pressable>)}{archives.map((archive, index) => <Pressable key={`a-${archive.id || index}`} onPress={() => onNavigate("archive")}><Panel title={archive.actor || "Closed statement"} badge="Archive"><Text style={styles.muted}>{new Date(archive.closedAt || 0).toLocaleString()}</Text></Panel></Pressable>)}</>}</View>;
}

export function ReceivablesScreen({ session, state, offline, onState }: CommonProps) {
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const records = state.receivables.filter((item) => isMasterView(session) || item.borrower === session.actorName);
  const totals = supportedCurrencies.map((currency) => ({ currency, minor: records.filter((item) => item.currency === currency && !item.voided).reduce((sum, item) => sum + receivableBalance(item), 0) })).filter((item) => item.minor);
  const collect = async (id: string) => {
    if (offline) return Alert.alert("Offline", "Reconnect before recording a collection.");
    setBusy(id);
    try { onState(await collectReceivable(id, amounts[id] || "", session.actorName)); setAmounts((current) => ({ ...current, [id]: "" })); } catch (error) { Alert.alert("Collection", errorMessage(error)); } finally { setBusy(""); }
  };
  return <View style={styles.screen}><ScreenTitle title="Receivables" subtitle="Credit orders and loan collections" /><OfflineGuard offline={offline} />{records.map((item) => { const balance = receivableBalance(item); return <Panel key={item.id} title={item.orderId} badge={item.voided ? "Voided" : balance ? "Open" : "Collected"}><SummaryRow label="Borrower" value={item.borrower} /><SummaryRow label="Principal" value={compactAmount(item.currency, majorFromMinor(item.principalMinor, item.currency))} /><SummaryRow label="Collected" value={compactAmount(item.currency, majorFromMinor(item.principalMinor - balance, item.currency))} /><SummaryRow label="Balance" value={compactAmount(item.currency, majorFromMinor(balance, item.currency))} strong />{balance > 0 && !item.voided ? <View style={styles.actionBlock}><Field label="Collection amount" value={amounts[item.id] || ""} onChangeText={(value) => setAmounts((current) => ({ ...current, [item.id]: value }))} keyboardType="decimal-pad" /><Button label="Record collection" loading={busy === item.id} disabled={offline} onPress={() => collect(item.id)} /></View> : null}</Panel>; })}<Panel title="Outstanding totals">{totals.length ? totals.map((item) => <SummaryRow key={item.currency} label={item.currency} value={compactAmount(item.currency, majorFromMinor(item.minor, item.currency))} strong />) : <Text style={styles.muted}>No outstanding receivables.</Text>}</Panel></View>;
}

export function ChatScreen({ session, state, offline, onState }: CommonProps) {
  const chats = visibleChatsFor(session, state);
  const [chatId, setChatId] = useState(chats[0]?.id || "");
  const [message, setMessage] = useState("");
  const [groupName, setGroupName] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const selected = chats.find((chat) => chat.id === chatId) || chats[0];
  const run = async (task: () => Promise<WorkspaceState>) => { if (offline) return Alert.alert("Offline", "Reconnect before sending or changing chats."); setBusy(true); try { onState(await task()); } catch (error) { Alert.alert("Chat", errorMessage(error)); } finally { setBusy(false); } };
  return <View style={styles.screen}><ScreenTitle title="Chat" subtitle="Workspace messages" /><OfflineGuard offline={offline} /><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chatTabs}>{chats.map((chat) => <Pressable key={chat.id} onPress={() => setChatId(chat.id)} style={[styles.choice, selected?.id === chat.id && styles.choiceActive]}><Text style={[styles.choiceText, selected?.id === chat.id && styles.choiceTextActive]}>{chat.name}</Text></Pressable>)}</ScrollView>{selected ? <Panel title={selected.name} badge={selected.type}><View style={styles.messages}>{selected.messages.slice(-50).map((item) => <View key={item.id} style={[styles.message, item.from === session.actorName && styles.myMessage]}><Text style={styles.messageFrom}>{item.from}</Text><Text style={styles.messageText}>{item.text}</Text><Text style={styles.messageTime}>{new Date(item.createdAt).toLocaleString()}</Text></View>)}</View><Field label="Message" value={message} onChangeText={setMessage} multiline /><Button label="Send" icon={<Send size={17} color="#fff" />} loading={busy} disabled={offline || !message.trim()} onPress={() => run(async () => { const next = await sendChatMessage(selected.id, session.actorName, message); setMessage(""); return next; })} />{isMasterView(session) && selected.type === "group" ? <Button label="Delete group" icon={<Trash2 size={17} color={colors.danger} />} variant="danger" disabled={offline} onPress={() => run(() => deleteChatGroup(selected.id))} /> : null}</Panel> : <Panel><Text style={styles.muted}>No conversations yet.</Text></Panel>}{isMasterView(session) ? <Panel title="Create group"><Field label="Group name" value={groupName} onChangeText={setGroupName} /><View style={styles.choiceWrap}>{activeActors(state).filter((actor) => actor.role !== "Master").map((actor) => <Pressable key={actor.id} onPress={() => setMembers((current) => current.includes(actor.name) ? current.filter((name) => name !== actor.name) : [...current, actor.name])} style={[styles.choice, members.includes(actor.name) && styles.choiceActive]}><Text style={[styles.choiceText, members.includes(actor.name) && styles.choiceTextActive]}>{actor.name}</Text></Pressable>)}</View><Button label="Create group" loading={busy} disabled={offline} onPress={() => run(async () => { const next = await createChatGroup(groupName, members); setGroupName(""); setMembers([]); return next; })} /></Panel> : null}</View>;
}

export function LedgerScreen({ session, state }: CommonProps) {
  const actorChoices = activeActors(state).filter((actor) => actor.role !== "Master");
  const [actorId, setActorId] = useState(isMasterView(session) ? actorChoices[0]?.id || "" : session.actorId);
  const selected = isMasterView(session) ? actorChoices.find((actor) => actor.id === actorId) : actorForSession(session, state);
  const actorName = selected?.name || session.actorName;
  const lines = state.ledger.filter((line) => isMasterView(session) ? (!selected || String(line.account).includes(actorName)) : String(line.account).includes(session.actorName));
  const balances = supportedCurrencies.map((currency) => ({ currency, minor: lines.filter((line) => line.currency === currency).reduce((sum, line) => sum + (line.direction === "Debit" ? 1 : -1) * Number(line.amountMinor || 0), 0) }));
  const incomeOrders = state.orders.filter((order) => order.state === "Paid" && order.journal && !order.voidJournal && Number.isFinite(Number(order.incomeProfitMinor)));
  const totalIncomeUsdMinor = incomeOrders.reduce((sum, order) => sum + Number(order.incomeProfitMinor || 0), 0);
  return (
    <View style={styles.screen}>
      <ScreenTitle title="Ledger" subtitle="Balances and posted journals" />
      {isMasterView(session) ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chatTabs}>
          {actorChoices.map((actor) => <Pressable key={actor.id} onPress={() => setActorId(actor.id)} style={[styles.choice, actorId === actor.id && styles.choiceActive]}><Text style={[styles.choiceText, actorId === actor.id && styles.choiceTextActive]}>{actor.name}</Text></Pressable>)}
        </ScrollView>
      ) : null}
      <Panel title="Running balance" badge={actorName}>
        {balances.map((item) => <SummaryRow key={item.currency} label={item.currency} value={`${item.minor >= 0 ? "+" : "-"}${compactAmount(item.currency, majorFromMinor(Math.abs(item.minor), item.currency))}`} strong />)}
      </Panel>
      <ScrollView horizontal showsHorizontalScrollIndicator>
        <View style={styles.ledgerTable}>
          <View style={[styles.ledgerRow, styles.ledgerHead]}><Text style={styles.colDate}>Date</Text><Text style={styles.colRef}>Journal / No.</Text><Text style={styles.colDirection}>Type</Text><Text style={styles.colAmount}>Amount</Text><Text style={styles.colDetails}>Details</Text></View>
          {lines.map((line, index) => <View key={`${line.journal}-${index}`} style={styles.ledgerRow}><Text style={styles.colDate}>{line.postedAt ? new Date(line.postedAt).toLocaleDateString() : "-"}</Text><Text style={styles.colRef}>{String(line.journal || line.orderId || line.transferId || "-")}</Text><Text style={styles.colDirection}>{line.direction}</Text><Text style={styles.colAmount}>{compactAmount(line.currency, majorFromMinor(line.amountMinor, line.currency))}</Text><Text style={styles.colDetails} numberOfLines={3}>{String(line.details || line.source || "")}</Text></View>)}
        </View>
      </ScrollView>
      {isMasterView(session) ? (
        <Panel title="Income statement" badge="USD total">
          {incomeOrders.map((order) => <View key={`income-${order.id}`} style={styles.recordRow}><Text style={styles.primaryLine}>{order.brokerOrderNumber || order.id}</Text><Text style={styles.muted}>Base USD {majorFromMinor(Number(order.incomeBaseAmountMinor || 0), "USD").toFixed(2)} | Collected EUR {majorFromMinor(Number(order.incomeCollectedEurMinor || 0), "EUR").toFixed(2)} | Collected USD {majorFromMinor(Number(order.incomeCollectedUsdMinor || 0), "USD").toFixed(2)}</Text><Text style={styles.amountLine}>Profit {compactAmount("USD", majorFromMinor(Number(order.incomeProfitMinor || 0), "USD"))}</Text></View>)}
          <SummaryRow label="Total profit" value={compactAmount("USD", majorFromMinor(totalIncomeUsdMinor, "USD"))} strong />
        </Panel>
      ) : null}
    </View>
  );
}

export function ActorsScreen({ state, offline, onState }: CommonProps) {
  const [name, setName] = useState("");
  const [role, setRole] = useState<ActorRole>("Broker");
  const [currency, setCurrency] = useState<Currency>("USD");
  const [working, setWorking] = useState<Currency[]>([]);
  const [busy, setBusy] = useState("");
  const roles: ActorRole[] = ["Broker", "Agent", "Special Broker", "Special Agent"];
  const run = async (id: string, task: () => Promise<WorkspaceState>) => { if (offline) return Alert.alert("Offline", "Reconnect before changing actors."); setBusy(id); try { onState(await task()); } catch (error) { Alert.alert("Actors", errorMessage(error)); } finally { setBusy(""); } };
  return <View style={styles.screen}><ScreenTitle title="Actors" subtitle="Create and manage workspace actors" /><OfflineGuard offline={offline} /><Panel title="Create managed actor" badge="No login"><Field label="Actor name" value={name} onChangeText={setName} /><SelectRow label="Role" options={roles} value={role} onChange={setRole} /><SelectRow label="Base currency" options={supportedCurrencies} value={currency} onChange={setCurrency} />{["Special Broker", "Special Agent"].includes(role) ? <><Text style={styles.fieldLabel}>Working currencies</Text><View style={styles.choiceWrap}>{supportedCurrencies.map((item) => <Pressable key={item} onPress={() => setWorking((current) => current.includes(item) ? current.filter((value) => value !== item) : [...current, item])} style={[styles.choice, working.includes(item) && styles.choiceActive]}><Text style={[styles.choiceText, working.includes(item) && styles.choiceTextActive]}>{item}</Text></Pressable>)}</View></> : null}<Button label="Create actor" icon={<UserPlus size={17} color="#fff" />} loading={busy === "create"} disabled={offline} onPress={() => run("create", async () => { const next = await createManagedActor({ name, role, currency, workingCurrencies: working }); setName(""); return next; })} /></Panel><Panel title="Active actors" badge={String(activeActors(state).length - 1)}>{activeActors(state).filter((actor) => actor.role !== "Master").map((actor) => <View key={actor.id} style={styles.recordRow}><View style={styles.recordMain}><Text style={styles.primaryLine}>{actor.name}</Text><Text style={styles.muted}>{actor.role} - {actor.currency}{actor.managedByMaster ? " - Master managed" : ""}</Text></View><Button label="Remove" variant="danger" disabled={offline} loading={busy === actor.id} onPress={() => Alert.alert("Remove actor?", "The actor will be hidden and its transaction history will remain.", [{ text: "Cancel", style: "cancel" }, { text: "Remove", style: "destructive", onPress: () => run(actor.id, () => removeWorkspaceActor(actor.id, actor.name)) }])} /></View>)}</Panel></View>;
}

export function SettingsScreen({ session, state, offline, onState }: CommonProps) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState("");
  const [invites, setInvites] = useState<InviteRecord[]>([]);
  const [inviteRole, setInviteRole] = useState<ActorRole>("Broker");
  const [inviteCurrency, setInviteCurrency] = useState<Currency>("USD");
  const [buying, setBuying] = useState({
    eurToUsd: String(state.buyingRates?.eurToUsd || ""),
    usdToEtb: String(state.buyingRates?.usdToEtb || ""),
    usdToErn: String(state.buyingRates?.usdToErn || "")
  });
  const [statementRates, setStatementRates] = useState<Record<Currency, { enabled: boolean; divider: string; percent: string }>>(() => Object.fromEntries(supportedCurrencies.map((currency) => [currency, {
    enabled: state.masterRateDivisorSettings?.[currency]?.enabled === true,
    divider: String(state.masterRateDivisorSettings?.[currency]?.divider || ""),
    percent: String(state.masterRateDivisorSettings?.[currency]?.percent || "")
  }])) as Record<Currency, { enabled: boolean; divider: string; percent: string }>);
  const [resetPermit, setResetPermit] = useState("");
  const [resetScope, setResetScope] = useState<"data" | "wipe">("data");
  const master = isMasterView(session);
  const change = async () => { if (offline) return Alert.alert("Offline", "Reconnect before changing your password."); setBusy("password"); try { await changePassword(currentPassword, newPassword); setCurrentPassword(""); setNewPassword(""); Alert.alert("Password updated", "Your new password is ready."); } catch (error) { Alert.alert("Password", errorMessage(error)); } finally { setBusy(""); } };
  const setMode = async (actorId: string, mode: ActorRecord["transferMode"]) => { if (offline) return Alert.alert("Offline", "Reconnect before changing permissions."); setBusy(actorId); try { onState(await updateActorTransferMode(actorId, mode)); } catch (error) { Alert.alert("Permissions", errorMessage(error)); } finally { setBusy(""); } };
  const refreshInvites = async () => { setBusy("invites"); try { setInvites(await loadInvites()); } catch (error) { Alert.alert("Invite codes", errorMessage(error)); } finally { setBusy(""); } };
  const addInvite = async () => { if (offline) return Alert.alert("Offline", "Reconnect before creating an invite."); setBusy("invite-create"); try { await createInvite({ actorRole: inviteRole, currency: inviteCurrency, workingCurrencies: [inviteCurrency] }); await refreshInvites(); } catch (error) { Alert.alert("Invite codes", errorMessage(error)); } finally { setBusy(""); } };
  const saveRates = async () => { if (offline) return Alert.alert("Offline", "Reconnect before saving rates."); setBusy("buying"); try { onState(await updateBuyingRates({ eurToUsd: Number(buying.eurToUsd), usdToEtb: Number(buying.usdToEtb), usdToErn: Number(buying.usdToErn) })); } catch (error) { Alert.alert("Buying rates", errorMessage(error)); } finally { setBusy(""); } };
  const saveStatementRate = async (currency: Currency) => { if (offline) return Alert.alert("Offline", "Reconnect before saving rates."); setBusy(`rate-${currency}`); const draft = statementRates[currency]; try { onState(await updateMasterRateSetting(currency, { enabled: draft.enabled, divider: Number(draft.divider), percent: Number(draft.percent) })); } catch (error) { Alert.alert("Income statement rate", errorMessage(error)); } finally { setBusy(""); } };
  const updateActor = async (actorId: string, input: Parameters<typeof updateActorOrderSettings>[1]) => { if (offline) return Alert.alert("Offline", "Reconnect before changing permissions."); setBusy(actorId); try { onState(await updateActorOrderSettings(actorId, input)); } catch (error) { Alert.alert("Permissions", errorMessage(error)); } finally { setBusy(""); } };
  const reset = () => {
    if (resetPermit !== "MASTER-RESET") return Alert.alert("Master reset", "Enter MASTER-RESET to continue.");
    Alert.alert(resetScope === "wipe" ? "Wipe all workspace data?" : "Erase financial data?", resetScope === "wipe" ? "This removes data, actors, actor accounts, and invite codes." : "This erases financial records but keeps actors.", [
      { text: "Cancel", style: "cancel" },
      { text: resetScope === "wipe" ? "Wipe" : "Erase", style: "destructive", onPress: async () => { setBusy("reset"); try { onState(await resetWorkspaceData(resetScope)); setResetPermit(""); } catch (error) { Alert.alert("Master reset", errorMessage(error)); } finally { setBusy(""); } } }
    ]);
  };
  const roles: ActorRole[] = ["Broker", "Agent", "Special Broker", "Special Agent"];
  return (
    <View style={styles.screen}>
      <ScreenTitle title="Settings" subtitle="Account and workspace permissions" />
      <OfflineGuard offline={offline} />
      <Panel title="Reset password"><Field label="Current password" value={currentPassword} onChangeText={setCurrentPassword} secureTextEntry /><Field label="New password" value={newPassword} onChangeText={setNewPassword} secureTextEntry /><Button label="Update password" loading={busy === "password"} disabled={offline} onPress={change} /></Panel>
      {master ? <>
        <Panel title="Buying rates" badge="Income statement"><Field label="EUR to USD" value={buying.eurToUsd} onChangeText={(value) => setBuying({ ...buying, eurToUsd: value })} keyboardType="decimal-pad" /><Field label="USD to ETB" value={buying.usdToEtb} onChangeText={(value) => setBuying({ ...buying, usdToEtb: value })} keyboardType="decimal-pad" /><Field label="USD to ERN" value={buying.usdToErn} onChangeText={(value) => setBuying({ ...buying, usdToErn: value })} keyboardType="decimal-pad" /><Button label="Save buying rates" loading={busy === "buying"} disabled={offline} onPress={saveRates} /></Panel>
        <Panel title="Income statement rates" badge="Future orders only">{supportedCurrencies.map((currency) => { const draft = statementRates[currency]; return <View key={currency} style={styles.permissionRow}><ToggleChoice label={`${currency} rate enabled`} checked={draft.enabled} disabled={offline} onPress={() => setStatementRates({ ...statementRates, [currency]: { ...draft, enabled: !draft.enabled } })} /><Field label={`${currency} divisor`} value={draft.divider} onChangeText={(value) => setStatementRates({ ...statementRates, [currency]: { ...draft, divider: value } })} keyboardType="decimal-pad" /><Field label="Percent" value={draft.percent} onChangeText={(value) => setStatementRates({ ...statementRates, [currency]: { ...draft, percent: value } })} keyboardType="decimal-pad" /><Button label={`Save ${currency}`} variant="secondary" loading={busy === `rate-${currency}`} disabled={offline} onPress={() => saveStatementRate(currency)} /></View>; })}</Panel>
        <Panel title="Actor permissions" badge="Orders and transfers">{activeActors(state).filter((actor) => actor.role !== "Master").map((actor) => { const visibility = actor.orderVisibilityPermissions || {}; return <View key={actor.id} style={styles.permissionRow}><Text style={styles.primaryLine}>{actor.name} - {actor.role}</Text><SelectRow label="Transfer access" options={["actor", "master", "both", "none"]} value={actor.transferMode || "master"} onChange={(mode) => setMode(actor.id, mode)} />{["Broker", "Special Broker"].includes(actor.role) ? <ToggleChoice label="Multi-currency orders" checked={actor.orderMultiCurrencyEnabled === true} disabled={offline || busy === actor.id} onPress={() => updateActor(actor.id, { orderMultiCurrencyEnabled: actor.orderMultiCurrencyEnabled !== true })} /> : null}{["Agent", "Special Agent", "Special Broker"].includes(actor.role) ? <View style={styles.choiceWrap}>{([['sourceCurrency', 'Source currency'], ['rate', 'Rate'], ['commission', 'Commission'], ['baseAmount', 'Base currency and amount']] as const).map(([key, label]) => <ToggleChoice key={key} label={label} checked={visibility[key] !== false} disabled={offline || busy === actor.id} onPress={() => updateActor(actor.id, { visibility: { [key]: visibility[key] === false } })} />)}</View> : null}</View>; })}</Panel>
        <Panel title="Invite codes"><View style={styles.rowButtons}><Button label="Load codes" variant="secondary" icon={<RefreshCw size={17} color={colors.ink} />} loading={busy === "invites"} onPress={refreshInvites} style={styles.flexButton} /><Button label="New code" icon={<Plus size={17} color="#fff" />} loading={busy === "invite-create"} onPress={addInvite} style={styles.flexButton} /></View><SelectRow label="Role" options={roles} value={inviteRole} onChange={setInviteRole} /><SelectRow label="Base currency" options={supportedCurrencies} value={inviteCurrency} onChange={setInviteCurrency} />{invites.map((invite) => <SummaryRow key={invite.id || invite.code} label={`${invite.actorRole} - ${invite.currency}`} value={invite.code || "Used"} strong />)}</Panel>
        <Panel title="Master reset" badge="Permanent"><Field label="Permit phrase" value={resetPermit} onChangeText={setResetPermit} autoCapitalize="characters" placeholder="MASTER-RESET" /><SelectRow label="Reset scope" options={["data", "wipe"]} value={resetScope} onChange={setResetScope} /><Text style={styles.muted}>{resetScope === "wipe" ? "Wipe data and all linked actors." : "Erase financial data and keep actors."}</Text><Button label={resetScope === "wipe" ? "Wipe data and actors" : "Erase data"} variant="danger" loading={busy === "reset"} disabled={offline} onPress={reset} /></Panel>
      </> : null}
    </View>
  );
}

export function OwnerScreen({ offline }: { offline: boolean }) {
  const [users, setUsers] = useState<OwnerMasterRecord[]>([]);
  const [plans, setPlans] = useState<OwnerPlan[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [plan, setPlan] = useState("one_month");
  const [busy, setBusy] = useState("");
  const refresh = async () => {
    if (offline) return Alert.alert("Offline", "Subscription management needs an internet connection.");
    setBusy("refresh");
    try { const result = await loadOwnerMasters(); setUsers(result.users); setPlans(result.plans); if (!result.plans.some((item) => item.id === plan)) setPlan(result.plans[0]?.id || "one_month"); } catch (error) { Alert.alert("Owner console", errorMessage(error)); } finally { setBusy(""); }
  };
  useEffect(() => { if (!offline) void refresh(); }, [offline]);
  const create = async () => {
    if (offline) return Alert.alert("Offline", "Reconnect before creating a Master.");
    setBusy("create");
    try { await createOwnerMaster({ name, email, password, plan }); setName(""); setEmail(""); setPassword(""); await refresh(); } catch (error) { Alert.alert("Create Master", errorMessage(error)); } finally { setBusy(""); }
  };
  const change = async (id: string, task: () => Promise<void>) => {
    if (offline) return Alert.alert("Offline", "Reconnect before changing subscriptions.");
    setBusy(id);
    try { await task(); await refresh(); } catch (error) { Alert.alert("Subscription", errorMessage(error)); } finally { setBusy(""); }
  };
  return <View style={styles.screen}><ScreenTitle title="Owner" subtitle="Create Masters and manage access" /><OfflineGuard offline={offline} /><Button label="Refresh subscriptions" icon={<RefreshCw size={17} color={colors.ink} />} variant="secondary" loading={busy === "refresh"} onPress={refresh} /><Panel title="Create Master"><Field label="Master name" value={name} onChangeText={setName} /><Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" /><Field label="Password" value={password} onChangeText={setPassword} secureTextEntry /><Text style={styles.fieldLabel}>Subscription</Text><View style={styles.choiceWrap}>{(plans.length ? plans : [{ id: "one_month", label: "One month" }]).map((item) => <Pressable key={item.id} onPress={() => setPlan(item.id)} style={[styles.choice, plan === item.id && styles.choiceActive]}><Text style={[styles.choiceText, plan === item.id && styles.choiceTextActive]}>{item.label}</Text></Pressable>)}</View><Button label="Create Master" loading={busy === "create"} disabled={offline} onPress={create} /></Panel><Panel title="Master subscriptions" badge={String(users.length)}>{users.map((user) => <View key={user.userId} style={styles.recordRow}><View style={styles.recordMain}><Text style={styles.primaryLine}>{user.name}</Text><Text style={styles.muted}>{user.email} - {user.workspace}</Text><Text style={styles.muted}>{user.active ? (user.expired ? "Expired" : "Active") : "Inactive"} - {new Date(user.expiresAt || 0).toLocaleDateString()}</Text></View><View style={styles.rowButtons}><Button label={user.active ? "Deactivate" : "Activate"} variant={user.active ? "danger" : "secondary"} disabled={offline} loading={busy === `active-${user.userId}`} onPress={() => change(`active-${user.userId}`, () => setOwnerMasterActive(user.userId, !user.active))} style={styles.flexButton} /><Button label="Add time" disabled={offline} loading={busy === `extend-${user.userId}`} onPress={() => change(`extend-${user.userId}`, () => extendOwnerSubscription(user.userId, user.plan || plan, "extend"))} style={styles.flexButton} /><Button label="Restart" variant="secondary" disabled={offline} loading={busy === `reset-${user.userId}`} onPress={() => change(`reset-${user.userId}`, () => extendOwnerSubscription(user.userId, user.plan || plan, "reset"))} style={styles.flexButton} /></View></View>)}</Panel></View>;
}

export function NotificationsPanel({ session, state, onNavigate }: { session: UserSession; state: WorkspaceState; onNavigate: (screen: AppScreen) => void }) {
  const pendingOrders = isMasterView(session) ? state.orders.filter((order) => order.state === "Pending Forward" || order.state === "Void Requested").length : state.orders.filter((order) => order.state === "Assigned" && (order.agentActorId === session.actorId || order.agent === session.actorName)).length;
  const pendingTransfers = isMasterView(session) ? state.transfers.filter((transfer) => transfer.state === "Pending Approval").length : 0;
  if (!pendingOrders && !pendingTransfers) return null;
  return <Panel title="Action required" badge={String(pendingOrders + pendingTransfers)}>{pendingOrders ? <Pressable style={styles.noticeRow} onPress={() => onNavigate("orders")}><MessageSquare size={18} color={colors.warn} /><Text style={styles.noticeText}>{pendingOrders} order action{pendingOrders === 1 ? "" : "s"} pending</Text></Pressable> : null}{pendingTransfers ? <Pressable style={styles.noticeRow} onPress={() => onNavigate("transfers")}><MessageSquare size={18} color={colors.warn} /><Text style={styles.noticeText}>{pendingTransfers} transfer approval{pendingTransfers === 1 ? "" : "s"} pending</Text></Pressable> : null}</Panel>;
}

const styles = StyleSheet.create({
  screen: { gap: spacing.lg },
  titleWrap: { gap: 3 },
  title: { color: colors.ink, fontSize: 25, fontWeight: "900" },
  subtitle: { color: colors.muted, fontSize: 13 },
  offlineText: { color: colors.warn, fontWeight: "800", backgroundColor: colors.warnSoft, borderRadius: radius.md, padding: spacing.md },
  muted: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  primaryLine: { color: colors.ink, fontWeight: "900", flexShrink: 1 },
  amountLine: { color: colors.accent, fontSize: 17, fontWeight: "900" },
  showMore: { minHeight: 38, borderTopWidth: 1, borderTopColor: colors.line, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  linkText: { color: colors.accent, fontWeight: "900" },
  detailBlock: { gap: 0 },
  actionBlock: { gap: spacing.md, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: spacing.md },
  rowButtons: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  flexButton: { flex: 1, minWidth: 100 },
  fieldLabel: { color: colors.muted, fontSize: 12, fontWeight: "800" },
  choiceWrap: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  choice: { minHeight: 38, paddingHorizontal: spacing.md, justifyContent: "center", borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, backgroundColor: colors.panel },
  choiceActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  choiceText: { color: colors.muted, fontWeight: "800" },
  choiceTextActive: { color: colors.accent },
  twoColumns: { gap: spacing.md },
  recordRow: { gap: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.line, paddingVertical: spacing.sm },
  recordMain: { gap: 3 },
  chatTabs: { gap: spacing.sm, paddingBottom: 2 },
  messages: { gap: spacing.sm },
  message: { alignSelf: "flex-start", maxWidth: "88%", borderRadius: radius.md, backgroundColor: colors.panel2, padding: spacing.md, gap: 2 },
  myMessage: { alignSelf: "flex-end", backgroundColor: colors.accentSoft },
  messageFrom: { color: colors.accent, fontSize: 11, fontWeight: "900" },
  messageText: { color: colors.ink, lineHeight: 20 },
  messageTime: { color: colors.muted, fontSize: 10 },
  ledgerTable: { minWidth: 940, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, overflow: "hidden" },
  ledgerRow: { minHeight: 62, flexDirection: "row", alignItems: "center", borderBottomWidth: 1, borderBottomColor: colors.line, backgroundColor: colors.panel },
  ledgerHead: { minHeight: 48, backgroundColor: colors.panel2 },
  colDate: { width: 95, padding: spacing.sm, color: colors.ink },
  colRef: { width: 130, padding: spacing.sm, color: colors.ink, fontWeight: "800" },
  colDirection: { width: 90, padding: spacing.sm, color: colors.ink },
  colAmount: { width: 135, padding: spacing.sm, color: colors.ink, fontWeight: "900" },
  colDetails: { width: 470, padding: spacing.sm, color: colors.muted },
  permissionRow: { gap: spacing.sm, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.line },
  toggleRow: { minHeight: 38, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: 3 },
  disabled: { opacity: 0.5 },
  checkBox: { width: 22, height: 22, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.panel, alignItems: "center", justifyContent: "center" },
  checkBoxActive: { borderColor: colors.accent, backgroundColor: colors.accent },
  toggleLabel: { color: colors.ink, fontWeight: "800", flexShrink: 1 },
  noticeRow: { minHeight: 42, flexDirection: "row", alignItems: "center", gap: spacing.sm },
  noticeText: { color: colors.ink, fontWeight: "800" }
});
