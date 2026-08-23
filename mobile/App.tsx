import { StatusBar } from "expo-status-bar";
import { Asset } from "expo-asset";
import * as FileSystem from "expo-file-system";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  BackHandler,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View
} from "react-native";
import {
  Archive as ArchiveIcon,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronDown,
  ChevronUp,
  FileDown,
  LayoutDashboard,
  Menu,
  LockKeyhole,
  LogIn,
  LogOut,
  RefreshCw,
  Repeat2,
  Scale,
  Send,
  UserPlus
} from "lucide-react-native";
import type { LucideProps } from "lucide-react-native";
import {
  canCreateOrders,
  currentWorkspaceSession,
  getAccountDeviceWarning,
  getLastSessionActivityAt,
  getCurrentSession,
  loadWorkspaceState,
  loadWorkspaceStateIfChanged,
  login,
  logout,
  rememberSessionActivity,
  reportSessionActivity,
  signup,
  submitTransferOrder
} from "./src/api/client";
import { BrandHeader, Button, Field, Panel, Pill, SelectRow, setUserActivityHandler, SummaryRow } from "./src/components/ui";
import type { PillTone } from "./src/components/ui";
import { colors, radius, shadow, spacing } from "./src/theme";
import { actingSessionFor, activeActors, calculableLedgerLines, isMasterView, orderRecordIsVoided, orderSortForSession, transferTargetsFor } from "./src/domain/workspace";
import { ledgerLineBelongsToActor } from "./src/domain/ledgerNumbering";
import { buildArchiveReportPdfHtml } from "./src/domain/reportPdf";
import { readMobileRoutingAction, type MobileRoutingActionRecord } from "./src/domain/routingDurability";
import { recoverMobileRoutingAction } from "./src/domain/routingRecovery";
import { useProgressiveLimit } from "./src/hooks/useProgressiveLimit";
import { notifyNewRequiredActions, subscribeToActionNotificationResponses } from "./src/notifications/actionNotifications";
import {
  ActorsScreen,
  ChatScreen,
  LedgerScreen,
  NotificationsPanel,
  OwnerScreen,
  OrdersScreen,
  PendingCancelledScreen,
  ProfilesScreen,
  ReceivablesScreen,
  SearchScreen,
  SettingsScreen,
  TransfersScreen
} from "./src/screens/WorkspaceScreens";
import type {
  AccountDeviceWarning,
  ActorRecord,
  AppScreen,
  ArchiveRecord,
  AuthMode,
  Currency,
  FundingType,
  OrderRecord,
  ReceivableRecord,
  SavedCustomerRecord,
  SubmittedOrder,
  TransferDraft,
  UserSession,
  WorkspaceState
} from "./src/types";
import { formatDate, formatDateTime, formatMonthYear } from "./src/utils/date";
import { calculateQuote, compactAmount, currencies, financialPosition, fixedOrderCommissionForActor, fixedOrderRateForActor, formatAmount, inputAmount, inputRate, majorFromMinor, reconcileFixedOrderConversion, reconcileOrderConversion } from "./src/utils/money";
import { orderArchivedForActor } from "./src/utils/orderParticipantRetention";
import type { OrderConversionField } from "./src/utils/money";

type IconComponent = React.ComponentType<LucideProps>;

const emptyDraft: TransferDraft = {
  broker: "",
  sourceCurrency: "USD",
  payoutCurrency: "ETB",
  sourceAmount: "",
  payoutAmount: "",
  rate: "",
  commissionPercent: "",
  fundingType: "cash",
  senderName: "",
  receiverName: "",
  receiverCity: "",
  phoneNumber: "",
  accountNumber: "",
  remarks: "",
  creditReminder: ""
};

function draftForSession(session: UserSession): TransferDraft {
  return {
    ...emptyDraft,
    broker: session.actorName,
    sourceCurrency: session.currency
  };
}

function draftForOrder(order: OrderRecord, workspaceState: WorkspaceState | null): TransferDraft {
  const receivable = workspaceState?.receivables.find((item) => item.orderId === order.id);
  return {
    broker: order.broker,
    sourceCurrency: order.sourceCurrency,
    payoutCurrency: order.payoutCurrency,
    sourceAmount: inputAmount(order.sourceCurrency, majorFromMinor(order.sourceAmountMinor, order.sourceCurrency)),
    payoutAmount: inputAmount(order.payoutCurrency, majorFromMinor(order.payoutAmountMinor, order.payoutCurrency)),
    rate: String(order.rate || ""),
    commissionPercent: String(order.commissionPercent || ""),
    fundingType: order.fundingType || "cash",
    senderName: order.senderName || "",
    receiverName: order.receiverName || "",
    receiverCity: order.receiverCity || receivable?.receiverCity || "",
    phoneNumber: order.phoneNumber || "",
    accountNumber: order.accountNumber || "",
    remarks: order.remarks || "",
    creditReminder: order.fundingType === "credit" ? receivable?.creditReminder || "" : ""
  };
}

function actorForSession(session: UserSession, workspaceState: WorkspaceState | null): ActorRecord | undefined {
  return workspaceState?.actors.find((actor) => actor.id === session.actorId) ||
    workspaceState?.actors.find((actor) => actor.name === session.actorName);
}

function orderBrokerMatchesSession(order: OrderRecord, session: UserSession): boolean {
  return order.brokerActorId
    ? order.brokerActorId === session.actorId
    : order.broker === session.actorName;
}

function orderAgentMatchesSession(order: OrderRecord, session: UserSession): boolean {
  return order.agentActorId
    ? order.agentActorId === session.actorId
    : order.agent === session.actorName;
}

function visibleOrdersFor(session: UserSession, workspaceState: WorkspaceState | null): OrderRecord[] {
  const orders = workspaceState?.orders || [];
  const visible = session.actorRole === "Master"
    ? orders
    : orders.filter((order) =>
        (orderBrokerMatchesSession(order, session) ||
          orderAgentMatchesSession(order, session)) &&
        !orderArchivedForActor(order, session.actorId, session.actorName, workspaceState?.archives || [])
      );
  return visible
    .filter((order) => !["Voided", "Cancelled"].includes(order.state) && order.locked !== true)
    .slice()
    .sort(orderSortForSession(session));
}

function orderIsAssignedUnpaid(order: OrderRecord): boolean {
  return order.state === "Assigned" &&
    !order.paidAt &&
    !order.journal &&
    !order.cancelledAt &&
    !order.voidedAt;
}

function assignedUnpaidOrdersFor(session: UserSession, workspaceState: WorkspaceState | null): OrderRecord[] {
  return (workspaceState?.orders || []).filter((order) => {
    if (!orderIsAssignedUnpaid(order)) return false;
    if (session.actorRole === "Master") return true;
    if (order.agentActorId && session.actorId) return order.agentActorId === session.actorId;
    return order.agent === session.actorName;
  });
}

function stateTone(state: OrderRecord["state"]): PillTone {
  if (state === "Assigned") return "assigned";
  if (state === "Returned") return "returned";
  if (state === "Cancelled") return "cancelled";
  if (state === "Voided") return "voided";
  if (state === "Paid") return "good";
  if (["Pending Forward", "Void Requested"].includes(state)) return "warn";
  return "neutral";
}

function actorCanReceivePayouts(role: UserSession["actorRole"]): boolean {
  return ["Agent", "Special Agent", "Special Broker"].includes(role);
}

function orderNumber(order: OrderRecord, session: UserSession): string {
  if (actorCanReceivePayouts(session.actorRole) && orderAgentMatchesSession(order, session)) {
    return order.agentOrderNumbers?.[session.actorName] || order.agentOrderNumber || order.brokerOrderNumber || order.id;
  }
  return order.brokerOrderNumber || order.id;
}

function orderStateLabel(session: UserSession, order: OrderRecord): string {
  if (session.actorRole === "Master" && order.state === "Assigned" && order.agent && order.agent !== "Unassigned") {
    return `Assigned to '${order.agent}'`;
  }
  return order.state;
}

function archiveMonthKey(value: string | undefined): string {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function archiveMonthLabel(monthKey: string): string {
  return formatMonthYear(monthKey);
}

function archiveClosedLabel(value: string | undefined): string {
  return formatDateTime(value, "Unknown close time");
}

let reportPdfFontPromise: Promise<string> | null = null;

function reportPdfFontBase64(): Promise<string> {
  if (reportPdfFontPromise) return reportPdfFontPromise;
  reportPdfFontPromise = (async () => {
    const asset = Asset.fromModule(require("./assets/fonts/NotoSansEthiopic-Regular.ttf"));
    await asset.downloadAsync();
    const uri = asset.localUri || asset.uri;
    if (!uri) throw new Error("The report font could not be loaded.");
    return FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  })().catch((error) => {
    reportPdfFontPromise = null;
    throw error;
  });
  return reportPdfFontPromise;
}

function visibleArchivesFor(session: UserSession, workspaceState: WorkspaceState | null): ArchiveRecord[] {
  return (workspaceState?.archives || [])
    .filter((archive) => session.actorRole === "Master" || (archive.actorId
      ? archive.actorId === session.actorId
      : archive.actor === session.actorName))
    .slice()
    .sort((a, b) => new Date(b.closedAt || 0).getTime() - new Date(a.closedAt || 0).getTime());
}

function savedCustomersFor(session: UserSession, workspaceState: WorkspaceState | null, kind: SavedCustomerRecord["kind"]): SavedCustomerRecord[] {
  return (workspaceState?.savedCustomers || [])
    .filter((customer) => customer.actorId === session.actorId && customer.kind === kind)
    .slice()
    .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());
}

type SettlementRow = { actor: ActorRecord; currency: Currency; netMinor: number };

function settlementRowsFor(session: UserSession, workspaceState: WorkspaceState | null): SettlementRow[] {
  if (!workspaceState) return [];
  const actors = (workspaceState?.actors || []).filter((actor) => actor.active !== false && actor.role !== "Master");
  const visibleActors = session.actorRole === "Master" ? actors : actors.filter((actor) => actor.id === session.actorId);
  const balances = new Map<string, Partial<Record<Currency, number>>>();
  calculableLedgerLines(workspaceState).forEach((line) => {
    const actor = actors.find((candidate) => ledgerLineBelongsToActor(line, candidate.name));
    if (!actor) return;
    const balance = balances.get(actor.id) || {};
    balance[line.currency] = Number(balance[line.currency] || 0) + (line.direction === "Debit" ? 1 : -1) * Number(line.amountMinor || 0);
    balances.set(actor.id, balance);
  });
  return visibleActors.flatMap((actor) => currencies.map((currency) => ({
    actor,
    currency,
    netMinor: Number(balances.get(actor.id)?.[currency] || 0)
  })).filter((row) => row.netMinor !== 0 || row.currency === actor.currency));
}

export default function App() {
  const [session, setSession] = useState<UserSession | null>(null);
  const [booting, setBooting] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);
  const [screen, setScreen] = useState<AppScreen>("home");
  const [selectedActorId, setSelectedActorId] = useState("");
  const [editingOrderId, setEditingOrderId] = useState("");
  const [draft, setDraft] = useState<TransferDraft>(emptyDraft);
  const [submittedOrder, setSubmittedOrder] = useState<SubmittedOrder | null>(null);
  const [workspaceState, setWorkspaceState] = useState<WorkspaceState | null>(null);
  const [stateLoading, setStateLoading] = useState(false);
  const [stateError, setStateError] = useState("");
  const [routingAction, setRoutingAction] = useState<MobileRoutingActionRecord | null>(null);
  const [routingActionBusy, setRoutingActionBusy] = useState(false);
  const [accountDeviceWarning, setAccountDeviceWarning] = useState<AccountDeviceWarning | null>(null);
  const [lastActivityAt, setLastActivityAt] = useState(Date.now());
  const historyRef = useRef<AppScreen[]>(["home"]);
  const contentScrollRef = useRef<ScrollView>(null);
  const lastActivityRef = useRef(Date.now());
  const lastServerActivityRef = useRef(0);
  const logoutInFlightRef = useRef(false);
  const routingActionRef = useRef<MobileRoutingActionRecord | null>(null);
  const routingActionBusyRef = useRef(false);
  const accountDeviceWarningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedActor = workspaceState?.actors.find((actor) => actor.id === selectedActorId);
  const actingSession = session ? actingSessionFor(session, selectedActor) : null;
  const quote = useMemo(() => calculateQuote(draft), [draft]);

  const handleRoutingActionChange = useCallback((nextAction: MobileRoutingActionRecord | null) => {
    routingActionRef.current = nextAction;
    setRoutingAction(nextAction);
  }, []);

  const handleRoutingBusyChange = useCallback((busy: boolean) => {
    routingActionBusyRef.current = busy;
    setRoutingActionBusy(busy);
  }, []);

  useEffect(() => {
    let mounted = true;
    getCurrentSession()
      .then(async (savedSession) => {
        if (!mounted || !savedSession) return;
        const cachedActivityAt = await getLastSessionActivityAt();
        if (!mounted) return;
        const activityAt = cachedActivityAt || Date.now();
        lastActivityRef.current = activityAt;
        setLastActivityAt(activityAt);
        setSession(savedSession);
        setDraft(draftForSession(savedSession));
        if (savedSession.role === "Owner") {
          historyRef.current = ["owner"];
          setScreen("owner");
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (mounted) setBooting(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!session) return;
    let mounted = true;
    setStateLoading(true);
    setStateError("");
    handleRoutingBusyChange(true);
    loadWorkspaceState()
      .then((state) => recoverMobileRoutingAction(session, state))
      .then(({ state, action }) => {
        if (!mounted) return;
        setWorkspaceState(state);
        handleRoutingActionChange(action);
        if (action?.kind === "broker-send") {
          setDraft(action.draft);
          setEditingOrderId(action.editingOrderId);
          setSubmittedOrder(null);
          if (action.order.brokerActorId) setSelectedActorId(action.order.brokerActorId);
          historyRef.current = ["confirmation"];
          setScreen("confirmation");
        } else if (action?.kind === "master-forward") {
          historyRef.current = ["orders"];
          setScreen("orders");
        }
      })
      .catch((error) => {
        if (mounted) setStateError(error instanceof Error ? error.message : "Could not load workspace.");
      })
      .finally(() => {
        if (mounted) {
          setStateLoading(false);
          handleRoutingBusyChange(false);
        }
      });
    return () => {
      mounted = false;
    };
  }, [handleRoutingActionChange, handleRoutingBusyChange, session?.userId, session?.workspaceId]);

  useEffect(() => {
    if (!session || session.role === "Owner") return;
    let mounted = true;
    const timer = setInterval(() => {
      if (AppState.currentState !== "active" || routingActionRef.current || routingActionBusyRef.current) return;
      loadWorkspaceStateIfChanged()
        .then((state) => {
          if (mounted && state && !routingActionRef.current && !routingActionBusyRef.current) setWorkspaceState(state);
        })
        .catch(() => undefined);
    }, 3000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [session?.workspaceId, session?.role]);

  useEffect(() => {
    if (!session || session.role === "Owner") {
      setAccountDeviceWarning(null);
      return;
    }
    let mounted = true;
    const refreshWarning = () => {
      getAccountDeviceWarning()
        .then(({ warning, session: refreshedSession }) => {
          if (!mounted) return;
          if (refreshedSession) {
            setSession((current) => current?.userId === refreshedSession.userId ? refreshedSession : current);
          }
          if (accountDeviceWarningTimerRef.current) clearTimeout(accountDeviceWarningTimerRef.current);
          accountDeviceWarningTimerRef.current = null;
          const remaining = new Date(warning?.expiresAt || 0).getTime() - Date.now();
          if (!warning || !Number.isFinite(remaining) || remaining <= 0) {
            setAccountDeviceWarning(null);
            return;
          }
          setAccountDeviceWarning(warning);
          accountDeviceWarningTimerRef.current = setTimeout(() => {
            if (mounted) setAccountDeviceWarning(null);
            accountDeviceWarningTimerRef.current = null;
          }, Math.min(60000, remaining));
        })
        .catch(() => undefined);
    };
    refreshWarning();
    const interval = setInterval(() => {
      if (AppState.currentState === "active") refreshWarning();
    }, 3000);
    return () => {
      mounted = false;
      clearInterval(interval);
      if (accountDeviceWarningTimerRef.current) clearTimeout(accountDeviceWarningTimerRef.current);
      accountDeviceWarningTimerRef.current = null;
    };
  }, [session?.role, session?.userId, session?.workspaceId]);

  useEffect(() => {
    if (!session || !workspaceState || session.role === "Owner") return;
    void notifyNewRequiredActions(session, workspaceState).catch(() => undefined);
  }, [session?.actorId, session?.role, session?.workspaceId, workspaceState]);

  useEffect(() => {
    if (!session || session.role === "Owner") return;
    return subscribeToActionNotificationResponses((target) => {
      if (historyRef.current[historyRef.current.length - 1] !== target) historyRef.current.push(target);
      setScreen(target);
    });
  }, [session?.workspaceId, session?.role]);

  const orderFlowAllowed = canCreateOrders(actingSession);
  const currentScreen = !orderFlowAllowed && ["newOrder", "conversion", "confirmation"].includes(screen) ? "home" : screen;

  useEffect(() => {
    if (!orderFlowAllowed && ["newOrder", "conversion", "confirmation"].includes(screen)) setScreen("home");
  }, [orderFlowAllowed, screen]);

  const navigate = (next: AppScreen) => {
    const protectedScreen = routingActionRef.current?.kind === "broker-send"
      ? "confirmation"
      : routingActionRef.current?.kind === "master-forward"
        ? "orders"
        : "";
    if ((protectedScreen && next !== protectedScreen) || routingActionBusyRef.current) {
      Alert.alert("Order action in progress", "Finish the protected order action before opening another page.");
      return;
    }
    if (next === screen) return;
    historyRef.current.push(next);
    setScreen(next);
  };

  const goBack = () => {
    if (routingActionRef.current || routingActionBusyRef.current) {
      Alert.alert("Order action in progress", "Finish the protected order action before leaving this page.");
      return false;
    }
    if (historyRef.current.length <= 1) return false;
    historyRef.current.pop();
    setScreen(historyRef.current[historyRef.current.length - 1] || "home");
    return true;
  };

  useEffect(() => {
    if (!session) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => goBack());
    return () => subscription.remove();
  }, [session, screen]);

  const refreshWorkspace = async () => {
    if (!session) return;
    if (routingActionRef.current || routingActionBusyRef.current) {
      Alert.alert("Refresh paused", "Finish the protected order action first. This prevents a refresh from interrupting it.");
      return;
    }
    setStateLoading(true);
    setStateError("");
    try {
      setWorkspaceState(await loadWorkspaceState());
    } catch (error) {
      setStateError(error instanceof Error ? error.message : "Could not load workspace.");
    } finally {
      setStateLoading(false);
    }
  };

  const handleAuthenticated = (nextSession: UserSession) => {
    const now = Date.now();
    lastActivityRef.current = now;
    lastServerActivityRef.current = now;
    setLastActivityAt(now);
    void rememberSessionActivity(now);
    setSession(nextSession);
    setDraft(draftForSession(nextSession));
    setSubmittedOrder(null);
    setSelectedActorId("");
    setEditingOrderId("");
    handleRoutingActionChange(null);
    handleRoutingBusyChange(false);
    const firstScreen: AppScreen = nextSession.role === "Owner" ? "owner" : "home";
    historyRef.current = [firstScreen];
    setScreen(firstScreen);
  };

  const performLogout = useCallback(async () => {
    if (logoutInFlightRef.current) return;
    logoutInFlightRef.current = true;
    setLoggingOut(true);
    setSession(null);
    setAccountDeviceWarning(null);
    setWorkspaceState(null);
    setSubmittedOrder(null);
    setSelectedActorId("");
    setEditingOrderId("");
    setDraft(emptyDraft);
    handleRoutingActionChange(null);
    handleRoutingBusyChange(false);
    historyRef.current = ["home"];
    setScreen("home");
    try {
      await logout();
    } catch {
      undefined;
    } finally {
      setLoggingOut(false);
      logoutInFlightRef.current = false;
    }
  }, [handleRoutingActionChange, handleRoutingBusyChange]);

  const handleLogout = useCallback(async (forced = false) => {
    if (!forced && (routingActionRef.current || routingActionBusyRef.current)) {
      Alert.alert(
        "Order delivery is not confirmed",
        "You can log out safely, but this exact order action will remain protected on this device. Sign back into the same account to check or retry it.",
        [
          { text: "Stay signed in", style: "cancel" },
          { text: "Log out anyway", style: "destructive", onPress: () => void performLogout() }
        ]
      );
      return;
    }
    await performLogout();
  }, [performLogout]);

  useEffect(() => {
    if (!session?.subscriptionReadOnly || !session.subscriptionGraceEndsAt) return;
    const remainingMs = new Date(session.subscriptionGraceEndsAt).getTime() - Date.now();
    if (!Number.isFinite(remainingMs)) return;
    if (remainingMs <= 0) {
      void handleLogout(true);
      return;
    }
    const timer = setTimeout(() => void handleLogout(true), remainingMs);
    return () => clearTimeout(timer);
  }, [handleLogout, session?.subscriptionGraceEndsAt, session?.subscriptionReadOnly]);

  const noteActivity = useCallback(() => {
    if (!session) return;
    const now = Date.now();
    if (now - lastActivityRef.current < 750) return;
    lastActivityRef.current = now;
    setLastActivityAt(now);
    void rememberSessionActivity(now);
    const idleTimeoutSeconds = Number(session.idleTimeoutSeconds ?? 7200);
    const reportEveryMs = idleTimeoutSeconds === 0 ? 30000 : Math.max(2000, Math.min(30000, idleTimeoutSeconds * 1000 / 3));
    if (now - lastServerActivityRef.current >= reportEveryMs) {
      lastServerActivityRef.current = now;
      void reportSessionActivity().catch(() => undefined);
    }
  }, [session]);

  useEffect(() => {
    setUserActivityHandler(noteActivity);
    return () => setUserActivityHandler(null);
  }, [noteActivity]);

  useEffect(() => {
    if (!session) return;
    const idleTimeoutSeconds = Number(session.idleTimeoutSeconds ?? 7200);
    if (idleTimeoutSeconds === 0) return;
    const idleMs = idleTimeoutSeconds * 1000;
    const remainingMs = Math.max(0, idleMs - (Date.now() - lastActivityAt));
    const timer = setTimeout(() => {
      if (Date.now() - lastActivityRef.current < idleMs || logoutInFlightRef.current) return;
      Alert.alert("Session timed out", "You were logged out because this account was inactive.");
      void handleLogout(true);
    }, remainingMs);
    return () => clearTimeout(timer);
  }, [handleLogout, lastActivityAt, session]);

  useEffect(() => {
    if (!session) return;
    const idleTimeoutSeconds = Number(session.idleTimeoutSeconds ?? 7200);
    if (idleTimeoutSeconds === 0) return;
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") return;
      const idleMs = idleTimeoutSeconds * 1000;
      if (Date.now() - lastActivityRef.current >= idleMs && !logoutInFlightRef.current) {
        Alert.alert("Session timed out", "You were logged out because this account was inactive.");
        void handleLogout(true);
      }
    });
    return () => subscription.remove();
  }, [handleLogout, session]);

  if (booting) {
    return <LoadingScreen />;
  }

  if (!session || !actingSession) {
    return <AuthScreen onAuthenticated={handleAuthenticated} />;
  }

  const startNewOrder = () => {
    setEditingOrderId("");
    setSubmittedOrder(null);
    setDraft(draftForSession(actingSession));
    navigate("newOrder");
  };

  const editReturnedOrder = (order: OrderRecord) => {
    setEditingOrderId(order.id);
    setSubmittedOrder(null);
    setDraft(draftForOrder(order, workspaceState));
    navigate("newOrder");
  };

  const offline = workspaceState?.offlineSnapshot === true;
  const commonProps = workspaceState ? {
    session: actingSession,
    state: workspaceState,
    offline,
    onState: setWorkspaceState,
    onNavigate: navigate,
    onRefresh: refreshWorkspace,
    onScrollToEnd: () => contentScrollRef.current?.scrollToEnd({ animated: true }),
    onSessionTimeout: (nextSession: UserSession) => {
      const now = Date.now();
      lastActivityRef.current = now;
      setLastActivityAt(now);
      setSession(nextSession);
    }
  } : null;

  return (
    <SafeAreaView style={styles.safe} onTouchStart={noteActivity}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView style={styles.app} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView ref={contentScrollRef} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          <AppTopBar
            session={actingSession}
            offline={offline}
            lastSyncedAt={workspaceState?.lastSyncedAt}
            canGoBack={historyRef.current.length > 1}
            onBack={goBack}
            onLogout={() => Alert.alert("Log out?", "This account will stay available offline until you log out.", [
              { text: "Cancel", style: "cancel" },
              { text: "Log out", style: "destructive", onPress: () => void handleLogout(false) }
            ])}
            loggingOut={loggingOut}
          />
          {accountDeviceWarning ? (
            <View style={styles.accountSecurityWarning} accessibilityRole="alert">
              <Text style={styles.accountSecurityWarningLabel}>WARNING</Text>
              <Text style={styles.accountSecurityWarningText}>{accountDeviceWarning.message || "Another device is logged into your account."}</Text>
            </View>
          ) : null}
          {actingSession.subscriptionReadOnly ? (
            <View style={styles.subscriptionReadOnlyWarning} accessibilityRole="alert">
              <Text style={styles.subscriptionReadOnlyWarningLabel}>READ ONLY</Text>
              <Text style={styles.subscriptionReadOnlyWarningText}>
                {`Viewing is available until ${formatDate(actingSession.subscriptionGraceEndsAt)}. Orders, transfers, forwarding, changes, and report exports are disabled.`}
              </Text>
            </View>
          ) : null}
          {stateError ? <Text style={styles.errorText}>{stateError}</Text> : null}
          {!workspaceState && stateLoading ? <View style={styles.loadingWrap}><ActivityIndicator color={colors.accent} /><Text style={styles.mutedText}>Loading workspace...</Text></View> : null}
          {workspaceState && actingSession.role !== "Owner" ? <NotificationsPanel session={actingSession} state={workspaceState} onNavigate={navigate} /> : null}
          {currentScreen === "owner" && actingSession.role === "Owner" ? <OwnerScreen offline={offline} /> : null}
          {currentScreen === "home" && (
            <HomeScreen
              session={actingSession}
              workspaceState={workspaceState}
              stateLoading={stateLoading}
              onRefresh={refreshWorkspace}
              onTransfer={startNewOrder}
              onConversion={() => navigate("conversion")}
              onSettlement={() => navigate("settlement")}
              onOrders={() => navigate("orders")}
              onTransfers={() => navigate("transfers")}
              onLedger={() => navigate("ledger")}
            />
          )}
          {commonProps && currentScreen === "orders" ? (
            <OrdersScreen
              {...commonProps}
              onNewOrder={startNewOrder}
              onEditReturnedOrder={editReturnedOrder}
              routingAction={routingAction}
              onRoutingActionChange={handleRoutingActionChange}
              onRoutingBusyChange={handleRoutingBusyChange}
            />
          ) : null}
          {commonProps && currentScreen === "pendingCancelled" && isMasterView(actingSession) ? <PendingCancelledScreen {...commonProps} /> : null}
          {commonProps && currentScreen === "transfers" ? <TransfersScreen {...commonProps} /> : null}
          {commonProps && currentScreen === "search" ? <SearchScreen {...commonProps} /> : null}
          {commonProps && currentScreen === "receivables" && (isMasterView(actingSession) || ["Broker", "Special Broker"].includes(actingSession.actorRole)) ? <ReceivablesScreen {...commonProps} /> : null}
          {commonProps && currentScreen === "chat" ? <ChatScreen {...commonProps} /> : null}
          {commonProps && currentScreen === "ledger" ? <LedgerScreen {...commonProps} /> : null}
          {commonProps && currentScreen === "actors" && isMasterView(actingSession) ? <ActorsScreen {...commonProps} /> : null}
          {commonProps && currentScreen === "profiles" && isMasterView(actingSession) ? <ProfilesScreen {...commonProps} /> : null}
          {commonProps && currentScreen === "settings" ? <SettingsScreen {...commonProps} /> : null}
          {workspaceState && currentScreen === "more" ? (
            <MoreScreen
              loginSession={session}
              session={actingSession}
              state={workspaceState}
              onNavigate={navigate}
              onSelectActor={(actorId) => {
                setSelectedActorId(actorId);
                setEditingOrderId("");
                const actor = workspaceState.actors.find((item) => item.id === actorId);
                setDraft(draftForSession(actingSessionFor(session, actor)));
                navigate("home");
              }}
              onLogout={() => Alert.alert("Log out?", "Your locally cached account will be removed from this device.", [{ text: "Cancel", style: "cancel" }, { text: "Log out", style: "destructive", onPress: () => void handleLogout(false) }])}
            />
          ) : null}
          {currentScreen === "settlement" && (
            <SettlementScreen session={actingSession} workspaceState={workspaceState} />
          )}
          {currentScreen === "archive" && (
            <ArchiveScreen
              session={actingSession}
              workspaceState={workspaceState}
              stateLoading={stateLoading}
              onRefresh={refreshWorkspace}
            />
          )}
          {orderFlowAllowed && currentScreen === "newOrder" && (
            <TransferScreen
              session={actingSession}
              workspaceState={workspaceState}
              draft={draft}
              setDraft={setDraft}
              quote={quote}
              editingOrderId={editingOrderId}
              onConversion={() => navigate("conversion")}
              onContinue={() => navigate("confirmation")}
            />
          )}
          {orderFlowAllowed && currentScreen === "conversion" && (
            <ConversionScreen
              session={actingSession}
              draft={draft}
              quote={quote}
              onEdit={() => navigate("newOrder")}
              onContinue={() => navigate("confirmation")}
            />
          )}
          {orderFlowAllowed && currentScreen === "confirmation" && (
            <ConfirmationScreen
              session={actingSession}
              draft={draft}
              quote={quote}
              submittedOrder={submittedOrder}
              editingOrderId={editingOrderId}
              routingAction={routingAction}
              routingActionBusy={routingActionBusy}
              onRoutingActionChange={handleRoutingActionChange}
              onRoutingBusyChange={handleRoutingBusyChange}
              onSubmitted={(order) => {
                setSubmittedOrder(order);
                setWorkspaceState(order.state);
              }}
              onEdit={() => navigate("newOrder")}
              onHome={() => {
                setSubmittedOrder(null);
                setEditingOrderId("");
                setDraft(draftForSession(actingSession));
                navigate("home");
              }}
            />
          )}
        </ScrollView>
        {currentScreen === "chat" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Go to the newest chat message"
            onPress={() => contentScrollRef.current?.scrollToEnd({ animated: true })}
            style={styles.chatBottomButton}
          >
            <ChevronDown size={17} color="#ffffff" strokeWidth={2.6} />
          </Pressable>
        ) : null}
        <BottomTabs session={actingSession} state={workspaceState} current={currentScreen} onChange={navigate} />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function LoadingScreen() {
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.loadingWrap}>
        <ActivityIndicator color={colors.accent} />
        <Text style={styles.mutedText}>Opening HaderaPay...</Text>
      </View>
    </SafeAreaView>
  );
}

function AuthScreen({ onAuthenticated }: { onAuthenticated: (session: UserSession) => void }) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [name, setName] = useState("");
  const [signupEmail, setSignupEmail] = useState("");
  const [signupPassword, setSignupPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");

  const submit = async () => {
    setLoading(true);
    setError("");
    try {
      const nextSession = mode === "login"
        ? await login(loginEmail, loginPassword)
        : await signup({ name, email: signupEmail, password: signupPassword, inviteCode });
      onAuthenticated(nextSession);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not continue.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView style={styles.authWrap} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.authScroll} showsVerticalScrollIndicator={false}>
          <Panel style={styles.authCard}>
            <BrandHeader subtitle="Clearing ledger" />
            <View style={styles.authTabs}>
              <Button
                label="Login"
                icon={<LogIn size={17} color={mode === "login" ? "#ffffff" : colors.ink} />}
                onPress={() => {
                  setMode("login");
                  setError("");
                }}
                variant={mode === "login" ? "primary" : "secondary"}
                style={styles.authTab}
              />
              <Button
                label="Signup"
                icon={<UserPlus size={17} color={mode === "signup" ? "#ffffff" : colors.ink} />}
                onPress={() => {
                  setMode("signup");
                  setError("");
                }}
                variant={mode === "signup" ? "primary" : "secondary"}
                style={styles.authTab}
              />
            </View>
            {mode === "login" ? (
              <View style={styles.formStack}>
                <Field label="Username or email" value={loginEmail} onChangeText={setLoginEmail} autoCapitalize="none" />
                <Field label="Password" value={loginPassword} onChangeText={setLoginPassword} secureTextEntry />
              </View>
            ) : (
              <View style={styles.formStack}>
                <Field label="Display name" value={name} onChangeText={setName} />
                <Field label="Email" value={signupEmail} onChangeText={setSignupEmail} autoCapitalize="none" keyboardType="email-address" />
                <Field label="Password" value={signupPassword} onChangeText={setSignupPassword} secureTextEntry />
                <Field label="Invite code" value={inviteCode} onChangeText={setInviteCode} autoCapitalize="characters" />
              </View>
            )}
            {error ? <Text style={styles.errorText}>{error}</Text> : null}
            <Button
              label={mode === "login" ? "Login" : "Create account"}
              onPress={submit}
              loading={loading}
              icon={mode === "login" ? <LogIn size={17} color="#ffffff" /> : <UserPlus size={17} color="#ffffff" />}
            />
          </Panel>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function AppTopBar({
  session,
  offline,
  lastSyncedAt,
  canGoBack,
  onBack,
  onLogout,
  loggingOut
}: {
  session: UserSession;
  offline: boolean;
  lastSyncedAt?: string;
  canGoBack: boolean;
  onBack: () => boolean;
  onLogout: () => void;
  loggingOut: boolean;
}) {
  return (
    <View style={styles.sessionBar}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Go back"
        disabled={!canGoBack}
        onPress={onBack}
        style={[styles.iconButton, !canGoBack && styles.iconButtonDisabled]}
      >
        <ChevronLeft size={22} color={canGoBack ? colors.ink : colors.muted} />
      </Pressable>
      <View style={styles.topBrand}>
        <Text style={styles.topBrandName}>HaderaPay</Text>
        <Text style={styles.topBrandSub} numberOfLines={1}>{session.actorName} - {session.actorRole}{offline && lastSyncedAt ? ` - synced ${formatDateTime(lastSyncedAt)}` : ""}</Text>
      </View>
      <View style={styles.sessionTools}>
        {offline ? <Pill label="Offline" tone="warn" /> : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Log out"
          onPress={onLogout}
          disabled={loggingOut}
          style={styles.iconButton}
        >
          {loggingOut ? <ActivityIndicator color={colors.accent} /> : <LogOut size={21} color={colors.danger} />}
        </Pressable>
      </View>
    </View>
  );
}

function MoreScreen({
  loginSession,
  session,
  state,
  onNavigate,
  onSelectActor,
  onLogout
}: {
  loginSession: UserSession;
  session: UserSession;
  state: WorkspaceState;
  onNavigate: (screen: AppScreen) => void;
  onSelectActor: (actorId: string) => void;
  onLogout: () => void;
}) {
  const links: Array<{ screen: AppScreen; label: string }> = session.role === "Owner" ? [
    { screen: "owner", label: "Owner console" },
    { screen: "settings", label: "Password" }
  ] : [
    { screen: "search", label: "Search" },
    { screen: "chat", label: "Chat" },
    { screen: "settlement", label: "Settlement" },
    { screen: "archive", label: "Report" },
    ...(isMasterView(session) || ["Broker", "Special Broker"].includes(session.actorRole) ? [{ screen: "receivables" as AppScreen, label: "Receivables" }] : []),
    ...(isMasterView(session) ? [
      { screen: "actors" as AppScreen, label: "Actors" },
      { screen: "profiles" as AppScreen, label: "Profiles" }
    ] : []),
    { screen: "settings", label: "Settings" }
  ];
  const managedActors = loginSession.role === "Master" ? activeActors(state).filter((actor) => actor.managedByMaster === true) : [];
  return (
    <View style={styles.screen}>
      <HeaderTitle title="More" subtitle={`${session.actorName} - ${session.actorRole}`} />
      <Panel title="Workspace tools">
        <View style={styles.moreGrid}>
          {links.map((link) => <Button key={link.screen} label={link.label} variant="secondary" onPress={() => onNavigate(link.screen)} style={styles.moreButton} />)}
        </View>
      </Panel>
      {managedActors.length ? (
        <Panel title="Managed profiles" badge="Master controlled">
          <Button label={`Master: ${loginSession.actorName}`} variant={!session.managedByMaster ? "primary" : "secondary"} onPress={() => onSelectActor("")} />
          {managedActors.map((actor) => <Button key={actor.id} label={`${actor.name} - ${actor.role}`} variant={session.actorId === actor.id ? "primary" : "secondary"} onPress={() => onSelectActor(actor.id)} />)}
        </Panel>
      ) : null}
      <Panel title="Account">
        <SummaryRow label="Workspace" value={session.workspace} />
        <SummaryRow label="Base currency" value={session.currency} />
        <Button label="Log out" variant="danger" icon={<LogOut size={18} color={colors.danger} />} onPress={onLogout} />
      </Panel>
    </View>
  );
}

function HomeScreen({
  session,
  workspaceState,
  stateLoading,
  onRefresh,
  onTransfer,
  onConversion,
  onSettlement,
  onOrders,
  onTransfers,
  onLedger
}: {
  session: UserSession;
  workspaceState: WorkspaceState | null;
  stateLoading: boolean;
  onRefresh: () => void;
  onTransfer: () => void;
  onConversion: () => void;
  onSettlement: () => void;
  onOrders: () => void;
  onTransfers: () => void;
  onLedger: () => void;
}) {
  const orders = visibleOrdersFor(session, workspaceState);
  const openOrders = assignedUnpaidOrdersFor(session, workspaceState);
  const assignedOrders = orders.filter((order) => order.state === "Assigned");
  const actorCanSendOrders = canCreateOrders(session);
  const pendingTransfers = (workspaceState?.transfers || []).filter((transfer) => transfer.state === "Pending Approval").length;
  const ledgerLines = (workspaceState?.ledger || []).filter((line) =>
    session.actorRole === "Master" || ledgerLineBelongsToActor(line, session.actorName)
  ).length;

  return (
    <View style={styles.screen}>
      <Panel title="Dashboard" badge={stateLoading ? "Syncing" : "Live"}>
        <View style={styles.metricsGrid}>
          <Metric label="Open orders" value={String(openOrders.length)} onPress={onOrders} />
          <Metric label="Pending approvals" value={String(session.actorRole === "Master" ? pendingTransfers : assignedOrders.length)} onPress={session.actorRole === "Master" ? onTransfers : onOrders} />
          <Metric label="Settlement net" value={session.currency} onPress={onSettlement} />
          <Metric label="Journal lines" value={String(ledgerLines)} onPress={onLedger} />
        </View>
      </Panel>
      <View style={styles.quickActions}>
        {actorCanSendOrders ? (
          <>
            <Button label="New order" onPress={onTransfer} icon={<Send size={17} color="#ffffff" />} style={styles.actionButton} />
            <Button label="Convert" onPress={onConversion} variant="secondary" icon={<Repeat2 size={17} color={colors.ink} />} style={styles.actionButton} />
          </>
        ) : (
          <>
            <Button label="Refresh" onPress={onRefresh} loading={stateLoading} variant="secondary" icon={<RefreshCw size={17} color={colors.ink} />} style={styles.actionButton} />
            <Button label="Settlement" onPress={onSettlement} variant="secondary" icon={<Scale size={17} color={colors.ink} />} style={styles.actionButton} />
          </>
        )}
      </View>
      <Panel title="Orderbook" badge={session.actorRole}>
        {orders.length ? orders.slice(0, 10).map((order) => (
          <View key={order.id} style={styles.orderRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.orderId}>{orderNumber(order, session)}</Text>
              <Text style={styles.mutedText}>{orderBrokerMatchesSession(order, session) ? order.receiverName : order.broker}</Text>
            </View>
            <View style={styles.orderRight}>
              <Text style={styles.orderAmount}>{compactAmount(order.payoutCurrency, majorFromMinor(order.payoutAmountMinor, order.payoutCurrency))}</Text>
              <Pill label={orderStateLabel(session, order)} tone={stateTone(order.state)} />
            </View>
          </View>
        )) : (
          <Text style={styles.mutedText}>{stateLoading ? "Loading orders..." : "No active orders."}</Text>
        )}
        {orders.length > 10 ? <Button label={`View all ${orders.length} orders`} variant="secondary" onPress={onOrders} /> : null}
      </Panel>
      {!actorCanSendOrders ? (
        <Panel title="Assigned Work" badge="Payout">
          <SummaryRow label="Signed in as" value={session.actorName} />
          <SummaryRow label="Role" value={session.actorRole} />
          <SummaryRow label="New orders" value="Broker only" strong />
        </Panel>
      ) : null}
    </View>
  );
}

function SettlementScreen({
  session,
  workspaceState
}: {
  session: UserSession;
  workspaceState: WorkspaceState | null;
}) {
  const rows = settlementRowsFor(session, workspaceState);
  const groups = [
    { label: "Brokers & Special Brokers", roles: ["Broker", "Special Broker"] },
    { label: "Agents", roles: ["Agent"] },
    { label: "Special Agents", roles: ["Special Agent"] }
  ].map((group) => ({
    ...group,
    rows: rows.filter((row) => group.roles.includes(row.actor.role))
  })).filter((group) => session.actorRole === "Master" || group.rows.length > 0);

  return (
    <View style={styles.screen}>
      <HeaderTitle title="Settlement" subtitle="Net positions against Master" />
      {groups.length ? groups.map((group) => (
        <View key={group.label} style={styles.settlementGroup}>
          <Text style={styles.settlementGroupTitle}>{group.label}</Text>
          {group.rows.length ? group.rows.map((row) => {
            const position = financialPosition(row.currency, row.netMinor, isMasterView(session));
            return (
              <View key={`${row.actor.id}-${row.currency}`} style={styles.settlementRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.orderId}>{row.actor.name}</Text>
                  <Text style={styles.mutedText}>{position.label}</Text>
                </View>
                <Text style={[
                  styles.settlementAmount,
                  position.tone === "good" && styles.financialGood,
                  position.tone === "danger" && styles.financialDanger,
                  position.tone === "neutral" && styles.financialNeutral
                ]}>
                  {position.amount}
                </Text>
              </View>
            );
          }) : <Text style={styles.mutedText}>No actors in this category.</Text>}
        </View>
      )) : <View style={styles.settlementGroup}><Text style={styles.mutedText}>No settlement balances yet.</Text></View>}
    </View>
  );
}

function ArchiveScreen({
  session,
  workspaceState,
  stateLoading,
  onRefresh
}: {
  session: UserSession;
  workspaceState: WorkspaceState | null;
  stateLoading: boolean;
  onRefresh: () => void;
}) {
  const [selectedMonth, setSelectedMonth] = useState("");
  const [monthMenuOpen, setMonthMenuOpen] = useState(false);
  const [expandedStatements, setExpandedStatements] = useState<string[]>([]);
  const [receivablesExpanded, setReceivablesExpanded] = useState(false);
  const [expandedReceivableMonths, setExpandedReceivableMonths] = useState<string[]>([]);
  const [transactionSort, setTransactionSort] = useState<"Date" | "Order / Transfer No.">("Date");
  const [statementDetailLimits, setStatementDetailLimits] = useState<Record<string, number>>({});
  const [receivableDetailLimits, setReceivableDetailLimits] = useState<Record<string, number>>({});
  const [pdfExporting, setPdfExporting] = useState(false);
  const archives = visibleArchivesFor(session, workspaceState);
  const months = Array.from(new Set(archives.map((archive) => archiveMonthKey(archive.closedAt)).filter(Boolean))).sort().reverse();
  const activeMonth = months.includes(selectedMonth) ? selectedMonth : "";
  const filteredArchives = activeMonth
    ? archives.filter((archive) => archiveMonthKey(archive.closedAt) === activeMonth)
    : archives;
  const archivePage = useProgressiveLimit(`${session.actorId}:${activeMonth}`, 10);
  const displayedArchives = filteredArchives.slice(0, archivePage.limit);
  const monthOptions = ["", ...months];
  const archivedReceivables = filteredArchives.flatMap((archive) => (archive.receivables || [])
    .filter((receivable) => {
      const linkedOrder = (archive.orders || []).find((order) =>
        order.id === receivable.orderId ||
        order.internalOrderId === receivable.orderId ||
        order.brokerOrderNumber === receivable.brokerOrderNumber
      );
      return !linkedOrder || !orderRecordIsVoided(linkedOrder);
    })
    .map((receivable) => ({ archive, receivable })));
  const receivableMonths = Array.from(new Set(archivedReceivables.map(({ archive, receivable }) => archiveMonthKey(receivable.archivedAt || archive.closedAt)).filter(Boolean))).sort().reverse();

  useEffect(() => {
    setStatementDetailLimits({});
    setReceivableDetailLimits({});
  }, [activeMonth, transactionSort]);

  const toggleStatement = (statementId: string) => {
    setExpandedStatements((current) => current.includes(statementId)
      ? current.filter((id) => id !== statementId)
      : [...current, statementId]);
  };

  const exportReportPdf = async () => {
    if (session.subscriptionReadOnly) {
      Alert.alert("Read-only access", "Report export is disabled until the workspace subscription is renewed.");
      return;
    }
    if (!workspaceState || !filteredArchives.length || pdfExporting) return;
    const periodLabel = activeMonth ? archiveMonthLabel(activeMonth) : "All closed months";
    const title = `${session.actorName} Report - ${periodLabel}`;
    setPdfExporting(true);
    try {
      const fontBase64 = await reportPdfFontBase64();
      const html = buildArchiveReportPdfHtml(title, filteredArchives, workspaceState.actors, session, fontBase64);
      const result = await Print.printToFileAsync({ html, base64: false });
      if (!(await Sharing.isAvailableAsync())) {
        throw new Error("PDF sharing is unavailable on this device.");
      }
      await Sharing.shareAsync(result.uri, {
        mimeType: "application/pdf",
        UTI: "com.adobe.pdf",
        dialogTitle: `Share ${title}`,
      });
    } catch (error) {
      Alert.alert("Export PDF", error instanceof Error ? error.message : "The report could not be exported.");
    } finally {
      setPdfExporting(false);
    }
  };

  const confirmReportPdfExport = () => {
    if (!workspaceState || !filteredArchives.length || pdfExporting || session.subscriptionReadOnly) return;
    Alert.alert(
      "Export PDF?",
      "The exported report may contain sensitive financial information.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Export PDF", onPress: () => void exportReportPdf() },
      ]
    );
  };

  return (
    <View style={styles.screen}>
      <HeaderTitle title="Report" subtitle="Monthly closed statements" />
      <Button
        label="Refresh report"
        variant="secondary"
        onPress={onRefresh}
        loading={stateLoading}
        icon={<RefreshCw size={17} color={colors.ink} />}
      />
      <Button
        label="Export report PDF"
        variant="secondary"
        onPress={confirmReportPdfExport}
        loading={pdfExporting}
        disabled={!filteredArchives.length || session.subscriptionReadOnly === true}
        icon={<FileDown size={17} color={colors.ink} />}
      />
      <Panel title="Closed month" badge={`${filteredArchives.length} close${filteredArchives.length === 1 ? "" : "s"}`}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Select closed month"
          onPress={() => setMonthMenuOpen((open) => !open)}
          style={styles.archiveSelector}
        >
          <CalendarDays size={19} color={colors.accent} />
          <Text style={styles.archiveSelectorText}>{activeMonth ? archiveMonthLabel(activeMonth) : "All months"}</Text>
          <ChevronDown size={19} color={colors.muted} />
        </Pressable>
        {monthMenuOpen ? (
          <View style={styles.archiveMonthMenu}>
            {monthOptions.map((month) => {
              const active = month === activeMonth;
              return (
                <Pressable
                  key={month || "all"}
                  accessibilityRole="button"
                  onPress={() => {
                    setSelectedMonth(month);
                    setMonthMenuOpen(false);
                  }}
                  style={[styles.archiveMonthOption, active && styles.archiveMonthOptionActive]}
                >
                  <Text style={[styles.archiveMonthOptionText, active && styles.archiveMonthOptionTextActive]}>
                    {month ? archiveMonthLabel(month) : "All months"}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
        <SelectRow
          label="Sort transactions by"
          options={["Date", "Order / Transfer No."]}
          value={transactionSort}
          onChange={setTransactionSort}
        />
      </Panel>

      <Panel title="Collected receivables" badge={String(archivedReceivables.length)} badgeTone="good">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={receivablesExpanded ? "Collapse collected receivables" : "Expand collected receivables"}
          onPress={() => setReceivablesExpanded((current) => !current)}
          style={styles.archiveToggle}
        >
          <Text style={styles.archiveToggleText}>{receivablesExpanded ? "Hide monthly receivables" : "Show monthly receivables"}</Text>
          {receivablesExpanded ? <ChevronUp size={18} color={colors.accent} /> : <ChevronDown size={18} color={colors.accent} />}
        </Pressable>
        {receivablesExpanded ? (
          receivableMonths.length ? receivableMonths.map((month) => {
            const monthExpanded = expandedReceivableMonths.includes(month);
            const monthlyReceivables = archivedReceivables.filter(({ archive, receivable }) => archiveMonthKey(receivable.archivedAt || archive.closedAt) === month);
            const receivableLimit = receivableDetailLimits[month] || 20;
            const displayedReceivables = monthlyReceivables.slice(0, receivableLimit);
            return (
              <View key={`receivables-${month}`}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${monthExpanded ? "Collapse" : "Expand"} ${archiveMonthLabel(month)} collected receivables`}
                  onPress={() => setExpandedReceivableMonths((current) => monthExpanded ? current.filter((item) => item !== month) : [...current, month])}
                  style={styles.archiveToggle}
                >
                  <Text style={styles.archiveToggleText}>{archiveMonthLabel(month)} ({monthlyReceivables.length})</Text>
                  {monthExpanded ? <ChevronUp size={18} color={colors.accent} /> : <ChevronDown size={18} color={colors.accent} />}
                </Pressable>
                {monthExpanded ? (
                  <View style={styles.archiveDetails}>
                    {displayedReceivables.map(({ archive, receivable }: { archive: ArchiveRecord; receivable: ReceivableRecord }) => {
                      const paidMinor = (receivable.payments || []).reduce((sum, payment) => sum + Number(payment.amountMinor || 0), 0);
                      const lastPayment = (receivable.payments || []).slice().sort((a, b) => new Date(b.paidAt || 0).getTime() - new Date(a.paidAt || 0).getTime())[0];
                      return (
                        <View key={`${archive.id || archive.closedAt}-${receivable.id}`} style={styles.archiveDetailRow}>
                          <Text style={styles.archiveDetailTitle}>{receivable.brokerOrderNumber || receivable.orderId}</Text>
                          {receivable.creditReminder ? <Text style={styles.archiveDetailMeta}>Credit Reminder: {receivable.creditReminder}</Text> : null}
                          <Text style={styles.archiveDetailMeta}>{receivable.borrower}{lastPayment?.paidAt ? ` - Collected ${archiveClosedLabel(lastPayment.paidAt)}` : ""}</Text>
                          <Text style={styles.archiveDetailAmount}>Principal {compactAmount(receivable.currency, majorFromMinor(receivable.principalMinor, receivable.currency))}</Text>
                          <Text style={styles.archiveDetailMeta}>Collected {compactAmount(receivable.currency, majorFromMinor(paidMinor, receivable.currency))}</Text>
                        </View>
                      );
                    })}
                    {displayedReceivables.length < monthlyReceivables.length ? (
                      <Button
                        label={`Load 20 more receivables (${monthlyReceivables.length - displayedReceivables.length} remaining)`}
                        variant="secondary"
                        onPress={() => setReceivableDetailLimits((current) => ({ ...current, [month]: receivableLimit + 20 }))}
                      />
                    ) : null}
                  </View>
                ) : null}
              </View>
            );
          }) : <Text style={styles.mutedText}>No fully collected receivables have been archived yet.</Text>
        ) : null}
      </Panel>

      {filteredArchives.length ? displayedArchives.map((archive, index) => {
        const statementId = archive.id || `${archive.actor || "actor"}-${archive.closedAt || index}`;
        const expanded = expandedStatements.includes(statementId);
        const actorBaseCurrency = archive.actorCurrency || workspaceState?.actors.find((actor) => actor.id === archive.actorId || actor.name === archive.actor)?.currency || session.currency;
        const reportCurrencies = [actorBaseCurrency, ...currencies.filter((currency) => currency !== actorBaseCurrency)];
        const balanceRows = reportCurrencies
          .map((currency) => ({ currency, netMinor: Number(archive.balances?.[currency] || 0) }))
          .filter((row) => row.netMinor !== 0);
        const referenceCompare = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
        const orders = (archive.orders || []).slice().sort((a, b) => transactionSort === "Date"
          ? new Date(b.cancelledAt || b.voidedAt || b.paidAt || b.sentAt || b.createdAt || 0).getTime() - new Date(a.cancelledAt || a.voidedAt || a.paidAt || a.sentAt || a.createdAt || 0).getTime()
          : referenceCompare(orderNumber(a, session), orderNumber(b, session)));
        const transfers = (archive.transfers || []).slice().sort((a, b) => transactionSort === "Date"
          ? new Date(b.reversedAt || b.paidOutAt || b.approvedAt || b.sentAt || b.createdAt || 0).getTime() - new Date(a.reversedAt || a.paidOutAt || a.approvedAt || a.sentAt || a.createdAt || 0).getTime()
          : referenceCompare(a.id || a.journal || "", b.id || b.journal || ""));
        const ledger = (archive.ledger || []).filter((line) => {
          const source = String(line.source || "");
          const linkedOrder = source.startsWith("ORDER_")
            ? (archive.orders || []).find((order) =>
                (line.orderId && (order.id === line.orderId || order.internalOrderId === line.orderId)) ||
                (line.journal && (order.journal === line.journal || order.voidJournal === line.journal))
              )
            : undefined;
          if (linkedOrder && orderRecordIsVoided(linkedOrder)) return false;
          const linkedTransfer = source.startsWith("TRANSFER")
            ? (archive.transfers || []).find((transfer) =>
                (line.transferId && transfer.id === line.transferId) ||
                (line.journal && (transfer.journal === line.journal || transfer.reversalJournal === line.journal))
              )
            : undefined;
          const reversed = linkedTransfer?.state === "Reversed" || Boolean(linkedTransfer?.reversalJournal || linkedTransfer?.reversedAt);
          return !linkedTransfer || !reversed;
        }).slice().sort((a, b) => transactionSort === "Date"
          ? new Date(b.postedAt || 0).getTime() - new Date(a.postedAt || 0).getTime()
          : referenceCompare(String(a.journal || a.orderId || a.transferId || a.entryId || ""), String(b.journal || b.orderId || b.transferId || b.entryId || "")));
        const detailCount = orders.length + transfers.length + ledger.length;
        const detailLimit = statementDetailLimits[statementId] || 30;
        const displayedOrders = orders.slice(0, detailLimit);
        const transferLimit = Math.max(0, detailLimit - displayedOrders.length);
        const displayedTransfers = transfers.slice(0, transferLimit);
        const ledgerLimit = Math.max(0, detailLimit - displayedOrders.length - displayedTransfers.length);
        const displayedLedger = ledger.slice(0, ledgerLimit);
        const displayedDetailCount = displayedOrders.length + displayedTransfers.length + displayedLedger.length;

        return (
          <Panel
            key={statementId}
            title={session.actorRole === "Master" ? archive.actor || "Actor" : "Closed statement"}
            badge={archiveMonthLabel(archiveMonthKey(archive.closedAt))}
          >
            <View style={styles.archiveStatementHead}>
              <View style={{ flex: 1 }}>
                <Text style={styles.archiveStatementDate}>{archiveClosedLabel(archive.closedAt)}</Text>
                <Text style={styles.archiveStatementReference}>{archive.id || "Reported close"}</Text>
              </View>
              <LockKeyhole size={20} color={colors.danger} />
            </View>

            {balanceRows.length ? balanceRows.map((row) => {
              const position = financialPosition(row.currency, row.netMinor, isMasterView(session));
              return (
                <View key={`${statementId}-${row.currency}`} style={styles.archiveBalanceRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.archiveBalanceCurrency}>{row.currency}</Text>
                    <Text style={styles.archiveBalanceDirection}>{position.label}</Text>
                  </View>
                  <Text style={[
                    styles.archiveBalanceAmount,
                    position.tone === "good" && styles.financialGood,
                    position.tone === "danger" && styles.financialDanger
                  ]}>
                    {position.amount}
                  </Text>
                </View>
              );
            }) : <Text style={styles.mutedText}>Closed with a zero balance.</Text>}

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={expanded ? "Hide statement details" : "Show statement details"}
              onPress={() => toggleStatement(statementId)}
              style={styles.archiveToggle}
            >
              <Text style={styles.archiveToggleText}>{expanded ? "Hide details" : `Show details (${detailCount})`}</Text>
              {expanded ? <ChevronUp size={18} color={colors.accent} /> : <ChevronDown size={18} color={colors.accent} />}
            </Pressable>

            {expanded ? (
              <View style={styles.archiveDetails}>
                {displayedOrders.map((order) => {
                  const cancelled = order.state === "Cancelled";
                  const voided = !cancelled && orderRecordIsVoided(order);
                  const excluded = cancelled || voided;
                  return <View key={`order-${statementId}-${order.id}`} style={[styles.archiveDetailRow, excluded && styles.reportVoidRow]}>
                    <Text style={styles.archiveDetailTitle}>Order {orderNumber(order, session)}</Text>
                    {voided ? <Text style={styles.reportVoidText}>Voided - Excluded from all calculations</Text> : null}
                    {cancelled ? <Text style={styles.reportVoidText}>Cancelled - Excluded</Text> : null}
                    {cancelled && order.cancelledBy ? <Text style={styles.archiveDetailMeta}>Cancelled by: {order.cancelledBy}</Text> : null}
                    {cancelled && order.cancelledAt ? <Text style={styles.archiveDetailMeta}>Cancelled: {formatDateTime(order.cancelledAt)}</Text> : null}
                    <Text style={styles.archiveDetailMeta}>{order.receiverName || order.accountNumber || order.phoneNumber || "No receiver details"}</Text>
                    {order.receiverCity ? <Text style={styles.archiveDetailMeta}>Receiver City: {order.receiverCity}</Text> : null}
                    <Text style={styles.archiveDetailAmount}>
                      {cancelled ? "Original amount (informational): " : ""}{compactAmount(order.sourceCurrency, majorFromMinor(order.sourceAmountMinor, order.sourceCurrency))} to {compactAmount(order.payoutCurrency, majorFromMinor(order.payoutAmountMinor, order.payoutCurrency))}
                    </Text>
                  </View>;
                })}
                {displayedTransfers.map((transfer, transferIndex) => {
                  const sourceCurrency = transfer.sourceCurrency || transfer.currency || session.currency;
                  const payoutCurrency = transfer.currency || sourceCurrency;
                  const archiveIsSender = Boolean(
                    (archive.actorId && transfer.fromActorId === archive.actorId) ||
                    (archive.actor && transfer.from === archive.actor)
                  );
                  const currency = archiveIsSender ? sourceCurrency : payoutCurrency;
                  const amountMinor = archiveIsSender
                    ? Number(transfer.sourceAmountMinor || transfer.amountMinor || 0)
                    : Number(transfer.amountMinor || 0);
                  const reversed = transfer.state === "Reversed" || Boolean(transfer.reversalJournal || transfer.reversedAt);
                  return (
                    <View key={`transfer-${statementId}-${transfer.id || transferIndex}`} style={[styles.archiveDetailRow, reversed && styles.reportVoidRow]}>
                      <Text style={styles.archiveDetailTitle}>Transfer {transfer.id || transferIndex + 1}</Text>
                      {reversed ? <Text style={styles.reportVoidText}>Reversed - Original and reversal net to zero</Text> : null}
                      <Text style={[styles.archiveDetailMeta, reversed && styles.reportVoidText]}>{transfer.from || "Unknown"} to {transfer.to || "Unknown"}</Text>
                      <Text style={[styles.archiveDetailAmount, reversed && styles.reportVoidText]}>{compactAmount(currency, majorFromMinor(amountMinor, currency))}</Text>
                      {transfer.remarks ? <Text style={[styles.archiveDetailMeta, reversed && styles.reportVoidText]}>{transfer.remarks}</Text> : null}
                    </View>
                  );
                })}
                {displayedLedger.map((line, lineIndex) => {
                  const signedMinor = line.direction === "Debit" ? Number(line.amountMinor || 0) : -Number(line.amountMinor || 0);
                  const position = financialPosition(line.currency, signedMinor, isMasterView(session));
                  return (
                    <View key={`ledger-${statementId}-${line.entryId || line.journal || lineIndex}`} style={styles.archiveDetailRow}>
                      <Text style={styles.archiveDetailTitle}>{line.source || "Ledger"} - {line.direction}</Text>
                      <Text style={styles.archiveDetailMeta}>{line.details || line.account}</Text>
                      <Text style={[
                        styles.archiveDetailAmount,
                        position.tone === "good" && styles.financialGood,
                        position.tone === "danger" && styles.financialDanger
                      ]}>{position.amount}</Text>
                    </View>
                  );
                })}
                {!detailCount ? <Text style={styles.mutedText}>No archived transaction details.</Text> : null}
                {displayedDetailCount < detailCount ? (
                  <Button
                    label={`Load 30 more transactions (${detailCount - displayedDetailCount} remaining)`}
                    variant="secondary"
                    onPress={() => setStatementDetailLimits((current) => ({ ...current, [statementId]: detailLimit + 30 }))}
                  />
                ) : null}
              </View>
            ) : null}
          </Panel>
        );
      }) : (
        <Panel title="No reports">
          <Text style={styles.mutedText}>{activeMonth ? `No balances were closed in ${archiveMonthLabel(activeMonth)}.` : "No closed balance reports are available yet."}</Text>
        </Panel>
      )}
      {displayedArchives.length < filteredArchives.length ? (
        <Button label={`Load 10 more reports (${filteredArchives.length - displayedArchives.length} remaining)`} variant="secondary" onPress={archivePage.showMore} />
      ) : null}
    </View>
  );
}

function TransferScreen({
  session,
  workspaceState,
  draft,
  setDraft,
  quote,
  editingOrderId,
  onConversion,
  onContinue
}: {
  session: UserSession;
  workspaceState: WorkspaceState | null;
  draft: TransferDraft;
  setDraft: React.Dispatch<React.SetStateAction<TransferDraft>>;
  quote: ReturnType<typeof calculateQuote>;
  editingOrderId: string;
  onConversion: () => void;
  onContinue: () => void;
}) {
  const actor = actorForSession(session, workspaceState);
  const [activeCustomerPicker, setActiveCustomerPicker] = useState<SavedCustomerRecord["kind"] | null>(null);
  const orderConversionTouches = useRef<OrderConversionField[]>([]);
  const senderCustomers = savedCustomersFor(session, workspaceState, "sender");
  const receiverCustomers = savedCustomersFor(session, workspaceState, "receiver");
  const sourceOptions = actor?.orderMultiCurrencyEnabled === true
    ? currencies
    : [actor?.currency || session.currency].filter((currency): currency is Currency => currencies.includes(currency));
  const sourceCurrency = sourceOptions.includes(draft.sourceCurrency) ? draft.sourceCurrency : sourceOptions[0] || session.currency;
  const fixedRate = fixedOrderRateForActor(actor, draft.payoutCurrency);
  const fixedRateText = fixedRate ? inputRate(fixedRate) : "";
  const fixedCommission = fixedOrderCommissionForActor(actor);
  const fixedCommissionText = fixedCommission === null ? "" : String(fixedCommission);

  useEffect(() => {
    if (!fixedRate) return;
    orderConversionTouches.current = orderConversionTouches.current.filter((field) => field !== "rate");
    setDraft((current) => {
      const next = reconcileFixedOrderConversion(current, fixedRate);
      return next.rate === current.rate && next.sourceAmount === current.sourceAmount && next.payoutAmount === current.payoutAmount
        ? current
        : next;
    });
  }, [fixedRate, setDraft]);

  useEffect(() => {
    if (fixedCommission === null) return;
    setDraft((current) => current.commissionPercent === fixedCommissionText
      ? current
      : { ...current, broker: session.actorName, commissionPercent: fixedCommissionText });
  }, [fixedCommission, fixedCommissionText, session.actorName, setDraft]);

  const setField = <K extends keyof TransferDraft>(key: K, value: TransferDraft[K]) => {
    setDraft((current) => ({ ...current, broker: session.actorName, [key]: value }));
  };
  const setPayoutCurrency = (value: Currency) => {
    setDraft((current) => {
      const next = { ...current, broker: session.actorName, payoutCurrency: value };
      const nextFixedRate = fixedOrderRateForActor(actor, value);
      return nextFixedRate ? reconcileFixedOrderConversion(next, nextFixedRate) : next;
    });
  };
  const setCustomerName = (kind: SavedCustomerRecord["kind"], value: string) => {
    setField(kind === "sender" ? "senderName" : "receiverName", value);
    setActiveCustomerPicker(null);
  };
  const setConversionField = (key: OrderConversionField, value: string) => {
    orderConversionTouches.current = orderConversionTouches.current.filter((field) => field !== key);
    orderConversionTouches.current.push(key);
    orderConversionTouches.current = orderConversionTouches.current.slice(-2);
    setDraft((current) => {
      const next = { ...current, broker: session.actorName, [key]: value };
      if (fixedRate) {
        orderConversionTouches.current = orderConversionTouches.current.filter((field) => field !== "rate");
        return key === "rate"
          ? { ...next, rate: fixedRateText }
          : reconcileFixedOrderConversion(next, fixedRate, key);
      }
      return reconcileOrderConversion(next, orderConversionTouches.current);
    });
  };
  const chooseCustomer = (customer: SavedCustomerRecord) => {
    setDraft((current) => customer.kind === "sender"
      ? { ...current, senderName: customer.name, broker: session.actorName }
      : {
        ...current,
        broker: session.actorName,
        receiverName: customer.name,
        receiverCity: customer.receiverCity,
        phoneNumber: customer.phoneNumber,
        accountNumber: customer.accountNumber,
        remarks: customer.remarks
      });
    setActiveCustomerPicker(null);
  };

  return (
    <View style={styles.screen}>
      <HeaderTitle title={editingOrderId ? "Modify Order" : "Create Order"} subtitle={editingOrderId ? "Correct and resubmit the returned order" : "Mobile money transfer form"} />
      <Panel title="Money Transfer" badge={editingOrderId ? "Returned" : "Draft"}>
        <SummaryRow label="Broker" value={session.actorName} strong />
        <View style={styles.twoColumn}>
          <SelectRow<Currency> label="Source currency" options={sourceOptions} value={sourceCurrency} onChange={(value) => setField("sourceCurrency", value)} />
          <SelectRow<Currency> label="Payout currency" options={currencies} value={draft.payoutCurrency} onChange={setPayoutCurrency} />
        </View>
        <Field label="Source amount" value={draft.sourceAmount} onChangeText={(value) => setConversionField("sourceAmount", value)} keyboardType="decimal-pad" />
        <Field
          label={fixedRate ? "Exchange rate (fixed by Master)" : "Exchange rate"}
          value={fixedRate ? fixedRateText : draft.rate}
          onChangeText={(value) => setConversionField("rate", value)}
          keyboardType="decimal-pad"
          editable={!fixedRate}
          style={fixedRate ? styles.fixedRateInput : undefined}
        />
        {fixedRate ? <Text style={styles.fixedRateNote}>This rate is fixed for your account and cannot be changed.</Text> : null}
        <Field label="Total payout" value={draft.payoutAmount} onChangeText={(value) => setConversionField("payoutAmount", value)} keyboardType="decimal-pad" placeholder="Calculated from any other two fields" />
        <Field
          label={fixedCommission !== null ? "Commission % (fixed by Master)" : "Commission %"}
          value={fixedCommission !== null ? fixedCommissionText : draft.commissionPercent}
          onChangeText={(value) => setField("commissionPercent", value)}
          keyboardType="numeric"
          editable={fixedCommission === null}
          style={fixedCommission !== null ? styles.fixedRateInput : undefined}
        />
        {fixedCommission !== null ? <Text style={styles.fixedRateNote}>This commission is fixed for your account and cannot be changed.</Text> : null}
        <SelectRow<FundingType> label="Payment type" options={["cash", "credit"]} value={draft.fundingType} onChange={(value) => setDraft((current) => ({ ...current, broker: session.actorName, fundingType: value, creditReminder: value === "credit" ? current.creditReminder : "" }))} />
        {draft.fundingType === "credit" ? <Field label="Credit Reminder" value={draft.creditReminder} onChangeText={(value) => setField("creditReminder", value)} multiline /> : null}
      </Panel>
      <Panel title="Receiver Details" badge="Required">
        <Field label="Sender name" value={draft.senderName} onChangeText={(value) => setCustomerName("sender", value)} onFocus={() => setActiveCustomerPicker("sender")} />
        {activeCustomerPicker === "sender" ? <SavedCustomerSuggestions customers={senderCustomers} onSelect={chooseCustomer} /> : null}
        <Field label="Receiver name" value={draft.receiverName} onChangeText={(value) => setCustomerName("receiver", value)} onFocus={() => setActiveCustomerPicker("receiver")} />
        {activeCustomerPicker === "receiver" ? <SavedCustomerSuggestions customers={receiverCustomers} onSelect={chooseCustomer} /> : null}
        <Field label="Receiver city" value={draft.receiverCity} onChangeText={(value) => setField("receiverCity", value)} />
        <Field label="Remarks" value={draft.remarks} onChangeText={(value) => setField("remarks", value)} multiline />
        <Field label="Phone number" value={draft.phoneNumber} onChangeText={(value) => setField("phoneNumber", value)} keyboardType="phone-pad" />
        <Field label="Account number" value={draft.accountNumber} onChangeText={(value) => setField("accountNumber", value)} keyboardType="number-pad" />
      </Panel>
      <QuotePanel quote={quote} />
      <View style={styles.quickActions}>
        <Button label="Preview" onPress={onConversion} variant="secondary" icon={<Repeat2 size={17} color={colors.ink} />} style={styles.actionButton} />
        <Button label="Review" onPress={onContinue} icon={<ArrowRight size={17} color="#ffffff" />} style={styles.actionButton} />
      </View>
    </View>
  );
}

function SavedCustomerSuggestions({
  customers,
  onSelect
}: {
  customers: SavedCustomerRecord[];
  onSelect: (customer: SavedCustomerRecord) => void;
}) {
  if (!customers.length) return null;
  return (
    <View style={styles.savedCustomerList}>
      {customers.map((customer) => {
        const details = [customer.receiverCity, customer.phoneNumber, customer.accountNumber].filter(Boolean).join(" | ");
        return (
          <Pressable key={customer.id} onPress={() => onSelect(customer)} style={styles.savedCustomerRow}>
            <Text style={styles.savedCustomerName}>{customer.name || customer.phoneNumber || customer.accountNumber}</Text>
            {details ? <Text style={styles.savedCustomerDetail}>{details}</Text> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

function ConversionScreen({
  session,
  draft,
  quote,
  onEdit,
  onContinue
}: {
  session: UserSession;
  draft: TransferDraft;
  quote: ReturnType<typeof calculateQuote>;
  onEdit: () => void;
  onContinue: () => void;
}) {
  return (
    <View style={styles.screen}>
      <HeaderTitle title="Currency Conversion" subtitle="Live quote before confirmation" />
      <QuotePanel quote={quote} expanded />
      <Panel title="Conversion Flow" badge={draft.fundingType === "credit" ? "Credit" : "Cash"}>
        <SummaryRow label="Source leg" value={`${compactAmount(quote.sourceCurrency, quote.sourceAmount)} from ${session.actorName}`} />
        <SummaryRow label={quote.commissionAmount < 0 ? "Master commission liability" : "Commission"} value={`${formatAmount(quote.sourceCurrency, quote.commissionAmount)} at ${draft.commissionPercent || "0"}%`} />
        <SummaryRow label="Collected total" value={compactAmount(quote.sourceCurrency, quote.grossAmount)} strong />
        <SummaryRow label="Rate" value={`1 ${quote.sourceCurrency} = ${quote.rate} ${quote.payoutCurrency}`} />
        <SummaryRow label="Payout leg" value={compactAmount(quote.payoutCurrency, quote.payoutAmount)} strong />
      </Panel>
      <View style={styles.quickActions}>
        <Button label="Edit" onPress={onEdit} variant="secondary" style={styles.actionButton} />
        <Button label="Confirm" onPress={onContinue} icon={<CheckCircle2 size={17} color="#ffffff" />} style={styles.actionButton} />
      </View>
    </View>
  );
}

function ConfirmationScreen({
  session,
  draft,
  quote,
  submittedOrder,
  editingOrderId,
  routingAction,
  routingActionBusy,
  onRoutingActionChange,
  onRoutingBusyChange,
  onSubmitted,
  onEdit,
  onHome
}: {
  session: UserSession;
  draft: TransferDraft;
  quote: ReturnType<typeof calculateQuote>;
  submittedOrder: SubmittedOrder | null;
  editingOrderId: string;
  routingAction: MobileRoutingActionRecord | null;
  routingActionBusy: boolean;
  onRoutingActionChange: (action: MobileRoutingActionRecord | null) => void;
  onRoutingBusyChange: (busy: boolean) => void;
  onSubmitted: (order: SubmittedOrder) => void;
  onEdit: () => void;
  onHome: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const pendingBrokerSend = routingAction?.kind === "broker-send" ? routingAction : null;
  const actionLocked = loading || routingActionBusy || Boolean(pendingBrokerSend);

  const submit = async () => {
    const routingSessionIsCurrent = () => {
      const current = currentWorkspaceSession();
      return current?.workspaceId === session.workspaceId && current.userId === session.userId;
    };
    setLoading(true);
    onRoutingBusyChange(true);
    setError("");
    try {
      const order = await submitTransferOrder(session, draft, editingOrderId);
      if (!routingSessionIsCurrent()) return;
      onRoutingActionChange(null);
      onSubmitted(order);
    } catch (caught) {
      const protectedAction = await readMobileRoutingAction(session);
      if (!routingSessionIsCurrent()) return;
      onRoutingActionChange(protectedAction);
      setError(caught instanceof Error ? caught.message : "Could not submit order.");
    } finally {
      setLoading(false);
      if (routingSessionIsCurrent()) onRoutingBusyChange(false);
    }
  };

  if (submittedOrder) {
    return (
      <View style={styles.screen}>
        <HeaderTitle title={editingOrderId ? "Resubmitted" : "Submitted"} subtitle="Sent to Master for routing" />
        <Panel title={submittedOrder.orderNumber} badge={submittedOrder.status}>
          <View style={styles.successIcon}>
            <CheckCircle2 size={44} color={colors.good} />
          </View>
          <SummaryRow label="Created" value={formatDateTime(submittedOrder.createdAt)} />
          <SummaryRow label="Next step" value="Master approval" strong />
          <Button label="Back to dashboard" onPress={onHome} icon={<LayoutDashboard size={17} color="#ffffff" />} />
        </Panel>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <HeaderTitle title={editingOrderId ? "Confirm Changes" : "Confirm Order"} subtitle="Review before sending to Master" />
      <Panel title="Order Summary" badge={editingOrderId ? "Modified" : "Ready"}>
        <SummaryRow label="Broker" value={session.actorName} />
        <SummaryRow label="Sender" value={draft.senderName} />
        <SummaryRow label="Receiver" value={draft.receiverName} />
        {draft.receiverCity ? <SummaryRow label="Receiver city" value={draft.receiverCity} /> : null}
        <SummaryRow label="Phone" value={draft.phoneNumber || "Not provided"} />
        <SummaryRow label="Account" value={draft.accountNumber || "Not provided"} />
        <SummaryRow label="Funding" value={draft.fundingType === "credit" ? "Credit" : "Cash"} />
        <SummaryRow label="Source amount" value={formatAmount(quote.sourceCurrency, quote.sourceAmount)} />
        <SummaryRow label={quote.commissionAmount < 0 ? "Master commission liability" : "Commission"} value={formatAmount(quote.sourceCurrency, quote.commissionAmount)} />
        <SummaryRow label="Payout amount" value={formatAmount(quote.payoutCurrency, quote.payoutAmount)} strong />
      </Panel>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      <View style={styles.quickActions}>
        <Button label="Edit" onPress={onEdit} disabled={actionLocked} variant="secondary" style={styles.actionButton} />
        <Button
          label={pendingBrokerSend ? "Retry exact send" : editingOrderId ? "Resubmit order" : "Send order"}
          onPress={submit}
          loading={loading || routingActionBusy}
          disabled={loading || routingActionBusy}
          icon={<Send size={17} color="#ffffff" />}
          style={styles.actionButton}
        />
      </View>
    </View>
  );
}

function QuotePanel({ quote, expanded = false }: { quote: ReturnType<typeof calculateQuote>; expanded?: boolean }) {
  return (
    <Panel title="Journal Preview" badge="Balanced">
      <View style={styles.quoteTop}>
        <View style={styles.quoteAmount}>
          <Text style={styles.quoteLabel}>Source</Text>
          <Text style={styles.quoteValue}>{compactAmount(quote.sourceCurrency, quote.sourceAmount)}</Text>
        </View>
        <View style={styles.quoteArrow}>
          <ArrowRight size={18} color={colors.accent} />
        </View>
        <View style={styles.quoteAmount}>
          <Text style={styles.quoteLabel}>Payout</Text>
          <Text style={styles.quoteValue}>{compactAmount(quote.payoutCurrency, quote.payoutAmount)}</Text>
        </View>
      </View>
      <SummaryRow label={quote.commissionAmount < 0 ? "Master commission liability" : "Commission"} value={formatAmount(quote.sourceCurrency, quote.commissionAmount)} />
      {expanded ? <SummaryRow label="Collected total" value={formatAmount(quote.sourceCurrency, quote.grossAmount)} strong /> : null}
      <SummaryRow label="Rate" value={`${quote.rate} ${quote.payoutCurrency}`} />
    </Panel>
  );
}

function Metric({ label, value, onPress }: { label: string; value: string; onPress?: () => void }) {
  return (
    <Pressable style={({ pressed }) => [styles.metric, pressed && styles.metricPressed]} onPress={onPress} disabled={!onPress}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue} numberOfLines={1}>{value}</Text>
    </Pressable>
  );
}

function HeaderTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <View style={styles.titleBlock}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.subtitle}>{subtitle}</Text>
    </View>
  );
}

function BottomTabs({
  session,
  state,
  current,
  onChange
}: {
  session: UserSession;
  state: WorkspaceState | null;
  current: AppScreen;
  onChange: (screen: AppScreen) => void;
}) {
  const tabs: Array<{ id: AppScreen; label: string; Icon: IconComponent }> = session.role === "Owner" ? [
    { id: "owner", label: "Owner", Icon: LayoutDashboard },
    { id: "settings", label: "Password", Icon: LockKeyhole },
    { id: "more", label: "More", Icon: Menu }
  ] : [
    { id: "home", label: "Home", Icon: LayoutDashboard },
    { id: "orders", label: "Orders", Icon: Send },
    state && (isMasterView(session) || transferTargetsFor(session, state).length > 0)
      ? { id: "transfers", label: "Transfer", Icon: Repeat2 }
      : { id: "settlement", label: "Settle", Icon: Scale },
    { id: "ledger", label: "Ledger", Icon: ArchiveIcon },
    { id: "more", label: "More", Icon: Menu }
  ];

  return (
    <View style={styles.tabs}>
      {tabs.map(({ id, label, Icon }) => {
        const active = current === id;
        return (
          <Pressable key={id} onPress={() => onChange(id)} style={styles.tabItem}>
            <Icon size={20} color={active ? colors.accent : colors.muted} strokeWidth={2.2} />
            <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg
  },
  app: {
    flex: 1,
    backgroundColor: colors.bg
  },
  content: {
    padding: spacing.lg,
    paddingBottom: 110,
    gap: spacing.lg
  },
  loadingWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md
  },
  authWrap: {
    flex: 1
  },
  authScroll: {
    flexGrow: 1,
    padding: spacing.lg,
    justifyContent: "center"
  },
  authCard: {
    gap: spacing.xl
  },
  authTabs: {
    flexDirection: "row",
    gap: spacing.sm
  },
  authTab: {
    flex: 1
  },
  formStack: {
    gap: spacing.md
  },
  sessionBar: {
    minHeight: 54,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    paddingBottom: spacing.sm
  },
  iconButton: {
    width: 42,
    height: 42,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
    alignItems: "center",
    justifyContent: "center"
  },
  iconButtonDisabled: {
    opacity: 0.4
  },
  topBrand: {
    flex: 1,
    minWidth: 0
  },
  topBrandName: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: "900"
  },
  topBrandSub: {
    color: colors.muted,
    fontSize: 11,
    marginTop: 2
  },
  sessionTools: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm
  },
  accountSecurityWarning: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: "#7f1d1d",
    borderRadius: radius.md,
    backgroundColor: "#b91c1c",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    ...shadow
  },
  accountSecurityWarningLabel: {
    borderRadius: 999,
    backgroundColor: "#ffffff",
    color: "#991b1b",
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 1
  },
  accountSecurityWarningText: {
    flex: 1,
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "800"
  },
  subscriptionReadOnlyWarning: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.warn,
    borderRadius: radius.md,
    backgroundColor: colors.warnSoft,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    ...shadow
  },
  subscriptionReadOnlyWarningLabel: {
    borderRadius: 999,
    backgroundColor: colors.warn,
    color: "#ffffff",
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 1
  },
  subscriptionReadOnlyWarningText: {
    flex: 1,
    color: colors.warn,
    fontSize: 13,
    fontWeight: "800"
  },
  screen: {
    gap: spacing.lg
  },
  titleBlock: {
    gap: spacing.xs
  },
  title: {
    color: colors.ink,
    fontSize: 24,
    fontWeight: "900"
  },
  subtitle: {
    color: colors.muted,
    fontWeight: "600"
  },
  metricsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm
  },
  metric: {
    width: "48%",
    minHeight: 76,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel2,
    padding: spacing.md,
    justifyContent: "space-between"
  },
  metricPressed: {
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft
  },
  metricLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "800"
  },
  metricValue: {
    color: colors.ink,
    fontSize: 20,
    fontWeight: "900"
  },
  quickActions: {
    flexDirection: "row",
    gap: spacing.sm
  },
  actionButton: {
    flex: 1
  },
  orderRow: {
    minHeight: 70,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingTop: spacing.md,
    flexDirection: "row",
    gap: spacing.md,
    alignItems: "center"
  },
  orderId: {
    color: colors.ink,
    fontWeight: "900"
  },
  mutedText: {
    color: colors.muted,
    marginTop: 3
  },
  orderRight: {
    alignItems: "flex-end",
    gap: spacing.xs
  },
  orderAmount: {
    color: colors.ink,
    fontWeight: "900"
  },
  twoColumn: {
    gap: spacing.md
  },
  fixedRateInput: {
    color: colors.accent,
    backgroundColor: colors.accentSoft,
    fontWeight: "900"
  },
  fixedRateNote: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: "700",
    marginTop: -spacing.sm
  },
  savedCustomerList: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    backgroundColor: colors.panel2,
    overflow: "hidden"
  },
  savedCustomerRow: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    gap: 2
  },
  savedCustomerName: {
    color: colors.ink,
    fontWeight: "800"
  },
  savedCustomerDetail: {
    color: colors.muted,
    fontSize: 12
  },
  settlementGroup: {
    gap: spacing.sm
  },
  settlementGroupTitle: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: "900"
  },
  settlementRow: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingVertical: spacing.sm
  },
  settlementAmount: {
    fontWeight: "900",
    textAlign: "right"
  },
  financialGood: {
    color: colors.good
  },
  financialDanger: {
    color: colors.danger
  },
  financialNeutral: {
    color: colors.muted
  },
  archiveSelector: {
    minHeight: 46,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    backgroundColor: colors.panel2,
    paddingHorizontal: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm
  },
  archiveSelectorText: {
    flex: 1,
    color: colors.ink,
    fontWeight: "800"
  },
  archiveMonthMenu: {
    borderTopWidth: 1,
    borderTopColor: colors.line
  },
  archiveMonthOption: {
    minHeight: 42,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.line
  },
  archiveMonthOptionActive: {
    backgroundColor: colors.accentSoft
  },
  archiveMonthOptionText: {
    color: colors.ink,
    fontWeight: "700"
  },
  archiveMonthOptionTextActive: {
    color: colors.accent
  },
  archiveStatementHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md
  },
  archiveStatementDate: {
    color: colors.ink,
    fontWeight: "900"
  },
  archiveStatementReference: {
    color: colors.muted,
    fontSize: 12,
    marginTop: 2
  },
  archiveBalanceRow: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingVertical: spacing.sm
  },
  archiveBalanceCurrency: {
    color: colors.ink,
    fontWeight: "900"
  },
  archiveBalanceDirection: {
    color: colors.muted,
    fontSize: 12,
    marginTop: 2
  },
  archiveBalanceAmount: {
    fontWeight: "900",
    textAlign: "right"
  },
  archiveToggle: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: colors.line
  },
  archiveToggleText: {
    color: colors.accent,
    fontWeight: "900"
  },
  archiveDetails: {
    gap: 0
  },
  archiveDetailRow: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingVertical: spacing.md,
    gap: 3
  },
  reportVoidRow: {
    backgroundColor: colors.dangerSoft,
    borderTopColor: colors.cancelledSoft,
    paddingHorizontal: spacing.sm
  },
  reportVoidText: {
    color: colors.danger,
    fontSize: 12,
    fontWeight: "900"
  },
  archiveDetailTitle: {
    color: colors.ink,
    fontWeight: "900"
  },
  archiveDetailMeta: {
    color: colors.muted,
    fontSize: 12
  },
  archiveDetailAmount: {
    color: colors.ink,
    fontWeight: "800"
  },
  quoteTop: {
    flexDirection: "row",
    alignItems: "stretch",
    gap: spacing.sm
  },
  quoteAmount: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel2,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs
  },
  quoteArrow: {
    width: 34,
    alignItems: "center",
    justifyContent: "center"
  },
  quoteLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "800"
  },
  quoteValue: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: "900"
  },
  successIcon: {
    width: 72,
    height: 72,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.goodSoft,
    alignSelf: "center"
  },
  moreGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm
  },
  moreButton: {
    width: "48%"
  },
  chatBottomButton: {
    position: "absolute",
    right: spacing.lg,
    bottom: 96,
    zIndex: 10,
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    backgroundColor: colors.accent,
    ...shadow
  },
  tabs: {
    position: "absolute",
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.lg,
    minHeight: 66,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
    flexDirection: "row",
    justifyContent: "space-around",
    alignItems: "center",
    ...shadow
  },
  tabItem: {
    flex: 1,
    alignItems: "center",
    gap: spacing.xs
  },
  tabText: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: "900"
  },
  tabTextActive: {
    color: colors.accent
  },
  errorText: {
    color: colors.danger,
    fontWeight: "700"
  }
});
