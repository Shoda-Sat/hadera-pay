import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";
import * as ImageManipulator from "expo-image-manipulator";
import * as Sharing from "expo-sharing";
import React, { useEffect, useRef, useState } from "react";
import { Alert, Image, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from "react-native";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Forward as ForwardIcon,
  Heart,
  MessageSquare,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Reply,
  Send,
  Share2,
  ThumbsUp,
  Trash2,
  UserPlus,
  X
} from "lucide-react-native";
import {
  allowedIdleTimeoutSeconds,
  changePassword,
  createOwnerMaster,
  createInvite,
  extendOwnerSubscription,
  loadOwnerMasters,
  loadInvites,
  removeWorkspaceActor,
  resetWorkspaceActorData,
  resetWorkspaceData,
  setOwnerMasterActive,
  updateIdleTimeout
} from "../api/client";
import { Button, Field, Panel, Pill, SelectRow, SummaryRow, type PillTone } from "../components/ui";
import {
  activeActors,
  actorCanPayoutCurrency,
  actorCanReceivePayouts,
  actorForSession,
  actorTransferCurrencies,
  actorTransferReceiveCurrencies,
  approveOrderVoid,
  assignOrder,
  cancelOrder,
  calculableLedgerLines,
  collectReceivable,
  createChatGroup,
  createInternalTransfer,
  createManagedActor,
  deleteChatGroup,
  forwardChatMessage,
  forwardInternalTransfer,
  fundMasterBankAccount,
  isMasterView,
  ledgerLineIsForVoidedOrder,
  markOrderPaid,
  masterBankEntriesWithRunningBalances,
  postActorJournal,
  postActorWithdrawal,
  pendingCancelledOrderStates,
  orderRecordIsVoided,
  orderSortForSession,
  receivableBalance,
  reactToChatMessage,
  remindOrderActor,
  rejectOrderVoid,
  requestOrderVoid,
  respondToForwardedTransfer,
  returnOrder,
  sendChatMessage,
  setTransferState,
  supportedCurrencies,
  transferTargetsFor,
  updateActorOrderSettings,
  updateActorTransferMode,
  updateBuyingRates,
  updateMasterRateSetting,
  updateUsdAgentIncomeRate,
  visibleChatsFor
} from "../domain/workspace";
import { colors, radius, spacing } from "../theme";
import type {
  ActorRecord,
  ActorRole,
  AppScreen,
  ChatMessageRecord,
  Currency,
  InternalTransferDraft,
  InternalTransferForwardDraft,
  InviteRecord,
  OrderRecord,
  OwnerMasterRecord,
  OwnerPlan,
  PreparedPaymentProof,
  UserSession,
  WorkspaceState
} from "../types";
import { compactAmount, inputAmount, majorFromMinor, parseAmount, reconcileOrderConversion } from "../utils/money";
import type { OrderConversionField } from "../utils/money";

type CommonProps = {
  session: UserSession;
  state: WorkspaceState;
  offline: boolean;
  onState: (state: WorkspaceState) => void;
  onNavigate: (screen: AppScreen) => void;
  onRefresh: () => void;
  onScrollToEnd?: () => void;
  onSessionTimeout?: (session: UserSession) => void;
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
  if (["Assigned", "Pending Forward", "Pending Approval", "Pending Acceptance", "Void Requested", "Returned"].includes(value)) return "warn";
  return "neutral";
}

function orderStatusTone(state: OrderRecord["state"]): PillTone {
  if (state === "Assigned") return "assigned";
  if (state === "Returned") return "returned";
  if (state === "Cancelled") return "cancelled";
  if (state === "Voided") return "voided";
  return tone(state);
}

function orderNumber(order: OrderRecord, session: UserSession): string {
  const payer = order.agent === session.actorName || order.agentActorId === session.actorId;
  if (payer && ["Agent", "Special Agent", "Special Broker"].includes(session.actorRole)) {
    return order.agentOrderNumbers?.[session.actorName] || order.agentOrderNumber || order.brokerOrderNumber || order.id;
  }
  return order.brokerOrderNumber || order.id;
}

const paymentProofImageTargetBytes = 1024 * 1024;
const maxPaymentProofImageSourceBytes = 24 * 1024 * 1024;
const maxPaymentProofDocumentBytes = 8 * 1024 * 1024;
const paymentProofMimeTypes = [
  "image/jpeg",
  "image/png",
  "application/pdf",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
];

function paymentProofKind(name: string, mimeType = ""): "image" | "document" | "" {
  const extension = name.toLowerCase().match(/\.[^.]+$/)?.[0] || "";
  const mime = mimeType.toLowerCase();
  if ([".jpg", ".jpeg", ".png"].includes(extension) || ["image/jpeg", "image/png"].includes(mime)) return "image";
  if ([".pdf", ".xls", ".xlsx"].includes(extension) || paymentProofMimeTypes.slice(2).includes(mime)) return "document";
  return "";
}

function paymentProofMimeType(name: string, mimeType = ""): string {
  if (mimeType && mimeType !== "application/octet-stream") return mimeType;
  const extension = name.toLowerCase().match(/\.[^.]+$/)?.[0] || "";
  if ([".jpg", ".jpeg"].includes(extension)) return "image/jpeg";
  if (extension === ".png") return "image/png";
  if (extension === ".pdf") return "application/pdf";
  if (extension === ".xls") return "application/vnd.ms-excel";
  if (extension === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return "application/octet-stream";
}

function safePaymentProofName(order: OrderRecord, session: UserSession, originalName: string, compressed: boolean): string {
  const displayNumber = orderNumber(order, session).replace(/[^a-z0-9_-]+/gi, "-");
  let name = (originalName || "payment-proof").trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+/, "") || "payment-proof";
  if (compressed) name = `${name.replace(/\.[^.]+$/, "") || "payment-proof"}.jpg`;
  return name.toLowerCase().startsWith(`${displayNumber.toLowerCase()}-`) ? name : `${displayNumber}-${name}`;
}

function base64ByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(base64.length * 3 / 4) - padding);
}

function imageDimensions(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    Image.getSize(uri, (width, height) => resolve({ width, height }), () => reject(new Error("The selected image could not be opened.")));
  });
}

async function paymentProofAssetSize(asset: DocumentPicker.DocumentPickerAsset): Promise<number> {
  if (Number.isFinite(Number(asset.size)) && Number(asset.size) > 0) return Number(asset.size);
  const info = await FileSystem.getInfoAsync(asset.uri);
  return info.exists && "size" in info ? Number(info.size || 0) : 0;
}

async function compressPaymentProofImage(asset: DocumentPicker.DocumentPickerAsset, onStatus: (status: string) => void): Promise<string> {
  const dimensions = await imageDimensions(asset.uri);
  let width = dimensions.width;
  let height = dimensions.height;
  const largestSide = Math.max(width, height);
  if (largestSide > 2200) {
    const scale = 2200 / largestSide;
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }
  let quality = 0.84;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    onStatus(`Compressing image ${Math.min(95, Math.round((attempt + 1) / 12 * 100))}%`);
    const result = await ImageManipulator.manipulateAsync(
      asset.uri,
      [{ resize: { width, height } }],
      { compress: quality, format: ImageManipulator.SaveFormat.JPEG, base64: true }
    );
    if (!result.base64) throw new Error("The selected image could not be compressed.");
    if (base64ByteLength(result.base64) <= paymentProofImageTargetBytes) return result.base64;
    if (quality > 0.48) quality = Math.max(0.48, quality - 0.12);
    else {
      width = Math.max(1, Math.round(width * 0.8));
      height = Math.max(1, Math.round(height * 0.8));
      quality = 0.72;
    }
  }
  throw new Error("The image could not be compressed below 1 MB. Choose a smaller image.");
}

async function preparePaymentProof(
  order: OrderRecord,
  session: UserSession,
  asset: DocumentPicker.DocumentPickerAsset,
  onStatus: (status: string) => void
): Promise<PreparedPaymentProof> {
  const kind = paymentProofKind(asset.name, asset.mimeType || "");
  if (!kind) throw new Error("Attach a JPG, JPEG, PNG, PDF, XLS, or XLSX file.");
  const size = await paymentProofAssetSize(asset);
  if (kind === "image" && size > maxPaymentProofImageSourceBytes) throw new Error("Choose an image under 24 MB.");
  if (kind === "document" && size > maxPaymentProofDocumentBytes) throw new Error("Choose a PDF or Excel file under 8 MB.");
  const shouldCompress = kind === "image" && size > paymentProofImageTargetBytes;
  onStatus(shouldCompress ? "Compressing image..." : "Preparing attachment...");
  const base64 = shouldCompress
    ? await compressPaymentProofImage(asset, onStatus)
    : await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
  if (!base64) throw new Error("The selected file could not be prepared.");
  if (kind === "document" && base64ByteLength(base64) > maxPaymentProofDocumentBytes) throw new Error("Choose a PDF or Excel file under 8 MB.");
  return {
    dataUri: `data:${shouldCompress ? "image/jpeg" : paymentProofMimeType(asset.name, asset.mimeType || "")};base64,${base64}`,
    fileName: safePaymentProofName(order, session, asset.name, shouldCompress),
    mediaType: kind,
    mimeType: shouldCompress ? "image/jpeg" : paymentProofMimeType(asset.name, asset.mimeType || ""),
    orderNumber: orderNumber(order, session),
    compressed: shouldCompress
  };
}

function visibleOrders(session: UserSession, state: WorkspaceState): OrderRecord[] {
  return state.orders
    .filter((order) => isMasterView(session) || order.broker === session.actorName || order.agent === session.actorName || order.agentActorId === session.actorId)
    .filter((order) => isMasterView(session) || (!["Cancelled", "Voided"].includes(order.state) && order.locked !== true))
    .slice()
    .sort(orderSortForSession(session));
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
  const [proofs, setProofs] = useState<Record<string, PreparedPaymentProof>>({});
  const [proofStatus, setProofStatus] = useState<Record<string, string>>({});
  const [preparingProof, setPreparingProof] = useState("");
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

  const chooseProof = async (order: OrderRecord) => {
    if (offline) return Alert.alert("Offline", "Reconnect before attaching a payment file.");
    setPreparingProof(order.id);
    setProofStatus((current) => ({ ...current, [order.id]: "Choose a payment file" }));
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: paymentProofMimeTypes,
        copyToCacheDirectory: true,
        multiple: false
      });
      if (result.canceled) {
        setProofStatus((current) => ({ ...current, [order.id]: current[order.id] === "Choose a payment file" ? "" : current[order.id] }));
        return;
      }
      const proof = await preparePaymentProof(order, session, result.assets[0], (status) => {
        setProofStatus((current) => ({ ...current, [order.id]: status }));
      });
      setProofs((current) => ({ ...current, [order.id]: proof }));
      setProofStatus((current) => ({
        ...current,
        [order.id]: `${proof.compressed ? "Compressed and ready" : "File ready"}: ${proof.fileName}`
      }));
    } catch (error) {
      setProofs((current) => {
        const next = { ...current };
        delete next[order.id];
        return next;
      });
      setProofStatus((current) => ({ ...current, [order.id]: "Attachment failed" }));
      Alert.alert("Attachment", errorMessage(error));
    } finally {
      setPreparingProof("");
    }
  };

  const confirmPaid = (order: OrderRecord) => {
    if (preparingProof === order.id) return Alert.alert("Attachment", "Wait until the payment file is ready.");
    Alert.alert("Mark as paid?", `Post ${orderNumber(order, session)} to the ledger now?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Mark Paid",
        onPress: () => run(`paid-${order.id}`, async () => {
          const next = await markOrderPaid(order.id, session.actorId, proofs[order.id]);
          setProofs((current) => {
            const updated = { ...current };
            delete updated[order.id];
            return updated;
          });
          setProofStatus((current) => ({ ...current, [order.id]: "" }));
          return next;
        })
      }
    ]);
  };

  const confirmReturn = (order: OrderRecord) => {
    const destination = isMasterView(session) ? order.broker : "Master";
    Alert.alert("Return order?", `Return ${orderNumber(order, session)} to ${destination}?`, [
      { text: "Keep order", style: "cancel" },
      { text: "Return", onPress: () => run(`return-${order.id}`, () => returnOrder(order.id, session.actorName)) }
    ]);
  };

  const confirmCancel = (order: OrderRecord) => {
    Alert.alert("Cancel order?", `${orderNumber(order, session)} will not be forwarded.`, [
      { text: "Keep order", style: "cancel" },
      { text: "Cancel order", style: "destructive", onPress: () => run(`cancel-${order.id}`, () => cancelOrder(order.id)) }
    ]);
  };

  const confirmVoidRequest = (order: OrderRecord) => {
    Alert.alert("Request void?", `Send ${orderNumber(order, session)} to Master for void approval?`, [
      { text: "Keep paid", style: "cancel" },
      { text: "Request Void", style: "destructive", onPress: () => run(`void-${order.id}`, () => requestOrderVoid(order.id, session.actorName)) }
    ]);
  };

  const confirmVoidDecision = (order: OrderRecord, approve: boolean) => {
    Alert.alert(
      approve ? "Approve void?" : "Reject void?",
      approve
        ? `${orderNumber(order, session)} will be excluded from Ledger, Income Statement, Settlement, and Report calculations.`
        : `${orderNumber(order, session)} will remain Paid and counted normally.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: approve ? "Approve void" : "Reject void",
          style: approve ? "destructive" : "default",
          onPress: () => run(`${approve ? "approve" : "reject"}-void-${order.id}`, () =>
            approve ? approveOrderVoid(order.id, session.actorName) : rejectOrderVoid(order.id, session.actorName)
          )
        }
      ]
    );
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
          <Panel key={order.id} title={orderNumber(order, session)} badge={stateLabel} badgeTone={orderStatusTone(order.state)}>
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
                {order.receiverCity ? <SummaryRow label="Receiver city" value={order.receiverCity} /> : null}
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
                  <Button label="Return" variant="secondary" disabled={offline} onPress={() => confirmReturn(order)} style={styles.flexButton} />
                  <Button label="Cancel" variant="danger" disabled={offline} onPress={() => confirmCancel(order)} style={styles.flexButton} />
                </View>
              </View>
            ) : null}
            {isPayer && order.state === "Assigned" ? (
              <View style={styles.actionBlock}>
                <Button
                  label={proofs[order.id] ? "Attachment ready" : "Attach payment file"}
                  variant="secondary"
                  icon={proofs[order.id] ? <Check size={17} color={colors.good} /> : <Paperclip size={17} color={colors.ink} />}
                  loading={preparingProof === order.id}
                  onPress={() => chooseProof(order)}
                  disabled={offline || busy !== "" || Boolean(preparingProof)}
                />
                {proofStatus[order.id] ? <Text style={styles.muted}>{proofStatus[order.id]}</Text> : null}
                <View style={styles.rowButtons}>
                  <Button label="Return" variant="secondary" disabled={offline || busy !== "" || Boolean(preparingProof)} onPress={() => confirmReturn(order)} style={styles.flexButton} />
                  <Button label={busy === `paid-${order.id}` ? "Uploading and posting..." : "Mark as Paid"} loading={busy === `paid-${order.id}`} disabled={offline || busy !== "" || Boolean(preparingProof)} onPress={() => confirmPaid(order)} style={styles.flexButton} />
                </View>
              </View>
            ) : null}
            {isPayer && order.state === "Paid" ? <Button label="Request Void" variant="danger" disabled={offline} onPress={() => confirmVoidRequest(order)} /> : null}
            {["Broker", "Special Broker"].includes(session.actorRole) && order.state === "Returned" && order.broker === session.actorName ? <Button label="Modify returned order" icon={<Pencil size={17} color={colors.ink} />} variant="secondary" onPress={() => onEditReturnedOrder(order)} /> : null}
            {isMasterView(session) && order.state === "Void Requested" ? (
              <View style={styles.rowButtons}>
                <Button label="Approve void" variant="danger" disabled={offline} onPress={() => confirmVoidDecision(order, true)} style={styles.flexButton} />
                <Button label="Reject" variant="secondary" disabled={offline} onPress={() => confirmVoidDecision(order, false)} style={styles.flexButton} />
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
          <Panel key={order.id} title={orderNumber(order, session)} badge={stateLabel} badgeTone={orderStatusTone(order.state)}>
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
  const conversionTouches = useRef<OrderConversionField[]>([]);
  const [busy, setBusy] = useState(false);
  const [journal, setJournal] = useState({ actorId: "", sourceCurrency: "USD" as Currency, sourceAmount: "", currency: "USD" as Currency, amount: "", rate: "1", remarks: "" });
  const targets = transferTargetsFor(session, state);
  const receivingActor = targets.find((target) => target.id === draft.toActorId);
  const payoutCurrencies = actorTransferReceiveCurrencies(receivingActor);
  const transfers = state.transfers.filter((item) => isMasterView(session) || item.from === session.actorName || item.to === session.actorName);
  const master = isMasterView(session);
  const masterActor = activeActors(state).find((item) => item.role === "Master");
  const [forwardingTransferId, setForwardingTransferId] = useState("");
  const [forwardDrafts, setForwardDrafts] = useState<Record<string, InternalTransferForwardDraft>>({});

  const run = async (task: () => Promise<WorkspaceState>) => {
    if (offline) return Alert.alert("Offline", "Reconnect before making this change.");
    setBusy(true);
    try { onState(await task()); } catch (error) { Alert.alert("Could not continue", errorMessage(error)); } finally { setBusy(false); }
  };

  const setConversionField = (key: OrderConversionField, value: string) => {
    conversionTouches.current = [...conversionTouches.current.filter((field) => field !== key), key].slice(-2);
    setDraft((current) => reconcileOrderConversion({ ...current, [key]: value }, conversionTouches.current));
  };

  const selectReceivingActor = (target: ActorRecord) => {
    conversionTouches.current = [];
    const allowedCurrencies = actorTransferReceiveCurrencies(target);
    setDraft((current) => ({
      ...current,
      toActorId: target.id,
      payoutCurrency: allowedCurrencies.includes(current.payoutCurrency) ? current.payoutCurrency : allowedCurrencies[0] || target.currency
    }));
  };

  const transferArrivedAtMaster = (transfer: typeof transfers[number]) => Boolean(
    masterActor && (transfer.toActorId === masterActor.id || transfer.to === masterActor.name)
  );

  const forwardTargetsFor = (transfer: typeof transfers[number]) => activeActors(state).filter((candidate) =>
    candidate.role !== "Master" &&
    candidate.id !== transfer.fromActorId &&
    candidate.name !== transfer.from
  );

  const initialForwardDraft = (transfer: typeof transfers[number]): InternalTransferForwardDraft => {
    const target = forwardTargetsFor(transfer)[0];
    const allowed = actorTransferReceiveCurrencies(target);
    const payoutCurrency = allowed[0] || target?.currency || transfer.currency;
    const rate = Number(transfer.rate || 0) > 0 ? Number(transfer.rate) : 1;
    const sourceAmount = majorFromMinor(transfer.sourceAmountMinor, transfer.sourceCurrency);
    return {
      toActorId: target?.id || "",
      payoutCurrency,
      rate: String(rate),
      payoutAmount: inputAmount(payoutCurrency, sourceAmount * rate),
      commissionPercent: String(Number(transfer.commissionPercent || 0))
    };
  };

  const openForward = (transfer: typeof transfers[number]) => {
    setForwardDrafts((current) => ({ ...current, [transfer.id]: current[transfer.id] || initialForwardDraft(transfer) }));
    setForwardingTransferId((current) => current === transfer.id ? "" : transfer.id);
  };

  const updateForwardReceiver = (transfer: typeof transfers[number], target: ActorRecord) => {
    const allowed = actorTransferReceiveCurrencies(target);
    setForwardDrafts((current) => {
      const draft = current[transfer.id] || initialForwardDraft(transfer);
      return { ...current, [transfer.id]: { ...draft, toActorId: target.id, payoutCurrency: allowed.includes(draft.payoutCurrency) ? draft.payoutCurrency : allowed[0] || target.currency } };
    });
  };

  const updateForwardRate = (transfer: typeof transfers[number], value: string) => {
    setForwardDrafts((current) => {
      const draft = current[transfer.id] || initialForwardDraft(transfer);
      const payout = majorFromMinor(transfer.sourceAmountMinor, transfer.sourceCurrency) * Number(value || 0);
      return { ...current, [transfer.id]: { ...draft, rate: value, payoutAmount: Number(value || 0) > 0 ? inputAmount(draft.payoutCurrency, payout) : draft.payoutAmount } };
    });
  };

  const updateForwardPayout = (transfer: typeof transfers[number], value: string) => {
    setForwardDrafts((current) => {
      const draft = current[transfer.id] || initialForwardDraft(transfer);
      const source = majorFromMinor(transfer.sourceAmountMinor, transfer.sourceCurrency);
      const rate = source > 0 && parseAmount(value) > 0 ? parseAmount(value) / source : 0;
      return { ...current, [transfer.id]: { ...draft, payoutAmount: value, rate: rate > 0 ? String(Number(rate.toFixed(8))) : draft.rate } };
    });
  };

  const submitForward = (transfer: typeof transfers[number]) => {
    const draft = forwardDrafts[transfer.id] || initialForwardDraft(transfer);
    run(async () => {
      const next = await forwardInternalTransfer(session, transfer.id, draft);
      setForwardingTransferId("");
      setForwardDrafts((current) => {
        const updated = { ...current };
        delete updated[transfer.id];
        return updated;
      });
      return next;
    });
  };

  const respondToForward = (transfer: typeof transfers[number], accept: boolean) => {
    Alert.alert(
      accept ? "Accept transfer?" : "Reject transfer?",
      `${transfer.id} from ${transfer.from} will ${accept ? "post to your ledger" : "be rejected"}.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: accept ? "Accept" : "Reject", style: accept ? "default" : "destructive", onPress: () => run(() => respondToForwardedTransfer(session, transfer.id, accept)) }
      ]
    );
  };

  return (
    <View style={styles.screen}>
      <ScreenTitle title="Transfers" subtitle="Transfers, journals, and withdrawals" />
      <OfflineGuard offline={offline} />
      {master ? <SelectRow label="Action" options={["Transfer", "Journal", "Withdrawal"]} value={mode} onChange={setMode} /> : null}
      {mode === "Transfer" ? (
        <Panel title="New transfer" badge={master ? "Posts now" : "Needs approval"}>
          <Text style={styles.fieldLabel}>Receiving actor</Text>
          <View style={styles.choiceWrap}>{targets.map((target) => <Pressable key={target.id} onPress={() => selectReceivingActor(target)} style={[styles.choice, draft.toActorId === target.id && styles.choiceActive]}><Text style={[styles.choiceText, draft.toActorId === target.id && styles.choiceTextActive]}>{target.name}</Text></Pressable>)}</View>
          <SelectRow label="Source currency" options={currencies.length ? currencies : [session.currency]} value={draft.sourceCurrency} onChange={(value) => setDraft({ ...draft, sourceCurrency: value })} />
          <Field label="Source amount" value={draft.sourceAmount} onChangeText={(value) => setConversionField("sourceAmount", value)} keyboardType="decimal-pad" />
          <SelectRow label="Payout currency" options={payoutCurrencies.length ? payoutCurrencies : [draft.payoutCurrency]} value={draft.payoutCurrency} onChange={(value) => setDraft({ ...draft, payoutCurrency: value })} />
          <Field label="Rate" value={draft.rate} onChangeText={(value) => setConversionField("rate", value)} keyboardType="decimal-pad" />
          <Field label="Payout amount" value={draft.payoutAmount} onChangeText={(value) => setConversionField("payoutAmount", value)} keyboardType="decimal-pad" />
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
        {transfers.map((transfer) => {
          const pendingMaster = master && transfer.state === "Pending Approval";
          const canForward = pendingMaster && transferArrivedAtMaster(transfer) && transfer.from !== masterActor?.name;
          const receivingForward = !master && transfer.state === "Pending Acceptance" && (transfer.toActorId === session.actorId || transfer.to === session.actorName);
          const forwardOpen = canForward && forwardingTransferId === transfer.id;
          const forwardDraft = forwardDrafts[transfer.id] || initialForwardDraft(transfer);
          const forwardTargets = forwardTargetsFor(transfer);
          const forwardReceiver = forwardTargets.find((candidate) => candidate.id === forwardDraft.toActorId);
          const forwardCurrencies = actorTransferReceiveCurrencies(forwardReceiver);
          return (
            <View key={transfer.id} style={styles.recordRow}>
              <View style={styles.recordMain}>
                <Text style={styles.primaryLine}>{transfer.id}: {transfer.from} to {transfer.to}</Text>
                {transfer.forwardedAt && transfer.requestedTo ? <Text style={styles.muted}>Originally sent to {transfer.requestedTo}; forwarded by {transfer.forwardedBy || "Master"}</Text> : null}
                <Text style={styles.muted}>
                  {compactAmount(transfer.sourceCurrency, majorFromMinor(transfer.sourceAmountMinor, transfer.sourceCurrency))} to {compactAmount(transfer.currency, majorFromMinor(transfer.amountMinor, transfer.currency))}{transfer.remarks ? ` - ${transfer.remarks}` : ""}
                </Text>
              </View>
              <Pill label={transfer.state} tone={tone(transfer.state)} />
              {pendingMaster ? (
                <View style={styles.actionBlock}>
                  <View style={styles.rowButtons}>
                    <Button label={canForward ? "Approve to Master" : "Approve"} disabled={offline || busy} onPress={() => run(() => setTransferState(transfer.id, "approve", session.actorName))} style={styles.flexButton} />
                    {canForward ? <Button label={forwardOpen ? "Hide Forward" : "Forward"} variant="secondary" disabled={offline || busy} onPress={() => openForward(transfer)} style={styles.flexButton} /> : null}
                    <Button label="Return" variant="secondary" disabled={offline || busy} onPress={() => run(() => setTransferState(transfer.id, "return", session.actorName))} style={styles.flexButton} />
                    <Button label="Reject" variant="danger" disabled={offline || busy} onPress={() => run(() => setTransferState(transfer.id, "reject", session.actorName))} style={styles.flexButton} />
                  </View>
                  {forwardOpen ? (
                    <View style={styles.forwardTransferBlock}>
                      <SummaryRow label="Source" value={compactAmount(transfer.sourceCurrency, majorFromMinor(transfer.sourceAmountMinor, transfer.sourceCurrency))} />
                      <Text style={styles.fieldLabel}>Receiving Actor</Text>
                      <View style={styles.choiceWrap}>
                        {forwardTargets.map((target) => <Pressable key={target.id} onPress={() => updateForwardReceiver(transfer, target)} style={[styles.choice, forwardDraft.toActorId === target.id && styles.choiceActive]}><Text style={[styles.choiceText, forwardDraft.toActorId === target.id && styles.choiceTextActive]}>{target.name}</Text></Pressable>)}
                      </View>
                      <SelectRow label="Payout currency" options={forwardCurrencies.length ? forwardCurrencies : [forwardDraft.payoutCurrency]} value={forwardDraft.payoutCurrency} onChange={(value) => setForwardDrafts((current) => ({ ...current, [transfer.id]: { ...(current[transfer.id] || forwardDraft), payoutCurrency: value } }))} />
                      <Field label="Rate" value={forwardDraft.rate} onChangeText={(value) => updateForwardRate(transfer, value)} keyboardType="decimal-pad" />
                      <Field label="Payout amount" value={forwardDraft.payoutAmount} onChangeText={(value) => updateForwardPayout(transfer, value)} keyboardType="decimal-pad" />
                      <Field label="Percent (%)" value={forwardDraft.commissionPercent} onChangeText={(value) => setForwardDrafts((current) => ({ ...current, [transfer.id]: { ...(current[transfer.id] || forwardDraft), commissionPercent: value } }))} keyboardType="decimal-pad" />
                      <Button label="Forward for acceptance" disabled={offline || busy || !forwardReceiver} loading={busy} onPress={() => submitForward(transfer)} />
                    </View>
                  ) : null}
                </View>
              ) : null}
              {receivingForward ? (
                <View style={styles.rowButtons}>
                  <Button label="Accept" disabled={offline || busy} onPress={() => respondToForward(transfer, true)} style={styles.flexButton} />
                  <Button label="Reject" variant="danger" disabled={offline || busy} onPress={() => respondToForward(transfer, false)} style={styles.flexButton} />
                </View>
              ) : null}
            </View>
          );
        })}
      </Panel>
    </View>
  );
}

type MobileSearchResult = {
  key: string;
  groupKey: string;
  kind: "order" | "transfer" | "receivable" | "ledger" | "archive";
  type: string;
  reference: string;
  actor: string;
  participants: string[];
  participant?: string;
  amount: string;
  status: string;
  details: string;
  time: number;
  screen: AppScreen;
  searchText: string;
};

function uniqueSearchNames(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function searchResultPriority(result: MobileSearchResult): number {
  const priority = { order: 40, transfer: 40, receivable: 30, ledger: 20, archive: 10 }[result.kind];
  return priority + (result.type.startsWith("Archived") ? 0 : 5);
}

function preferredSearchResult(results: MobileSearchResult[], participant = ""): MobileSearchResult | undefined {
  const transactionRows = results.filter((result) => ["order", "transfer"].includes(result.kind));
  const participantRows = participant ? results.filter((result) => result.participant === participant) : [];
  const candidates = transactionRows.length ? transactionRows : participantRows.length ? participantRows : results;
  return candidates.slice().sort((a, b) => searchResultPriority(b) - searchResultPriority(a) || b.time - a.time)[0];
}

function consolidateSearchResults(results: MobileSearchResult[], session: UserSession): MobileSearchResult[] {
  const grouped = new Map<string, MobileSearchResult[]>();
  results.forEach((result) => grouped.set(result.groupKey, [...(grouped.get(result.groupKey) || []), result]));
  return Array.from(grouped.entries()).flatMap(([groupKey, group]) => {
    if (groupKey.startsWith("single:")) return group;
    if (!isMasterView(session)) {
      const preferred = preferredSearchResult(group, session.actorName);
      return preferred ? [{ ...preferred, key: `${groupKey}:${session.actorName}`, actor: session.actorName }] : [];
    }
    const participants = uniqueSearchNames(group.flatMap((result) => [...result.participants, result.participant]));
    return (participants.length ? participants : ["Master"]).flatMap((participant) => {
      const preferred = preferredSearchResult(group, participant);
      return preferred ? [{ ...preferred, key: `${groupKey}:${participant}`, actor: participant }] : [];
    });
  }).sort((a, b) => b.time - a.time);
}

export function SearchScreen({ session, state, onNavigate }: CommonProps) {
  const [query, setQuery] = useState("");
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const viewerActor = actorForSession(session, state);
  const rawResults: MobileSearchResult[] = [];
  let singleIndex = 0;

  const addOrder = (order: OrderRecord, type = "Order", status: string = order.state, archivedAt = "") => {
    const isPayer = order.agent === session.actorName || order.agentActorId === session.actorId;
    const isBroker = order.broker === session.actorName;
    const visibility = viewerActor?.orderVisibilityPermissions || {};
    const canSeeSource = isMasterView(session) || isBroker || !isPayer || (visibility.sourceCurrency !== false && visibility.baseAmount !== false);
    const canSeeRate = isMasterView(session) || isBroker || !isPayer || visibility.rate !== false;
    const canSeeCommission = isMasterView(session) || isBroker || !isPayer || visibility.commission !== false;
    const sourceAmount = compactAmount(order.sourceCurrency, majorFromMinor(order.sourceAmountMinor, order.sourceCurrency));
    const payoutAmount = compactAmount(order.payoutCurrency, majorFromMinor(order.payoutAmountMinor, order.payoutCurrency));
    const voided = orderRecordIsVoided(order);
    const resultStatus = voided ? "Voided - Excluded" : status;
    const details = [
      voided ? "Excluded from all calculations" : "",
      order.senderName ? `Sender: ${order.senderName}` : "",
      order.receiverName ? `Receiver: ${order.receiverName}` : "",
      order.receiverCity ? `Receiver City: ${order.receiverCity}` : "",
      order.phoneNumber ? `Phone: ${order.phoneNumber}` : "",
      order.accountNumber ? `Account: ${order.accountNumber}` : "",
      order.remarks ? `Remarks: ${order.remarks}` : "",
      isMasterView(session) && order.broker ? `Ordering Actor: ${order.broker}` : "",
      order.agent && order.agent !== "Unassigned" ? `Payer: ${order.agent}` : "",
      canSeeSource ? `Source Amount: ${sourceAmount}` : "",
      `Payout Amount: ${payoutAmount}`,
      canSeeRate && order.rate ? `Rate: ${order.rate}` : "",
      canSeeCommission ? `Commission: ${order.commissionPercent || 0}%` : "",
      order.fundingType ? `Payment Type: ${order.fundingType}` : "",
      order.journal ? `Journal: ${order.journal}` : "",
      order.voidJournal ? `Void Journal: ${order.voidJournal}` : ""
    ].filter(Boolean).join(" - ");
    const reference = orderNumber(order, session);
    const participants = uniqueSearchNames([order.broker, order.agent !== "Unassigned" ? order.agent : "", "Master"]);
    const searchableParticipants = isMasterView(session) ? participants : uniqueSearchNames([session.actorName, "Master"]);
    rawResults.push({
      key: `${type}:${order.id}`,
      groupKey: `order:${order.id}`,
      kind: "order",
      type,
      reference,
      actor: "",
      participants,
      amount: canSeeSource ? `${sourceAmount} to ${payoutAmount}` : payoutAmount,
      status: resultStatus,
      details,
      time: new Date(order.paidAt || order.sentAt || order.createdAt || archivedAt || 0).getTime() || 0,
      screen: type.startsWith("Archived") ? "archive" : "orders",
      searchText: [reference, order.id, order.brokerOrderNumber, order.agentOrderNumber, Object.values(order.agentOrderNumbers || {}), resultStatus, searchableParticipants, details].flat().join(" ").toLocaleLowerCase()
    });
  };

  const addTransfer = (transfer: WorkspaceState["transfers"][number] | NonNullable<WorkspaceState["archives"][number]["transfers"]>[number], type = "Transfer", archivedAt = "") => {
    const sourceCurrency = transfer.sourceCurrency || transfer.currency || "USD";
    const payoutCurrency = transfer.currency || sourceCurrency;
    const sourceAmount = compactAmount(sourceCurrency, majorFromMinor(Number(transfer.sourceAmountMinor || transfer.amountMinor || 0), sourceCurrency));
    const payoutAmount = compactAmount(payoutCurrency, majorFromMinor(Number(transfer.amountMinor || 0), payoutCurrency));
    const details = [
      transfer.from ? `From: ${transfer.from}` : "",
      transfer.to ? `To: ${transfer.to}` : "",
      transfer.forwardedAt && transfer.requestedTo ? `Originally sent to: ${transfer.requestedTo}` : "",
      transfer.forwardedBy ? `Forwarded by: ${transfer.forwardedBy}` : "",
      transfer.acceptedBy ? `Accepted by: ${transfer.acceptedBy}` : "",
      transfer.remarks ? `Remarks: ${transfer.remarks}` : "",
      transfer.journal ? `Journal: ${transfer.journal}` : "",
      transfer.reversalJournal ? `Reversal: ${transfer.reversalJournal}` : ""
    ].filter(Boolean).join(" - ");
    const reference = transfer.id || transfer.journal || "Transfer";
    const participants = uniqueSearchNames([transfer.from, transfer.to, transfer.requestedTo, transfer.forwardedBy, transfer.acceptedBy, "Master"]);
    const status = type.startsWith("Archived") ? "Locked" : transfer.state || "Posted";
    rawResults.push({ key: `${type}:${reference}`, groupKey: transfer.id ? `transfer:${transfer.id}` : `single:${singleIndex++}`, kind: "transfer", type, reference, actor: "", participants, amount: `${sourceAmount} to ${payoutAmount}`, status, details, time: new Date(transfer.reversedAt || transfer.paidOutAt || transfer.acceptedAt || transfer.approvedAt || transfer.forwardedAt || transfer.sentAt || transfer.createdAt || archivedAt || 0).getTime() || 0, screen: type.startsWith("Archived") ? "archive" : "transfers", searchText: [reference, status, participants, details, sourceAmount, payoutAmount].flat().join(" ").toLocaleLowerCase() });
  };

  const ledgerParticipant = (account: string) => {
    const actor = state.actors.find((candidate) => account === candidate.name || account.startsWith(`${candidate.name} `) || account.startsWith(`${candidate.name}_`));
    return actor?.name || (/^MASTER(?:_|\s|$)/i.test(account) ? "Master" : account);
  };
  const addLedger = (line: WorkspaceState["ledger"][number], type = "Ledger", archivedAt = "") => {
    const participant = ledgerParticipant(String(line.account || ""));
    const reference = String(line.journal || line.orderId || line.transferId || line.entryId || "Ledger");
    const groupKey = line.orderId ? `order:${line.orderId}` : line.transferId ? `transfer:${line.transferId}` : `ledger:${reference}`;
    const amount = compactAmount(line.currency, majorFromMinor(line.amountMinor, line.currency));
    const voided = ledgerLineIsForVoidedOrder(state, line);
    const details = [voided ? "VOIDED - Excluded from all calculations" : "", line.details, line.source ? `Source: ${line.source}` : "", line.account ? `Account: ${line.account}` : "", `Direction: ${line.direction}`].filter(Boolean).join(" - ");
    const status = voided ? "Voided - Excluded" : type.startsWith("Archived") ? "Locked" : line.direction;
    rawResults.push({ key: `${type}:${reference}:${participant}`, groupKey, kind: "ledger", type, reference, actor: participant, participants: participant ? [participant] : [], participant, amount, status, details, time: new Date(line.postedAt || archivedAt || 0).getTime() || 0, screen: type.startsWith("Archived") ? "archive" : "ledger", searchText: [reference, participant, amount, status, details].join(" ").toLocaleLowerCase() });
  };

  const addReceivable = (item: WorkspaceState["receivables"][number], type = "Receivable", archivedAt = "") => {
    const paidMinor = (item.payments || []).reduce((sum, payment) => sum + Number(payment.amountMinor || 0), 0);
    const balanceMinor = Math.max(0, item.principalMinor - paidMinor);
    const principal = compactAmount(item.currency, majorFromMinor(item.principalMinor, item.currency));
    const balance = compactAmount(item.currency, majorFromMinor(balanceMinor, item.currency));
    const status = type.startsWith("Archived") ? "Locked" : item.voided ? "Voided" : balanceMinor ? "Open" : "Paid";
    const details = [item.senderName ? `Sender: ${item.senderName}` : "", item.receiverName ? `Receiver: ${item.receiverName}` : "", item.receiverCity ? `Receiver City: ${item.receiverCity}` : "", item.phoneNumber ? `Phone: ${item.phoneNumber}` : "", item.accountNumber ? `Account: ${item.accountNumber}` : "", item.remarks ? `Remarks: ${item.remarks}` : "", `Principal: ${principal}`, `Balance: ${balance}`].filter(Boolean).join(" - ");
    const reference = item.brokerOrderNumber || item.orderId || item.id;
    rawResults.push({ key: `${type}:${item.id}`, groupKey: item.orderId ? `order:${item.orderId}` : `receivable:${item.id}`, kind: "receivable", type, reference, actor: item.borrower, participants: uniqueSearchNames([item.borrower, "Master"]), amount: `Principal ${principal} / Balance ${balance}`, status, details, time: new Date(item.createdAt || item.updatedAt || archivedAt || 0).getTime() || 0, screen: type.startsWith("Archived") ? "archive" : "receivables", searchText: [reference, item.id, item.borrower, status, details].join(" ").toLocaleLowerCase() });
  };

  (isMasterView(session) ? state.orders : state.orders.filter((order) => order.broker === session.actorName || order.agent === session.actorName || order.agentActorId === session.actorId)).forEach((order) => addOrder(order));
  (isMasterView(session) ? state.transfers : state.transfers.filter((transfer) => transfer.from === session.actorName || transfer.to === session.actorName)).forEach((transfer) => addTransfer(transfer));
  state.ledger.filter((line) => line.archived !== true && (isMasterView(session) || ledgerParticipant(String(line.account || "")) === session.actorName)).forEach((line) => addLedger(line, line.source === "JOURNAL" ? "Journal" : line.source === "WITHDRAWAL" ? "Withdrawal" : "Ledger"));
  state.receivables.filter((item) => isMasterView(session) || item.borrower === session.actorName).forEach((item) => addReceivable(item));
  state.archives.filter((archive) => isMasterView(session) || archive.actor === session.actorName).forEach((archive) => {
    (archive.orders || []).forEach((order) => addOrder(order, "Archived Order", "Locked", archive.closedAt));
    (archive.transfers || []).forEach((transfer) => addTransfer(transfer, "Archived Transfer", archive.closedAt));
    (archive.ledger || []).forEach((line) => addLedger(line, "Archived Ledger", archive.closedAt));
    (archive.receivables || []).forEach((item) => addReceivable(item, "Archived Receivable", archive.closedAt));
    Object.entries(archive.balances || {}).filter(([, minor]) => Number(minor || 0) !== 0).forEach(([currency, minor]) => {
      const amount = `${Number(minor) >= 0 ? "+" : "-"}${compactAmount(currency as Currency, majorFromMinor(Math.abs(Number(minor)), currency as Currency))}`;
      const details = `${archive.actor || "Actor"} - ${Number(minor) > 0 ? "Owes Master" : "Master owes"} - Closed ${new Date(archive.closedAt || 0).toLocaleString()}`;
      rawResults.push({ key: `archive:${archive.id}:${currency}`, groupKey: `single:${singleIndex++}`, kind: "archive", type: "Closed Balance", reference: archive.id || "Report", actor: archive.actor || "", participants: uniqueSearchNames([archive.actor]), amount, status: "Locked", details, time: new Date(archive.closedAt || 0).getTime() || 0, screen: "archive", searchText: [archive.id, archive.actor, currency, amount, details].join(" ").toLocaleLowerCase() });
    });
  });

  const results = terms.length ? consolidateSearchResults(rawResults.filter((result) => terms.every((term) => result.searchText.includes(term))), session) : [];
  return (
    <View style={styles.screen}>
      <ScreenTitle title="Search" subtitle="Find any permitted workspace record" />
      <Field label="Search names, numbers, remarks, transfers..." value={query} onChangeText={setQuery} autoCapitalize="none" />
      {!terms.length ? <Panel><Text style={styles.muted}>Start typing to filter matching records.</Text></Panel> : <>
        <Pill label={`${results.length} result${results.length === 1 ? "" : "s"}`} tone={results.length ? "good" : "neutral"} />
        {results.map((result) => (
          <Pressable key={result.key} onPress={() => onNavigate(result.screen)}>
            <Panel title={result.reference} badge={result.status} badgeTone={tone(result.status)}>
              <Text style={styles.primaryLine}>{result.type} - {result.actor}</Text>
              <Text style={styles.amountLine}>{result.amount}</Text>
              {result.details ? <Text style={styles.muted}>{result.details}</Text> : null}
            </Panel>
          </Pressable>
        ))}
        {!results.length ? <Panel><Text style={styles.muted}>No matching records.</Text></Panel> : null}
      </>}
    </View>
  );
}

export function ReceivablesScreen({ session, state, offline, onState }: CommonProps) {
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const records = state.receivables.filter((item) => !item.archivedAt && (isMasterView(session) || item.borrower === session.actorName));
  const totals = supportedCurrencies.map((currency) => ({ currency, minor: records.filter((item) => item.currency === currency && !item.voided).reduce((sum, item) => sum + receivableBalance(item), 0) })).filter((item) => item.minor);
  const collect = async (id: string) => {
    if (offline) return Alert.alert("Offline", "Reconnect before recording a collection.");
    setBusy(id);
    try { onState(await collectReceivable(id, amounts[id] || "", session.actorName)); setAmounts((current) => ({ ...current, [id]: "" })); } catch (error) { Alert.alert("Collection", errorMessage(error)); } finally { setBusy(""); }
  };
  return <View style={styles.screen}><ScreenTitle title="Receivables" subtitle="Credit orders and loan collections" /><OfflineGuard offline={offline} />{records.map((item) => { const balance = receivableBalance(item); const showReminder = !isMasterView(session) && item.borrower === session.actorName && Boolean(item.creditReminder); return <Panel key={item.id} title={item.brokerOrderNumber || item.orderId} badge={item.voided ? "Voided" : balance ? "Open" : "Collected"}><SummaryRow label="Borrower" value={item.borrower} />{item.senderName ? <SummaryRow label="Sender" value={item.senderName} /> : null}{item.receiverName ? <SummaryRow label="Receiver" value={item.receiverName} /> : null}{item.receiverCity ? <SummaryRow label="Receiver city" value={item.receiverCity} /> : null}{showReminder ? <SummaryRow label="Credit Reminder" value={item.creditReminder || ""} /> : null}<SummaryRow label="Principal" value={compactAmount(item.currency, majorFromMinor(item.principalMinor, item.currency))} /><SummaryRow label="Collected" value={compactAmount(item.currency, majorFromMinor(item.principalMinor - balance, item.currency))} /><SummaryRow label="Balance" value={compactAmount(item.currency, majorFromMinor(balance, item.currency))} strong />{balance > 0 && !item.voided ? <View style={styles.actionBlock}><Field label="Collection amount" value={amounts[item.id] || ""} onChangeText={(value) => setAmounts((current) => ({ ...current, [item.id]: value }))} keyboardType="decimal-pad" /><Button label="Record collection" loading={busy === item.id} disabled={offline} onPress={() => collect(item.id)} /></View> : null}</Panel>; })}<Panel title="Outstanding totals">{totals.length ? totals.map((item) => <SummaryRow key={item.currency} label={item.currency} value={compactAmount(item.currency, majorFromMinor(item.minor, item.currency))} strong />) : <Text style={styles.muted}>No outstanding receivables.</Text>}</Panel></View>;
}

const likeReaction = "\uD83D\uDC4D";
const loveReaction = "\u2764\uFE0F";

function chatMessageSummary(message: ChatMessageRecord | undefined): string {
  if (!message) return "";
  if (message.text) return message.text;
  if (message.kind === "photo") return "Photo";
  if (message.kind === "voice") return "Voice message";
  return message.fileName || "Attachment";
}

async function openChatAttachment(message: ChatMessageRecord): Promise<void> {
  if (!message.media) throw new Error("This attachment is no longer available.");
  const separator = message.media.indexOf(",");
  if (!message.media.startsWith("data:") || separator < 0) throw new Error("This attachment cannot be opened on this device.");
  if (!(await Sharing.isAvailableAsync())) throw new Error("Opening attachments is unavailable on this device.");
  const header = message.media.slice(5, separator);
  const mimeType = message.mimeType || header.split(";")[0] || "application/octet-stream";
  const fileName = (message.fileName || "payment-proof").replace(/[^a-z0-9._-]+/gi, "-");
  const cacheDirectory = FileSystem.cacheDirectory;
  if (!cacheDirectory) throw new Error("Temporary file storage is unavailable.");
  const uri = `${cacheDirectory}${Date.now()}-${fileName}`;
  await FileSystem.writeAsStringAsync(uri, message.media.slice(separator + 1), { encoding: FileSystem.EncodingType.Base64 });
  await Sharing.shareAsync(uri, { mimeType, dialogTitle: `Open ${message.orderNumber || fileName}` });
}

export function ChatScreen({ session, state, offline, onState, onRefresh, onScrollToEnd }: CommonProps) {
  const chats = visibleChatsFor(session, state);
  const [chatId, setChatId] = useState(chats[0]?.id || "");
  const [message, setMessage] = useState("");
  const [replyToId, setReplyToId] = useState("");
  const [forwardMessageId, setForwardMessageId] = useState("");
  const [groupName, setGroupName] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const composerRef = useRef<TextInput>(null);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  const selected = chats.find((chat) => chat.id === chatId) || chats[0];
  const replyingTo = selected?.messages.find((item) => item.id === replyToId);
  const forwardingMessage = selected?.messages.find((item) => item.id === forwardMessageId);
  const chatTitle = (chat: typeof chats[number]) => chat.type === "group"
    ? chat.name
    : chat.members.find((name) => name !== session.actorName) || chat.name;

  const focusComposer = () => {
    setTimeout(() => {
      onScrollToEnd?.();
      composerRef.current?.focus();
      setTimeout(() => onScrollToEnd?.(), 150);
    }, 80);
  };

  useEffect(() => {
    focusComposer();
  }, []);

  useEffect(() => {
    if (offline) return;
    refreshRef.current();
    const timer = setInterval(() => {
      if (!busyRef.current) refreshRef.current();
    }, 15000);
    return () => clearInterval(timer);
  }, [offline]);

  const selectChat = (nextChatId: string) => {
    setChatId(nextChatId);
    setReplyToId("");
    setForwardMessageId("");
  };

  const run = async (task: () => Promise<WorkspaceState>) => {
    if (offline) {
      Alert.alert("Offline", "Reconnect before sending or changing chats.");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      onState(await task());
    } catch (error) {
      Alert.alert("Chat", errorMessage(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const sendMessage = () => {
    if (!selected || !message.trim()) return;
    run(async () => {
      const next = await sendChatMessage(selected.id, session.actorName, message, replyToId);
      setMessage("");
      setReplyToId("");
      return next;
    });
  };

  const forwardTo = (targetChatId: string) => {
    if (!selected || !forwardMessageId) return;
    run(async () => {
      const next = await forwardChatMessage(selected.id, forwardMessageId, targetChatId, session.actorName);
      setForwardMessageId("");
      return next;
    });
  };

  return (
    <View style={styles.screen}>
      <ScreenTitle title="Chat" subtitle="Workspace messages" />
      <OfflineGuard offline={offline} />
      <Button label="Refresh messages" icon={<RefreshCw size={17} color={colors.ink} />} variant="secondary" disabled={busy} onPress={onRefresh} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chatTabs}>
        {chats.map((chat) => (
          <Pressable key={chat.id} onPress={() => selectChat(chat.id)} style={[styles.choice, selected?.id === chat.id && styles.choiceActive]}>
            <Text style={[styles.choiceText, selected?.id === chat.id && styles.choiceTextActive]}>{chatTitle(chat)}</Text>
          </Pressable>
        ))}
      </ScrollView>
      {selected ? (
        <Panel title={chatTitle(selected)} badge={selected.type}>
          <View style={styles.messages}>
            {selected.messages.slice(-50).map((item) => {
              const repliedMessage = selected.messages.find((candidate) => candidate.id === item.replyTo);
              const myReaction = item.reactions?.[session.actorName];
              return (
                <View key={item.id} style={[styles.message, item.from === session.actorName && styles.myMessage]}>
                  <Text style={styles.messageFrom}>
                    {item.from}{item.forwardedFrom ? ` - Forwarded from ${item.forwardedFrom}` : ""}
                  </Text>
                  {repliedMessage ? (
                    <View style={styles.messageReply}>
                      <Text style={styles.messageReplyFrom}>{repliedMessage.from}</Text>
                      <Text style={styles.messageReplyText} numberOfLines={2}>{chatMessageSummary(repliedMessage)}</Text>
                    </View>
                  ) : null}
                  <Text style={styles.messageText}>{chatMessageSummary(item)}</Text>
                  {item.media && item.kind === "photo" ? <Image source={{ uri: item.media }} resizeMode="contain" style={styles.messageImage} /> : null}
                  {item.media ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${item.fileName || "attachment"}`}
                      onPress={() => openChatAttachment(item).catch((error) => Alert.alert("Attachment", errorMessage(error)))}
                      style={styles.attachmentButton}
                    >
                      <Paperclip size={15} color={colors.accent} />
                      <Text numberOfLines={2} style={styles.attachmentText}>Open {item.fileName || "attachment"}</Text>
                    </Pressable>
                  ) : null}
                  {Object.entries(item.reactions || {}).length ? (
                    <View style={styles.reactionList}>
                      {Object.entries(item.reactions || {}).map(([name, reaction]) => (
                        <Text key={name} style={styles.reactionChip}>{reaction} {name}</Text>
                      ))}
                    </View>
                  ) : null}
                  <Text style={styles.messageTime}>{new Date(item.createdAt).toLocaleString()}</Text>
                  <View style={styles.messageActions}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Like message"
                      disabled={offline || busy}
                      onPress={() => run(() => reactToChatMessage(selected.id, item.id, session.actorName, likeReaction))}
                      style={[styles.messageAction, myReaction === likeReaction && styles.messageActionActive]}
                    >
                      <ThumbsUp size={14} color={myReaction === likeReaction ? colors.accent : colors.muted} />
                      <Text style={[styles.messageActionText, myReaction === likeReaction && styles.messageActionTextActive]}>Like</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Love message"
                      disabled={offline || busy}
                      onPress={() => run(() => reactToChatMessage(selected.id, item.id, session.actorName, loveReaction))}
                      style={[styles.messageAction, myReaction === loveReaction && styles.messageActionActive]}
                    >
                      <Heart size={14} color={myReaction === loveReaction ? colors.danger : colors.muted} />
                      <Text style={[styles.messageActionText, myReaction === loveReaction && styles.messageActionTextActive]}>Love</Text>
                    </Pressable>
                    <Pressable accessibilityRole="button" accessibilityLabel="Reply to message" disabled={offline || busy} onPress={() => { setReplyToId(item.id); focusComposer(); }} style={styles.messageAction}>
                      <Reply size={14} color={colors.muted} />
                      <Text style={styles.messageActionText}>Reply</Text>
                    </Pressable>
                    {isMasterView(session) ? (
                      <Pressable accessibilityRole="button" accessibilityLabel="Forward message" disabled={offline || busy} onPress={() => setForwardMessageId(item.id)} style={styles.messageAction}>
                        <ForwardIcon size={14} color={colors.muted} />
                        <Text style={styles.messageActionText}>Forward</Text>
                      </Pressable>
                    ) : null}
                  </View>
                </View>
              );
            })}
          </View>
          {replyingTo ? (
            <View style={styles.composerPreview}>
              <View style={styles.composerPreviewText}>
                <Text style={styles.messageReplyFrom}>Replying to {replyingTo.from}</Text>
                <Text style={styles.muted} numberOfLines={2}>{chatMessageSummary(replyingTo)}</Text>
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel="Cancel reply" onPress={() => setReplyToId("")} style={styles.previewClose}>
                <X size={17} color={colors.muted} />
              </Pressable>
            </View>
          ) : null}
          {forwardingMessage && isMasterView(session) ? (
            <View style={styles.forwardPicker}>
              <View style={styles.composerPreview}>
                <View style={styles.composerPreviewText}>
                  <Text style={styles.messageReplyFrom}>Forward message</Text>
                  <Text style={styles.muted} numberOfLines={2}>{chatMessageSummary(forwardingMessage)}</Text>
                </View>
                <Pressable accessibilityRole="button" accessibilityLabel="Cancel forwarding" onPress={() => setForwardMessageId("")} style={styles.previewClose}>
                  <X size={17} color={colors.muted} />
                </Pressable>
              </View>
              <Text style={styles.fieldLabel}>Choose destination</Text>
              <View style={styles.choiceWrap}>
                {chats.filter((chat) => chat.id !== selected.id).map((chat) => (
                  <Pressable key={chat.id} disabled={busy} onPress={() => forwardTo(chat.id)} style={styles.choice}>
                    <Text style={styles.choiceText}>{chatTitle(chat)}</Text>
                  </Pressable>
                ))}
              </View>
              {chats.length < 2 ? <Text style={styles.muted}>No other chat is available.</Text> : null}
            </View>
          ) : null}
          <Field inputRef={composerRef} label="Message" value={message} onChangeText={setMessage} onFocus={onScrollToEnd} multiline />
          <Button label="Send" icon={<Send size={17} color="#fff" />} loading={busy} disabled={offline || !message.trim()} onPress={sendMessage} />
          {isMasterView(session) && selected.type === "group" ? (
            <Button label="Delete group" icon={<Trash2 size={17} color={colors.danger} />} variant="danger" disabled={offline || busy} onPress={() => run(() => deleteChatGroup(selected.id))} />
          ) : null}
        </Panel>
      ) : <Panel><Text style={styles.muted}>No conversations yet.</Text></Panel>}
      {isMasterView(session) ? (
        <Panel title="Create group">
          <Field label="Group name" value={groupName} onChangeText={setGroupName} />
          <View style={styles.choiceWrap}>
            {activeActors(state).filter((actor) => actor.role !== "Master").map((actor) => (
              <Pressable key={actor.id} onPress={() => setMembers((current) => current.includes(actor.name) ? current.filter((name) => name !== actor.name) : [...current, actor.name])} style={[styles.choice, members.includes(actor.name) && styles.choiceActive]}>
                <Text style={[styles.choiceText, members.includes(actor.name) && styles.choiceTextActive]}>{actor.name}</Text>
              </Pressable>
            ))}
          </View>
          <Button label="Create group" loading={busy} disabled={offline} onPress={() => run(async () => { const next = await createChatGroup(groupName, members); setGroupName(""); setMembers([]); return next; })} />
        </Panel>
      ) : null}
    </View>
  );
}

export function LedgerScreen({ session, state, onState }: CommonProps) {
  const actorChoices = activeActors(state).filter((actor) => actor.role !== "Master");
  const [actorId, setActorId] = useState(isMasterView(session) ? actorChoices[0]?.id || "" : session.actorId);
  const [incomeExpanded, setIncomeExpanded] = useState(false);
  const [bankExpanded, setBankExpanded] = useState(false);
  const [bankCurrency, setBankCurrency] = useState<Currency>("USD");
  const [bankAmount, setBankAmount] = useState("");
  const [bankReason, setBankReason] = useState("");
  const [bankBusy, setBankBusy] = useState(false);
  const [transactionSort, setTransactionSort] = useState<"Date" | "Order / Transfer No.">("Date");
  const selected = isMasterView(session) ? actorChoices.find((actor) => actor.id === actorId) : actorForSession(session, state);
  const actorName = selected?.name || session.actorName;
  const referenceForLine = (line: WorkspaceState["ledger"][number]) => String(line.journal || line.orderId || line.transferId || line.entryId || "");
  const lines = state.ledger
    .filter((line) => line.archived !== true && (isMasterView(session) ? (!selected || String(line.account).includes(actorName)) : String(line.account).includes(session.actorName)))
    .slice()
    .sort((a, b) => transactionSort === "Date"
      ? new Date(b.postedAt || 0).getTime() - new Date(a.postedAt || 0).getTime()
      : referenceForLine(a).localeCompare(referenceForLine(b), undefined, { numeric: true, sensitivity: "base" }));
  const balanceLines = calculableLedgerLines(state, lines);
  const balances = supportedCurrencies.map((currency) => ({ currency, minor: balanceLines.filter((line) => line.currency === currency).reduce((sum, line) => sum + (line.direction === "Debit" ? 1 : -1) * Number(line.amountMinor || 0), 0) }));
  const incomeOrders = state.orders.filter((order) => order.state === "Paid" && order.journal && !order.voidJournal && order.excludedFromCalculations !== true && Number.isFinite(Number(order.incomeProfitMinor)));
  const totalIncomeUsdMinor = incomeOrders.reduce((sum, order) => sum + Number(order.incomeProfitMinor || 0), 0);
  const bankEntries = masterBankEntriesWithRunningBalances(state);
  const bankMonths = Array.from(new Set(bankEntries.map((entry) => entry.postedAt.slice(0, 7)).filter(Boolean))).sort().reverse();
  const [bankMonth, setBankMonth] = useState(bankMonths[0] || new Date().toISOString().slice(0, 7));
  const selectedBankMonth = bankMonths.includes(bankMonth) ? bankMonth : bankMonths[0] || bankMonth;
  const bankRows = bankEntries.filter((entry) => entry.postedAt.slice(0, 7) === selectedBankMonth);
  const bankBalances = supportedCurrencies.map((currency) => ({
    currency,
    minor: bankEntries.filter((entry) => entry.currency === currency).at(-1)?.runningMinor || 0
  }));
  const bankPeriodTotals = supportedCurrencies.map((currency) => {
    const currencyRows = bankRows.filter((entry) => entry.currency === currency);
    const moneyIn = currencyRows.filter((entry) => entry.direction === "Credit").reduce((sum, entry) => sum + entry.amountMinor, 0);
    const moneyOut = currencyRows.filter((entry) => entry.direction === "Debit").reduce((sum, entry) => sum + entry.amountMinor, 0);
    return { currency, moneyIn, moneyOut, net: moneyIn - moneyOut };
  }).filter((item) => item.moneyIn || item.moneyOut);
  const signedBankAmount = (currency: Currency, minor: number) => `${minor >= 0 ? "+" : "-"}${compactAmount(currency, majorFromMinor(Math.abs(minor), currency))}`;
  const fundBank = async () => {
    if (state.offlineSnapshot) return Alert.alert("Offline", "Reconnect before funding the Master Bank Account.");
    setBankBusy(true);
    try {
      const next = await fundMasterBankAccount({ currency: bankCurrency, amount: bankAmount, reason: bankReason, postedBy: session.actorName });
      setBankAmount("");
      setBankReason("");
      onState(next);
    } catch (error) {
      Alert.alert("Master Bank Account", errorMessage(error));
    } finally {
      setBankBusy(false);
    }
  };
  const shareBankStatement = async () => {
    if (!bankRows.length) return;
    const line = (values: unknown[]) => values.map((value) => String(value ?? "").replace(/[\t\r\n]+/g, " ")).join("\t");
    const statement = [
      `Master Bank Account - ${selectedBankMonth}`,
      line(["Date", "Type", "Reference", "Details", "Currency", "Money In", "Money Out", "Running Balance"]),
      ...bankRows.map((entry) => line([
        new Date(entry.postedAt).toLocaleString(),
        entry.type,
        entry.reference || entry.id,
        entry.details,
        entry.currency,
        entry.direction === "Credit" ? majorFromMinor(entry.amountMinor, entry.currency).toFixed(2) : "",
        entry.direction === "Debit" ? majorFromMinor(entry.amountMinor, entry.currency).toFixed(2) : "",
        majorFromMinor(entry.runningMinor, entry.currency).toFixed(2)
      ]))
    ].join("\n");
    await Share.share({ title: `Master Bank Account ${selectedBankMonth}`, message: statement });
  };
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
      <SelectRow label="Sort transactions by" options={["Date", "Order / Transfer No."]} value={transactionSort} onChange={setTransactionSort} />
      <ScrollView horizontal showsHorizontalScrollIndicator>
        <View style={styles.ledgerTable}>
          <View style={[styles.ledgerRow, styles.ledgerHead]}><Text style={styles.colDate}>Date</Text><Text style={styles.colRef}>Journal / No.</Text><Text style={styles.colDirection}>Type</Text><Text style={styles.colAmount}>Amount</Text><Text style={styles.colDetails}>Details</Text></View>
          {lines.map((line, index) => {
            const voided = ledgerLineIsForVoidedOrder(state, line);
            const details = [voided ? "VOIDED - Excluded from all calculations" : "", line.details || line.source || ""].filter(Boolean).join(" - ");
            return (
              <View key={`${line.journal}-${index}`} style={[styles.ledgerRow, voided && styles.ledgerVoidRow]}>
                <Text style={[styles.colDate, voided && styles.ledgerVoidText]}>{line.postedAt ? new Date(line.postedAt).toLocaleDateString() : "-"}</Text>
                <Text style={[styles.colRef, voided && styles.ledgerVoidText]}>{String(line.journal || line.orderId || line.transferId || "-")}</Text>
                <Text style={[styles.colDirection, voided && styles.ledgerVoidText]}>{line.direction}</Text>
                <Text style={[styles.colAmount, voided && styles.ledgerVoidText]}>{compactAmount(line.currency, majorFromMinor(line.amountMinor, line.currency))}</Text>
                <Text style={[styles.colDetails, voided && styles.ledgerVoidText]} numberOfLines={3}>{details}</Text>
              </View>
            );
          })}
        </View>
      </ScrollView>
      {isMasterView(session) ? (
        <Panel title="Income statement" badge="USD total">
          <Pressable accessibilityRole="button" accessibilityLabel={incomeExpanded ? "Collapse income statement" : "Expand income statement"} onPress={() => setIncomeExpanded((current) => !current)} style={styles.showMore}>
            <Text style={styles.linkText}>{incomeExpanded ? "Hide income statement" : "Show income statement"}</Text>
            {incomeExpanded ? <ChevronUp size={17} color={colors.accent} /> : <ChevronDown size={17} color={colors.accent} />}
          </Pressable>
          {incomeExpanded ? <>
            {incomeOrders.map((order) => <View key={`income-${order.id}`} style={styles.recordRow}><Text style={styles.primaryLine}>{order.brokerOrderNumber || order.id}</Text><Text style={styles.muted}>Base USD {majorFromMinor(Number(order.incomeBaseAmountMinor || 0), "USD").toFixed(2)} | Collected EUR {majorFromMinor(Number(order.incomeCollectedEurMinor || 0), "EUR").toFixed(2)} | Collected USD {majorFromMinor(Number(order.incomeCollectedUsdMinor || 0), "USD").toFixed(2)}</Text><Text style={styles.amountLine}>Profit {compactAmount("USD", majorFromMinor(Number(order.incomeProfitMinor || 0), "USD"))}</Text></View>)}
            <SummaryRow label="Total profit" value={compactAmount("USD", majorFromMinor(totalIncomeUsdMinor, "USD"))} strong />
          </> : null}
        </Panel>
      ) : null}
      {isMasterView(session) ? (
        <Panel title="Master Bank Account" badge="Independent">
          <Pressable accessibilityRole="button" accessibilityLabel={bankExpanded ? "Collapse Master Bank Account" : "Expand Master Bank Account"} onPress={() => setBankExpanded((current) => !current)} style={styles.showMore}>
            <Text style={styles.linkText}>{bankExpanded ? "Hide bank account" : "Show bank account"}</Text>
            {bankExpanded ? <ChevronUp size={17} color={colors.accent} /> : <ChevronDown size={17} color={colors.accent} />}
          </Pressable>
          {bankExpanded ? <>
            <Text style={styles.sectionLabel}>Account balances</Text>
            <View style={styles.bankBalanceList}>
              {bankBalances.map((item) => <View key={`bank-balance-${item.currency}`} style={styles.bankBalanceRow}><Text style={styles.bankBalanceCurrency}>{item.currency}</Text><Text style={[styles.bankBalanceAmount, item.minor >= 0 ? styles.bankMoneyIn : styles.bankMoneyOut]}>{signedBankAmount(item.currency, item.minor)}</Text></View>)}
            </View>
            <View style={styles.bankSection}>
              <Text style={styles.sectionLabel}>Fund account</Text>
              <SelectRow label="Currency" options={supportedCurrencies} value={bankCurrency} onChange={setBankCurrency} />
              <Field label="Amount" value={bankAmount} onChangeText={setBankAmount} keyboardType="decimal-pad" placeholder="0.00" />
              <Field label="Reason" value={bankReason} onChangeText={setBankReason} multiline placeholder="State the funding reason" />
              <Button label="Fund account" loading={bankBusy} disabled={state.offlineSnapshot === true} onPress={fundBank} />
            </View>
            <View style={styles.bankSection}>
              <Text style={styles.sectionLabel}>Monthly statement</Text>
              <SelectRow label="Statement month" options={bankMonths.length ? bankMonths : [selectedBankMonth]} value={selectedBankMonth} onChange={setBankMonth} />
              <Button label="Share monthly statement" icon={<Share2 size={17} color={colors.ink} />} variant="secondary" disabled={!bankRows.length} onPress={shareBankStatement} />
              {bankRows.length ? bankRows.slice().reverse().map((entry) => {
                const moneyIn = entry.direction === "Credit";
                return <View key={entry.id} style={styles.bankStatementRow}>
                  <View style={styles.bankStatementHead}><Text style={styles.primaryLine}>{entry.type}</Text><Text style={styles.muted}>{new Date(entry.postedAt).toLocaleString()}</Text></View>
                  <Text style={styles.bankReference}>{entry.reference || entry.id}</Text>
                  {entry.details ? <Text style={styles.muted}>{entry.details}</Text> : null}
                  <View style={styles.bankAmountGrid}>
                    <View style={styles.bankAmountCell}><Text style={styles.bankAmountLabel}>Money In</Text><Text style={[styles.bankAmountValue, styles.bankMoneyIn]}>{moneyIn ? compactAmount(entry.currency, majorFromMinor(entry.amountMinor, entry.currency)) : "-"}</Text></View>
                    <View style={styles.bankAmountCell}><Text style={styles.bankAmountLabel}>Money Out</Text><Text style={[styles.bankAmountValue, styles.bankMoneyOut]}>{!moneyIn ? compactAmount(entry.currency, majorFromMinor(entry.amountMinor, entry.currency)) : "-"}</Text></View>
                    <View style={styles.bankAmountCell}><Text style={styles.bankAmountLabel}>Running</Text><Text style={[styles.bankAmountValue, entry.runningMinor >= 0 ? styles.bankMoneyIn : styles.bankMoneyOut]}>{signedBankAmount(entry.currency, entry.runningMinor)}</Text></View>
                  </View>
                </View>;
              }) : <Text style={styles.muted}>No Master Bank Account transactions for this month.</Text>}
              {bankPeriodTotals.length ? <View style={styles.bankPeriodTotals}>{bankPeriodTotals.map((item) => <View key={`bank-total-${item.currency}`} style={styles.bankPeriodRow}><Text style={styles.bankBalanceCurrency}>{item.currency}</Text><Text style={styles.bankMoneyIn}>In {compactAmount(item.currency, majorFromMinor(item.moneyIn, item.currency))}</Text><Text style={styles.bankMoneyOut}>Out {compactAmount(item.currency, majorFromMinor(item.moneyOut, item.currency))}</Text><Text style={item.net >= 0 ? styles.bankMoneyIn : styles.bankMoneyOut}>Net {signedBankAmount(item.currency, item.net)}</Text></View>)}</View> : null}
            </View>
          </> : null}
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

function idleTimeoutLabel(seconds: number): string {
  if (seconds < 60) return `${seconds} Seconds`;
  if (seconds === 60) return "1 Minute";
  if (seconds < 3600) return `${seconds / 60} Minutes`;
  return `${seconds / 3600} ${seconds === 3600 ? "Hour" : "Hours"}`;
}

export function SettingsScreen({ session, state, offline, onState, onSessionTimeout }: CommonProps) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState("");
  const timeoutOptions = allowedIdleTimeoutSeconds.map(idleTimeoutLabel);
  const [timeoutLabel, setTimeoutLabel] = useState(idleTimeoutLabel(session.idleTimeoutSeconds || 7200));
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
  const usdPayoutActors = activeActors(state).filter((actor) => actor.role === "Agent" && actor.currency === "USD");
  const [usdAgentRatesExpanded, setUsdAgentRatesExpanded] = useState(false);
  const [usdAgentRates, setUsdAgentRates] = useState<Record<string, { divider: string; percent: string }>>(() => Object.fromEntries(usdPayoutActors.map((actor) => [actor.id, {
    divider: String(actor.incomeUsdPayoutSetting?.divider || 1),
    percent: String(actor.incomeUsdPayoutSetting?.percent || 0)
  }])));
  const [resetPermit, setResetPermit] = useState("");
  const [resetScope, setResetScope] = useState<"data" | "wipe">("data");
  const resettableActors = activeActors(state).filter((actor) => actor.role !== "Master");
  const [resetActorName, setResetActorName] = useState(resettableActors[0]?.name || "");
  const selectedResetActorName = resettableActors.some((actor) => actor.name === resetActorName) ? resetActorName : resettableActors[0]?.name || "";
  const master = isMasterView(session);
  const saveTimeout = async () => {
    if (offline) return Alert.alert("Offline", "Reconnect before changing the automatic logout time.");
    const selectedIndex = timeoutOptions.indexOf(timeoutLabel);
    const idleTimeoutSeconds = allowedIdleTimeoutSeconds[selectedIndex] || 7200;
    setBusy("timeout");
    try {
      const nextSession = await updateIdleTimeout(idleTimeoutSeconds);
      onSessionTimeout?.(nextSession);
      Alert.alert("Time Out updated", `Automatic logout is set to ${idleTimeoutLabel(idleTimeoutSeconds)}.`);
    } catch (error) {
      Alert.alert("Time Out", errorMessage(error));
    } finally {
      setBusy("");
    }
  };
  const change = async () => { if (offline) return Alert.alert("Offline", "Reconnect before changing your password."); setBusy("password"); try { await changePassword(currentPassword, newPassword); setCurrentPassword(""); setNewPassword(""); Alert.alert("Password updated", "Your new password is ready."); } catch (error) { Alert.alert("Password", errorMessage(error)); } finally { setBusy(""); } };
  const setMode = async (actorId: string, mode: ActorRecord["transferMode"]) => { if (offline) return Alert.alert("Offline", "Reconnect before changing permissions."); setBusy(actorId); try { onState(await updateActorTransferMode(actorId, mode)); } catch (error) { Alert.alert("Permissions", errorMessage(error)); } finally { setBusy(""); } };
  const refreshInvites = async () => { setBusy("invites"); try { setInvites(await loadInvites()); } catch (error) { Alert.alert("Invite codes", errorMessage(error)); } finally { setBusy(""); } };
  const addInvite = async () => { if (offline) return Alert.alert("Offline", "Reconnect before creating an invite."); setBusy("invite-create"); try { await createInvite({ actorRole: inviteRole, currency: inviteCurrency, workingCurrencies: [inviteCurrency] }); await refreshInvites(); } catch (error) { Alert.alert("Invite codes", errorMessage(error)); } finally { setBusy(""); } };
  const saveRates = async () => { if (offline) return Alert.alert("Offline", "Reconnect before saving rates."); setBusy("buying"); try { onState(await updateBuyingRates({ eurToUsd: Number(buying.eurToUsd), usdToEtb: Number(buying.usdToEtb), usdToErn: Number(buying.usdToErn) })); } catch (error) { Alert.alert("Buying rates", errorMessage(error)); } finally { setBusy(""); } };
  const saveStatementRate = async (currency: Currency) => { if (offline) return Alert.alert("Offline", "Reconnect before saving rates."); setBusy(`rate-${currency}`); const draft = statementRates[currency]; try { onState(await updateMasterRateSetting(currency, { enabled: draft.enabled, divider: Number(draft.divider), percent: Number(draft.percent) })); } catch (error) { Alert.alert("Income statement rate", errorMessage(error)); } finally { setBusy(""); } };
  const saveUsdAgentRate = async (actorId: string) => { if (offline) return Alert.alert("Offline", "Reconnect before saving rates."); setBusy(`usd-agent-rate-${actorId}`); const draft = usdAgentRates[actorId] || { divider: "1", percent: "0" }; try { onState(await updateUsdAgentIncomeRate(actorId, { divider: Number(draft.divider), percent: Number(draft.percent) })); } catch (error) { Alert.alert("USD Agent payout rate", errorMessage(error)); } finally { setBusy(""); } };
  const updateActor = async (actorId: string, input: Parameters<typeof updateActorOrderSettings>[1]) => { if (offline) return Alert.alert("Offline", "Reconnect before changing permissions."); setBusy(actorId); try { onState(await updateActorOrderSettings(actorId, input)); } catch (error) { Alert.alert("Permissions", errorMessage(error)); } finally { setBusy(""); } };
  const reset = () => {
    if (resetPermit !== "MASTER-RESET") return Alert.alert("Master reset", "Enter MASTER-RESET to continue.");
    Alert.alert(resetScope === "wipe" ? "Wipe all workspace data?" : "Erase financial data?", resetScope === "wipe" ? "This removes data, actors, actor accounts, and invite codes." : "This erases financial records but keeps actors.", [
      { text: "Cancel", style: "cancel" },
      { text: resetScope === "wipe" ? "Wipe" : "Erase", style: "destructive", onPress: async () => { setBusy("reset"); try { onState(await resetWorkspaceData(resetScope)); setResetPermit(""); } catch (error) { Alert.alert("Master reset", errorMessage(error)); } finally { setBusy(""); } } }
    ]);
  };
  const resetActor = () => {
    const actor = resettableActors.find((item) => item.name === selectedResetActorName);
    if (!actor) return Alert.alert("Reset Actor", "Choose an Actor to reset.");
    Alert.alert(
      `Reset ${actor.name}?`,
      "Active orders, receivables, transfers, saved customers, and authored chat messages will be erased. Ledger, Master Bank, Report, login, and Actor settings will remain.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset Actor",
          style: "destructive",
          onPress: async () => {
            setBusy(`reset-actor-${actor.id}`);
            try {
              onState(await resetWorkspaceActorData(actor.id));
              Alert.alert("Actor reset", `${actor.name}'s active data was erased. Ledger and Report records were preserved.`);
            } catch (error) {
              Alert.alert("Reset Actor", errorMessage(error));
            } finally {
              setBusy("");
            }
          }
        }
      ]
    );
  };
  const roles: ActorRole[] = ["Broker", "Agent", "Special Broker", "Special Agent"];
  return (
    <View style={styles.screen}>
      <ScreenTitle title="Settings" subtitle="Account and workspace permissions" />
      <OfflineGuard offline={offline} />
      <Panel title="Reset password"><Field label="Current password" value={currentPassword} onChangeText={setCurrentPassword} secureTextEntry /><Field label="New password" value={newPassword} onChangeText={setNewPassword} secureTextEntry /><Button label="Update password" loading={busy === "password"} disabled={offline} onPress={change} /></Panel>
      <Panel title="Time Out" badge="Automatic logout"><SelectRow label="Inactive for" options={timeoutOptions} value={timeoutLabel} onChange={setTimeoutLabel} /><Button label="Save Time Out" loading={busy === "timeout"} disabled={offline} onPress={saveTimeout} /></Panel>
      {master ? <>
        <Panel title="Buying rates" badge="Income statement"><Field label="EUR to USD" value={buying.eurToUsd} onChangeText={(value) => setBuying({ ...buying, eurToUsd: value })} keyboardType="decimal-pad" /><Field label="USD to ETB" value={buying.usdToEtb} onChangeText={(value) => setBuying({ ...buying, usdToEtb: value })} keyboardType="decimal-pad" /><Field label="USD to ERN" value={buying.usdToErn} onChangeText={(value) => setBuying({ ...buying, usdToErn: value })} keyboardType="decimal-pad" /><Button label="Save buying rates" loading={busy === "buying"} disabled={offline} onPress={saveRates} /></Panel>
        <Panel title="Income statement rates" badge="Future orders only">
          {supportedCurrencies.map((currency) => {
            const draft = statementRates[currency];
            return <View key={currency} style={styles.permissionRow}><ToggleChoice label={`${currency} rate enabled`} checked={draft.enabled} disabled={offline} onPress={() => setStatementRates({ ...statementRates, [currency]: { ...draft, enabled: !draft.enabled } })} /><Field label={`${currency} divisor`} value={draft.divider} onChangeText={(value) => setStatementRates({ ...statementRates, [currency]: { ...draft, divider: value } })} keyboardType="decimal-pad" /><Field label="Percent" value={draft.percent} onChangeText={(value) => setStatementRates({ ...statementRates, [currency]: { ...draft, percent: value } })} keyboardType="decimal-pad" /><Button label={`Save ${currency}`} variant="secondary" loading={busy === `rate-${currency}`} disabled={offline} onPress={() => saveStatementRate(currency)} /></View>;
          })}
          <Pressable style={styles.showMore} onPress={() => setUsdAgentRatesExpanded((current) => !current)}>
            <Text style={styles.linkText}>USD Agent payout divisors</Text>
            {usdAgentRatesExpanded ? <ChevronUp size={17} color={colors.accent} /> : <ChevronDown size={17} color={colors.accent} />}
          </Pressable>
          {usdAgentRatesExpanded ? (
            usdPayoutActors.length ? usdPayoutActors.map((actor) => {
              const draft = usdAgentRates[actor.id] || {
                divider: String(actor.incomeUsdPayoutSetting?.divider || 1),
                percent: String(actor.incomeUsdPayoutSetting?.percent || 0)
              };
              return (
                <View key={actor.id} style={styles.permissionRow}>
                  <Text style={styles.primaryLine}>{actor.name} - {actor.role}</Text>
                  <Field label="USD payout divisor" value={draft.divider} onChangeText={(value) => setUsdAgentRates((current) => ({ ...current, [actor.id]: { ...draft, divider: value } }))} keyboardType="decimal-pad" />
                  <Field label="Percent (%)" value={draft.percent} onChangeText={(value) => setUsdAgentRates((current) => ({ ...current, [actor.id]: { ...draft, percent: value } }))} keyboardType="decimal-pad" />
                  <Button label={`Save ${actor.name}`} variant="secondary" loading={busy === `usd-agent-rate-${actor.id}`} disabled={offline} onPress={() => saveUsdAgentRate(actor.id)} />
                </View>
              );
            }) : <Text style={styles.muted}>No active USD Agents.</Text>
          ) : null}
        </Panel>
        <Panel title="Actor permissions" badge="Orders and transfers">
          {activeActors(state).filter((actor) => actor.role !== "Master").map((actor) => {
            const visibility = actor.orderVisibilityPermissions || {};
            return (
              <View key={actor.id} style={styles.permissionRow}>
                <Text style={styles.primaryLine}>{actor.name} - {actor.role}</Text>
                <SelectRow label="Transfer access" options={["actor", "master", "both", "none"]} value={actor.transferMode || "master"} onChange={(mode) => setMode(actor.id, mode)} />
                <ToggleChoice
                  label="Send and receive transfers in multiple currencies"
                  checked={actor.transferReceiveMultiCurrencyEnabled === true}
                  disabled={offline || busy === actor.id}
                  onPress={() => updateActor(actor.id, { transferReceiveMultiCurrencyEnabled: actor.transferReceiveMultiCurrencyEnabled !== true })}
                />
                {["Broker", "Special Broker"].includes(actor.role) ? <ToggleChoice label="Multi-currency orders" checked={actor.orderMultiCurrencyEnabled === true} disabled={offline || busy === actor.id} onPress={() => updateActor(actor.id, { orderMultiCurrencyEnabled: actor.orderMultiCurrencyEnabled !== true })} /> : null}
                {["Agent", "Special Agent", "Special Broker"].includes(actor.role) ? <View style={styles.choiceWrap}>{([['sourceCurrency', 'Source currency'], ['rate', 'Rate'], ['commission', 'Commission'], ['baseAmount', 'Base currency and amount']] as const).map(([key, label]) => <ToggleChoice key={key} label={label} checked={visibility[key] !== false} disabled={offline || busy === actor.id} onPress={() => updateActor(actor.id, { visibility: { [key]: visibility[key] === false } })} />)}</View> : null}
              </View>
            );
          })}
        </Panel>
        <Panel title="Invite codes"><View style={styles.rowButtons}><Button label="Load codes" variant="secondary" icon={<RefreshCw size={17} color={colors.ink} />} loading={busy === "invites"} onPress={refreshInvites} style={styles.flexButton} /><Button label="New code" icon={<Plus size={17} color="#fff" />} loading={busy === "invite-create"} onPress={addInvite} style={styles.flexButton} /></View><SelectRow label="Role" options={roles} value={inviteRole} onChange={setInviteRole} /><SelectRow label="Base currency" options={supportedCurrencies} value={inviteCurrency} onChange={setInviteCurrency} />{invites.map((invite) => <SummaryRow key={invite.id || invite.code} label={`${invite.actorRole} - ${invite.currency}`} value={invite.code || "Used"} strong />)}</Panel>
        <Panel title="Reset specific Actor" badge="Keeps Ledger & Report">
          {resettableActors.length ? <>
            <SelectRow label="Actor" options={resettableActors.map((actor) => actor.name)} value={selectedResetActorName} onChange={setResetActorName} />
            <Text style={styles.muted}>Erase this Actor's active data while preserving Ledger, Master Bank, Report, login, and settings.</Text>
            <Button label="Reset selected Actor" variant="danger" disabled={offline} loading={busy === `reset-actor-${resettableActors.find((actor) => actor.name === selectedResetActorName)?.id || ""}`} onPress={resetActor} />
          </> : <Text style={styles.muted}>No active Actors are available.</Text>}
        </Panel>
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
  const [currency, setCurrency] = useState<Currency>("USD");
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
    try { await createOwnerMaster({ name, email, password, currency, plan }); setName(""); setEmail(""); setPassword(""); await refresh(); } catch (error) { Alert.alert("Create Master", errorMessage(error)); } finally { setBusy(""); }
  };
  const change = async (id: string, task: () => Promise<void>) => {
    if (offline) return Alert.alert("Offline", "Reconnect before changing subscriptions.");
    setBusy(id);
    try { await task(); await refresh(); } catch (error) { Alert.alert("Subscription", errorMessage(error)); } finally { setBusy(""); }
  };
  return <View style={styles.screen}><ScreenTitle title="Owner" subtitle="Create Masters and manage access" /><OfflineGuard offline={offline} /><Button label="Refresh subscriptions" icon={<RefreshCw size={17} color={colors.ink} />} variant="secondary" loading={busy === "refresh"} onPress={refresh} /><Panel title="Create Master"><Field label="Master name" value={name} onChangeText={setName} /><Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" /><Field label="Password" value={password} onChangeText={setPassword} secureTextEntry /><SelectRow label="Base currency" options={supportedCurrencies} value={currency} onChange={setCurrency} /><Text style={styles.fieldLabel}>Subscription</Text><View style={styles.choiceWrap}>{(plans.length ? plans : [{ id: "one_month", label: "One month" }]).map((item) => <Pressable key={item.id} onPress={() => setPlan(item.id)} style={[styles.choice, plan === item.id && styles.choiceActive]}><Text style={[styles.choiceText, plan === item.id && styles.choiceTextActive]}>{item.label}</Text></Pressable>)}</View><Button label="Create Master" loading={busy === "create"} disabled={offline} onPress={create} /></Panel><Panel title="Master subscriptions" badge={String(users.length)}>{users.map((user) => <View key={user.userId} style={styles.recordRow}><View style={styles.recordMain}><Text style={styles.primaryLine}>{user.name}</Text><Text style={styles.muted}>{user.email} - {user.workspace} - {user.currency || "USD"}</Text><Text style={styles.muted}>{user.active ? (user.expired ? "Expired" : "Active") : "Inactive"} - {new Date(user.expiresAt || 0).toLocaleDateString()}</Text></View><View style={styles.rowButtons}><Button label={user.active ? "Deactivate" : "Activate"} variant={user.active ? "danger" : "secondary"} disabled={offline} loading={busy === `active-${user.userId}`} onPress={() => change(`active-${user.userId}`, () => setOwnerMasterActive(user.userId, !user.active))} style={styles.flexButton} /><Button label="Add time" disabled={offline} loading={busy === `extend-${user.userId}`} onPress={() => change(`extend-${user.userId}`, () => extendOwnerSubscription(user.userId, user.plan || plan, "extend"))} style={styles.flexButton} /><Button label="Restart" variant="secondary" disabled={offline} loading={busy === `reset-${user.userId}`} onPress={() => change(`reset-${user.userId}`, () => extendOwnerSubscription(user.userId, user.plan || plan, "reset"))} style={styles.flexButton} /></View></View>)}</Panel></View>;
}

export function NotificationsPanel({ session, state, onNavigate }: { session: UserSession; state: WorkspaceState; onNavigate: (screen: AppScreen) => void }) {
  const pendingOrders = isMasterView(session) ? state.orders.filter((order) => order.state === "Pending Forward" || order.state === "Void Requested").length : state.orders.filter((order) => order.state === "Assigned" && (order.agentActorId === session.actorId || order.agent === session.actorName)).length;
  const pendingTransfers = isMasterView(session)
    ? state.transfers.filter((transfer) => transfer.state === "Pending Approval").length
    : state.transfers.filter((transfer) => transfer.state === "Pending Acceptance" && (transfer.toActorId === session.actorId || transfer.to === session.actorName)).length;
  if (!pendingOrders && !pendingTransfers) return null;
  return <Panel title="Action required" badge={String(pendingOrders + pendingTransfers)}>{pendingOrders ? <Pressable style={styles.noticeRow} onPress={() => onNavigate("orders")}><MessageSquare size={18} color={colors.warn} /><Text style={styles.noticeText}>{pendingOrders} order action{pendingOrders === 1 ? "" : "s"} pending</Text></Pressable> : null}{pendingTransfers ? <Pressable style={styles.noticeRow} onPress={() => onNavigate("transfers")}><MessageSquare size={18} color={colors.warn} /><Text style={styles.noticeText}>{pendingTransfers} transfer {isMasterView(session) ? "approval" : "acceptance"}{pendingTransfers === 1 ? "" : "s"} pending</Text></Pressable> : null}</Panel>;
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
  sectionLabel: { color: colors.ink, fontSize: 14, fontWeight: "900" },
  showMore: { minHeight: 38, borderTopWidth: 1, borderTopColor: colors.line, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  linkText: { color: colors.accent, fontWeight: "900" },
  detailBlock: { gap: 0 },
  actionBlock: { gap: spacing.md, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: spacing.md },
  forwardTransferBlock: { gap: spacing.md, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: spacing.md },
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
  messageImage: { width: 240, maxWidth: "100%", height: 180, borderRadius: radius.sm, backgroundColor: colors.panel },
  attachmentButton: { minHeight: 38, flexDirection: "row", alignItems: "center", gap: spacing.sm, borderRadius: radius.sm, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line },
  attachmentText: { color: colors.accent, fontSize: 12, fontWeight: "800", flexShrink: 1 },
  messageTime: { color: colors.muted, fontSize: 10 },
  messageReply: { borderLeftWidth: 3, borderLeftColor: colors.returned, backgroundColor: colors.panel, borderRadius: radius.sm, padding: spacing.sm, gap: 2 },
  messageReplyFrom: { color: colors.ink, fontSize: 11, fontWeight: "900" },
  messageReplyText: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  reactionList: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, paddingTop: spacing.xs },
  reactionChip: { color: colors.ink, fontSize: 11, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm, paddingHorizontal: spacing.sm, paddingVertical: 3 },
  messageActions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, paddingTop: spacing.xs },
  messageAction: { minHeight: 32, flexDirection: "row", alignItems: "center", gap: spacing.xs, borderRadius: radius.sm, paddingHorizontal: spacing.sm, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line },
  messageActionActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  messageActionText: { color: colors.muted, fontSize: 11, fontWeight: "800" },
  messageActionTextActive: { color: colors.accent },
  composerPreview: { flexDirection: "row", alignItems: "center", gap: spacing.sm, borderLeftWidth: 3, borderLeftColor: colors.returned, backgroundColor: colors.panel2, borderRadius: radius.sm, padding: spacing.sm },
  composerPreviewText: { flex: 1, gap: 2 },
  previewClose: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  forwardPicker: { gap: spacing.sm, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: spacing.md },
  ledgerTable: { minWidth: 940, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, overflow: "hidden" },
  ledgerRow: { minHeight: 62, flexDirection: "row", alignItems: "center", borderBottomWidth: 1, borderBottomColor: colors.line, backgroundColor: colors.panel },
  ledgerHead: { minHeight: 48, backgroundColor: colors.panel2 },
  ledgerVoidRow: { backgroundColor: colors.dangerSoft, borderBottomColor: colors.cancelledSoft },
  ledgerVoidText: { color: colors.danger },
  colDate: { width: 95, padding: spacing.sm, color: colors.ink },
  colRef: { width: 130, padding: spacing.sm, color: colors.ink, fontWeight: "800" },
  colDirection: { width: 90, padding: spacing.sm, color: colors.ink },
  colAmount: { width: 135, padding: spacing.sm, color: colors.ink, fontWeight: "900" },
  colDetails: { width: 470, padding: spacing.sm, color: colors.muted },
  bankBalanceList: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, overflow: "hidden" },
  bankBalanceRow: { minHeight: 42, paddingHorizontal: spacing.md, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: 1, borderBottomColor: colors.line, backgroundColor: colors.panel2 },
  bankBalanceCurrency: { color: colors.ink, fontWeight: "900" },
  bankBalanceAmount: { fontWeight: "900" },
  bankSection: { gap: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.line },
  bankStatementRow: { gap: spacing.sm, paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.line },
  bankStatementHead: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: spacing.md },
  bankReference: { color: colors.accent, fontSize: 12, fontWeight: "900" },
  bankAmountGrid: { flexDirection: "row", gap: spacing.sm },
  bankAmountCell: { flex: 1, minWidth: 0, gap: spacing.xs },
  bankAmountLabel: { color: colors.muted, fontSize: 10, fontWeight: "800" },
  bankAmountValue: { fontSize: 12, fontWeight: "900" },
  bankMoneyIn: { color: colors.good, fontWeight: "900" },
  bankMoneyOut: { color: colors.danger, fontWeight: "900" },
  bankPeriodTotals: { gap: spacing.sm, paddingTop: spacing.sm },
  bankPeriodRow: { minHeight: 42, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm, borderTopWidth: 1, borderTopColor: colors.line },
  permissionRow: { gap: spacing.sm, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.line },
  toggleRow: { minHeight: 38, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: 3 },
  disabled: { opacity: 0.5 },
  checkBox: { width: 22, height: 22, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.panel, alignItems: "center", justifyContent: "center" },
  checkBoxActive: { borderColor: colors.accent, backgroundColor: colors.accent },
  toggleLabel: { color: colors.ink, fontWeight: "800", flexShrink: 1 },
  noticeRow: { minHeight: 42, flexDirection: "row", alignItems: "center", gap: spacing.sm },
  noticeText: { color: colors.ink, fontWeight: "800" }
});
