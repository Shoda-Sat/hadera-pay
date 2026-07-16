import { StatusBar } from "expo-status-bar";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
  getCurrentSession,
  loadWorkspaceState,
  login,
  logout,
  signup,
  submitTransferOrder
} from "./src/api/client";
import { BrandHeader, Button, Field, Panel, Pill, SelectRow, SummaryRow } from "./src/components/ui";
import { colors, radius, shadow, spacing } from "./src/theme";
import { actingSessionFor, activeActors, isMasterView, transferTargetsFor } from "./src/domain/workspace";
import {
  ActorsScreen,
  ChatScreen,
  LedgerScreen,
  NotificationsPanel,
  OwnerScreen,
  OrdersScreen,
  PendingCancelledScreen,
  ReceivablesScreen,
  SearchScreen,
  SettingsScreen,
  TransfersScreen
} from "./src/screens/WorkspaceScreens";
import type {
  ActorRecord,
  AppScreen,
  ArchiveRecord,
  AuthMode,
  Currency,
  FundingType,
  OrderRecord,
  SavedCustomerRecord,
  SubmittedOrder,
  TransferDraft,
  UserSession,
  WorkspaceState
} from "./src/types";
import { calculateQuote, compactAmount, currencies, formatAmount, inputAmount, majorFromMinor } from "./src/utils/money";

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
  phoneNumber: "",
  accountNumber: "",
  remarks: ""
};

function draftForSession(session: UserSession): TransferDraft {
  return {
    ...emptyDraft,
    broker: session.actorName,
    sourceCurrency: session.currency
  };
}

function draftForOrder(order: OrderRecord): TransferDraft {
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
    phoneNumber: order.phoneNumber || "",
    accountNumber: order.accountNumber || "",
    remarks: order.remarks || ""
  };
}

function actorForSession(session: UserSession, workspaceState: WorkspaceState | null): ActorRecord | undefined {
  return workspaceState?.actors.find((actor) => actor.id === session.actorId) ||
    workspaceState?.actors.find((actor) => actor.name === session.actorName);
}

function newestOrders(a: OrderRecord, b: OrderRecord): number {
  return new Date(b.createdAt || b.updatedAt || 0).getTime() - new Date(a.createdAt || a.updatedAt || 0).getTime();
}

function visibleOrdersFor(session: UserSession, workspaceState: WorkspaceState | null): OrderRecord[] {
  const orders = workspaceState?.orders || [];
  const visible = session.actorRole === "Master"
    ? orders
    : orders.filter((order) =>
        order.broker === session.actorName ||
        order.agent === session.actorName ||
        order.agentActorId === session.actorId
      );
  return visible
    .filter((order) => !["Voided", "Cancelled"].includes(order.state) && order.locked !== true)
    .slice()
    .sort(newestOrders);
}

function stateTone(state: OrderRecord["state"]): "neutral" | "good" | "warn" | "danger" {
  if (state === "Paid") return "good";
  if (["Pending Forward", "Assigned", "Returned", "Void Requested"].includes(state)) return "warn";
  if (["Voided", "Cancelled"].includes(state)) return "danger";
  return "neutral";
}

function actorCanReceivePayouts(role: UserSession["actorRole"]): boolean {
  return ["Agent", "Special Agent", "Special Broker"].includes(role);
}

function orderNumber(order: OrderRecord, session: UserSession): string {
  if (actorCanReceivePayouts(session.actorRole) && (order.agentActorId === session.actorId || order.agent === session.actorName)) {
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
  const [year, month] = monthKey.split("-").map(Number);
  if (!year || !month) return "Unknown month";
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(new Date(year, month - 1, 1));
}

function archiveClosedLabel(value: string | undefined): string {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? "Unknown close time" : date.toLocaleString();
}

function visibleArchivesFor(session: UserSession, workspaceState: WorkspaceState | null): ArchiveRecord[] {
  return (workspaceState?.archives || [])
    .filter((archive) => session.actorRole === "Master" || archive.actor === session.actorName)
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
  const actors = (workspaceState?.actors || []).filter((actor) => actor.active !== false && actor.role !== "Master");
  const visibleActors = session.actorRole === "Master" ? actors : actors.filter((actor) => actor.id === session.actorId);
  const balances = new Map<string, Partial<Record<Currency, number>>>();
  (workspaceState?.ledger || []).forEach((line) => {
    const actor = actors.find((candidate) => line.account === candidate.name || line.account === `${candidate.name} ACTOR_CLEARING`);
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
  const historyRef = useRef<AppScreen[]>(["home"]);
  const selectedActor = workspaceState?.actors.find((actor) => actor.id === selectedActorId);
  const actingSession = session ? actingSessionFor(session, selectedActor) : null;
  const quote = useMemo(() => calculateQuote(draft), [draft]);

  useEffect(() => {
    let mounted = true;
    getCurrentSession()
      .then((savedSession) => {
        if (!mounted || !savedSession) return;
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
    loadWorkspaceState()
      .then((state) => {
        if (mounted) setWorkspaceState(state);
      })
      .catch((error) => {
        if (mounted) setStateError(error instanceof Error ? error.message : "Could not load workspace.");
      })
      .finally(() => {
        if (mounted) setStateLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [session?.workspaceId]);

  const orderFlowAllowed = canCreateOrders(actingSession);
  const currentScreen = !orderFlowAllowed && ["newOrder", "conversion", "confirmation"].includes(screen) ? "home" : screen;

  useEffect(() => {
    if (!orderFlowAllowed && ["newOrder", "conversion", "confirmation"].includes(screen)) setScreen("home");
  }, [orderFlowAllowed, screen]);

  const navigate = (next: AppScreen) => {
    if (next === screen) return;
    historyRef.current.push(next);
    setScreen(next);
  };

  const goBack = () => {
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
    setSession(nextSession);
    setDraft(draftForSession(nextSession));
    setSubmittedOrder(null);
    setSelectedActorId("");
    setEditingOrderId("");
    const firstScreen: AppScreen = nextSession.role === "Owner" ? "owner" : "home";
    historyRef.current = [firstScreen];
    setScreen(firstScreen);
  };

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await logout();
    } catch {
      undefined;
    } finally {
      setLoggingOut(false);
      setSession(null);
      setWorkspaceState(null);
      setSubmittedOrder(null);
      setSelectedActorId("");
      setEditingOrderId("");
      setDraft(emptyDraft);
      historyRef.current = ["home"];
      setScreen("home");
    }
  };

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
    setDraft(draftForOrder(order));
    navigate("newOrder");
  };

  const offline = workspaceState?.offlineSnapshot === true;
  const commonProps = workspaceState ? {
    session: actingSession,
    state: workspaceState,
    offline,
    onState: setWorkspaceState,
    onNavigate: navigate,
    onRefresh: refreshWorkspace
  } : null;

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView style={styles.app} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <AppTopBar
            session={actingSession}
            offline={offline}
            lastSyncedAt={workspaceState?.lastSyncedAt}
            canGoBack={historyRef.current.length > 1}
            onBack={goBack}
            onLogout={() => Alert.alert("Log out?", "This account will stay available offline until you log out.", [
              { text: "Cancel", style: "cancel" },
              { text: "Log out", style: "destructive", onPress: handleLogout }
            ])}
            loggingOut={loggingOut}
          />
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
          {commonProps && currentScreen === "orders" ? <OrdersScreen {...commonProps} onNewOrder={startNewOrder} onEditReturnedOrder={editReturnedOrder} /> : null}
          {commonProps && currentScreen === "pendingCancelled" && isMasterView(actingSession) ? <PendingCancelledScreen {...commonProps} /> : null}
          {commonProps && currentScreen === "transfers" ? <TransfersScreen {...commonProps} /> : null}
          {commonProps && currentScreen === "search" ? <SearchScreen {...commonProps} /> : null}
          {commonProps && currentScreen === "receivables" && (isMasterView(actingSession) || ["Broker", "Special Broker"].includes(actingSession.actorRole)) ? <ReceivablesScreen {...commonProps} /> : null}
          {commonProps && currentScreen === "chat" ? <ChatScreen {...commonProps} /> : null}
          {commonProps && currentScreen === "ledger" ? <LedgerScreen {...commonProps} /> : null}
          {commonProps && currentScreen === "actors" && isMasterView(actingSession) ? <ActorsScreen {...commonProps} /> : null}
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
              onLogout={() => Alert.alert("Log out?", "Your locally cached account will be removed from this device.", [{ text: "Cancel", style: "cancel" }, { text: "Log out", style: "destructive", onPress: handleLogout }])}
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
        <Text style={styles.topBrandSub} numberOfLines={1}>{session.actorName} - {session.actorRole}{offline && lastSyncedAt ? ` - synced ${new Date(lastSyncedAt).toLocaleString()}` : ""}</Text>
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
    { screen: "archive", label: "Archive" },
    ...(isMasterView(session) || ["Broker", "Special Broker"].includes(session.actorRole) ? [{ screen: "receivables" as AppScreen, label: "Receivables" }] : []),
    ...(isMasterView(session) ? [{ screen: "actors" as AppScreen, label: "Actors" }] : []),
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
  const assignedOrders = orders.filter((order) => order.state === "Assigned");
  const actorCanSendOrders = canCreateOrders(session);
  const pendingTransfers = (workspaceState?.transfers || []).filter((transfer) => transfer.state === "Pending Approval").length;
  const ledgerLines = (workspaceState?.ledger || []).filter((line) => session.actorRole === "Master" || String(line.account).includes(session.actorName)).length;

  return (
    <View style={styles.screen}>
      <Panel title="Dashboard" badge={stateLoading ? "Syncing" : "Live"}>
        <View style={styles.metricsGrid}>
          <Metric label="Open orders" value={String(orders.length)} onPress={onOrders} />
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
        {orders.length ? orders.map((order) => (
          <View key={order.id} style={styles.orderRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.orderId}>{orderNumber(order, session)}</Text>
              <Text style={styles.mutedText}>{order.broker === session.actorName ? order.receiverName : order.broker}</Text>
            </View>
            <View style={styles.orderRight}>
              <Text style={styles.orderAmount}>{compactAmount(order.payoutCurrency, majorFromMinor(order.payoutAmountMinor, order.payoutCurrency))}</Text>
              <Pill label={orderStateLabel(session, order)} tone={stateTone(order.state)} />
            </View>
          </View>
        )) : (
          <Text style={styles.mutedText}>{stateLoading ? "Loading orders..." : "No active orders."}</Text>
        )}
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
            const positive = row.netMinor > 0;
            const settled = row.netMinor === 0;
            const positiveTone = session.actorRole === "Master" ? styles.settlementOwed : styles.settlementDue;
            const negativeTone = session.actorRole === "Master" ? styles.settlementDue : styles.settlementOwed;
            return (
              <View key={`${row.actor.id}-${row.currency}`} style={styles.settlementRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.orderId}>{row.actor.name}</Text>
                  <Text style={styles.mutedText}>{settled ? "Zero balance" : positive ? "Actor owes Master" : "Master owes actor"}</Text>
                </View>
                <Text style={[
                  styles.settlementAmount,
                  settled ? styles.settlementZero : positive ? positiveTone : negativeTone
                ]}>
                  {settled ? compactAmount(row.currency, 0) : `${positive ? "+" : "-"}${compactAmount(row.currency, majorFromMinor(Math.abs(row.netMinor), row.currency))}`}
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
  const archives = visibleArchivesFor(session, workspaceState);
  const months = Array.from(new Set(archives.map((archive) => archiveMonthKey(archive.closedAt)).filter(Boolean))).sort().reverse();
  const activeMonth = months.includes(selectedMonth) ? selectedMonth : "";
  const filteredArchives = activeMonth
    ? archives.filter((archive) => archiveMonthKey(archive.closedAt) === activeMonth)
    : archives;
  const monthOptions = ["", ...months];

  const toggleStatement = (statementId: string) => {
    setExpandedStatements((current) => current.includes(statementId)
      ? current.filter((id) => id !== statementId)
      : [...current, statementId]);
  };

  return (
    <View style={styles.screen}>
      <HeaderTitle title="Archive" subtitle="Monthly closed statements" />
      <Button
        label="Refresh archive"
        variant="secondary"
        onPress={onRefresh}
        loading={stateLoading}
        icon={<RefreshCw size={17} color={colors.ink} />}
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
      </Panel>

      {filteredArchives.length ? filteredArchives.map((archive, index) => {
        const statementId = archive.id || `${archive.actor || "actor"}-${archive.closedAt || index}`;
        const expanded = expandedStatements.includes(statementId);
        const balanceRows = currencies
          .map((currency) => ({ currency, netMinor: Number(archive.balances?.[currency] || 0) }))
          .filter((row) => row.netMinor !== 0);
        const orders = archive.orders || [];
        const transfers = archive.transfers || [];
        const ledger = archive.ledger || [];
        const detailCount = orders.length + transfers.length + ledger.length;

        return (
          <Panel
            key={statementId}
            title={session.actorRole === "Master" ? archive.actor || "Actor" : "Closed statement"}
            badge={archiveMonthLabel(archiveMonthKey(archive.closedAt))}
          >
            <View style={styles.archiveStatementHead}>
              <View style={{ flex: 1 }}>
                <Text style={styles.archiveStatementDate}>{archiveClosedLabel(archive.closedAt)}</Text>
                <Text style={styles.archiveStatementReference}>{archive.id || "Archived close"}</Text>
              </View>
              <LockKeyhole size={20} color={colors.danger} />
            </View>

            {balanceRows.length ? balanceRows.map((row) => {
              const actorOwesMaster = row.netMinor > 0;
              const goodForViewer = session.actorRole === "Master" ? actorOwesMaster : !actorOwesMaster;
              return (
                <View key={`${statementId}-${row.currency}`} style={styles.archiveBalanceRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.archiveBalanceCurrency}>{row.currency}</Text>
                    <Text style={styles.archiveBalanceDirection}>
                      {actorOwesMaster ? "Actor owes Master" : "Master owes Actor"}
                    </Text>
                  </View>
                  <Text style={[styles.archiveBalanceAmount, goodForViewer ? styles.archiveBalanceGood : styles.archiveBalanceDanger]}>
                    {compactAmount(row.currency, majorFromMinor(Math.abs(row.netMinor), row.currency))}
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
                {orders.map((order) => (
                  <View key={`order-${statementId}-${order.id}`} style={styles.archiveDetailRow}>
                    <Text style={styles.archiveDetailTitle}>Order {orderNumber(order, session)}</Text>
                    <Text style={styles.archiveDetailMeta}>{order.receiverName || order.accountNumber || order.phoneNumber || "No receiver details"}</Text>
                    <Text style={styles.archiveDetailAmount}>
                      {compactAmount(order.sourceCurrency, majorFromMinor(order.sourceAmountMinor, order.sourceCurrency))} to {compactAmount(order.payoutCurrency, majorFromMinor(order.payoutAmountMinor, order.payoutCurrency))}
                    </Text>
                  </View>
                ))}
                {transfers.map((transfer, transferIndex) => {
                  const currency = transfer.currency || transfer.sourceCurrency || session.currency;
                  return (
                    <View key={`transfer-${statementId}-${transfer.id || transferIndex}`} style={styles.archiveDetailRow}>
                      <Text style={styles.archiveDetailTitle}>Transfer {transfer.id || transferIndex + 1}</Text>
                      <Text style={styles.archiveDetailMeta}>{transfer.from || "Unknown"} to {transfer.to || "Unknown"}</Text>
                      <Text style={styles.archiveDetailAmount}>{compactAmount(currency, majorFromMinor(Number(transfer.amountMinor || 0), currency))}</Text>
                      {transfer.remarks ? <Text style={styles.archiveDetailMeta}>{transfer.remarks}</Text> : null}
                    </View>
                  );
                })}
                {ledger.map((line, lineIndex) => (
                  <View key={`ledger-${statementId}-${line.entryId || line.journal || lineIndex}`} style={styles.archiveDetailRow}>
                    <Text style={styles.archiveDetailTitle}>{line.source || "Ledger"} - {line.direction}</Text>
                    <Text style={styles.archiveDetailMeta}>{line.details || line.account}</Text>
                    <Text style={styles.archiveDetailAmount}>{compactAmount(line.currency, majorFromMinor(line.amountMinor, line.currency))}</Text>
                  </View>
                ))}
                {!detailCount ? <Text style={styles.mutedText}>No archived transaction details.</Text> : null}
              </View>
            ) : null}
          </Panel>
        );
      }) : (
        <Panel title="No statements">
          <Text style={styles.mutedText}>{activeMonth ? `No balances were closed in ${archiveMonthLabel(activeMonth)}.` : "No closed balances have been archived yet."}</Text>
        </Panel>
      )}
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
  const senderCustomers = savedCustomersFor(session, workspaceState, "sender");
  const receiverCustomers = savedCustomersFor(session, workspaceState, "receiver");
  const sourceOptions = actor?.orderMultiCurrencyEnabled === true
    ? currencies
    : [actor?.currency || session.currency].filter((currency): currency is Currency => currencies.includes(currency));
  const sourceCurrency = sourceOptions.includes(draft.sourceCurrency) ? draft.sourceCurrency : sourceOptions[0] || session.currency;
  const setField = <K extends keyof TransferDraft>(key: K, value: TransferDraft[K]) => {
    setDraft((current) => ({ ...current, broker: session.actorName, [key]: value }));
  };
  const setCustomerName = (kind: SavedCustomerRecord["kind"], value: string) => {
    setField(kind === "sender" ? "senderName" : "receiverName", value);
    setActiveCustomerPicker(null);
  };
  const setConversionField = (key: "sourceCurrency" | "payoutCurrency" | "sourceAmount" | "rate", value: Currency | string) => {
    setDraft((current) => {
      const next = { ...current, broker: session.actorName, [key]: value } as TransferDraft;
      const calculated = calculateQuote({ ...next, payoutAmount: "" });
      return {
        ...next,
        payoutAmount: inputAmount(next.payoutCurrency, calculated.payoutAmount)
      };
    });
  };
  const chooseCustomer = (customer: SavedCustomerRecord) => {
    setDraft((current) => customer.kind === "sender"
      ? { ...current, senderName: customer.name, broker: session.actorName }
      : {
        ...current,
        broker: session.actorName,
        receiverName: customer.name,
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
          <SelectRow<Currency> label="Source currency" options={sourceOptions} value={sourceCurrency} onChange={(value) => setConversionField("sourceCurrency", value)} />
          <SelectRow<Currency> label="Payout currency" options={currencies} value={draft.payoutCurrency} onChange={(value) => setConversionField("payoutCurrency", value)} />
        </View>
        <Field label="Source amount" value={draft.sourceAmount} onChangeText={(value) => setConversionField("sourceAmount", value)} keyboardType="decimal-pad" />
        <Field label="Exchange rate" value={draft.rate} onChangeText={(value) => setConversionField("rate", value)} keyboardType="decimal-pad" />
        <Field label="Total payout" value={draft.payoutAmount} onChangeText={(value) => setField("payoutAmount", value)} keyboardType="decimal-pad" placeholder="Auto from source and rate" />
        <Field label="Commission %" value={draft.commissionPercent} onChangeText={(value) => setField("commissionPercent", value)} keyboardType="decimal-pad" />
        <SelectRow<FundingType> label="Payment type" options={["cash", "credit"]} value={draft.fundingType} onChange={(value) => setField("fundingType", value)} />
      </Panel>
      <Panel title="Receiver Details" badge="Required">
        <Field label="Sender name" value={draft.senderName} onChangeText={(value) => setCustomerName("sender", value)} onFocus={() => setActiveCustomerPicker("sender")} />
        {activeCustomerPicker === "sender" ? <SavedCustomerSuggestions customers={senderCustomers} onSelect={chooseCustomer} /> : null}
        <Field label="Receiver name" value={draft.receiverName} onChangeText={(value) => setCustomerName("receiver", value)} onFocus={() => setActiveCustomerPicker("receiver")} />
        {activeCustomerPicker === "receiver" ? <SavedCustomerSuggestions customers={receiverCustomers} onSelect={chooseCustomer} /> : null}
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
        const details = [customer.phoneNumber, customer.accountNumber].filter(Boolean).join(" | ");
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
        <SummaryRow label="Commission" value={`${compactAmount(quote.sourceCurrency, quote.commissionAmount)} at ${draft.commissionPercent || "0"}%`} />
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
  onSubmitted,
  onEdit,
  onHome
}: {
  session: UserSession;
  draft: TransferDraft;
  quote: ReturnType<typeof calculateQuote>;
  submittedOrder: SubmittedOrder | null;
  editingOrderId: string;
  onSubmitted: (order: SubmittedOrder) => void;
  onEdit: () => void;
  onHome: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setLoading(true);
    setError("");
    try {
      const order = await submitTransferOrder(session, draft, editingOrderId);
      onSubmitted(order);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not submit order.");
    } finally {
      setLoading(false);
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
          <SummaryRow label="Created" value={new Date(submittedOrder.createdAt).toLocaleString()} />
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
        <SummaryRow label="Phone" value={draft.phoneNumber || "Not provided"} />
        <SummaryRow label="Account" value={draft.accountNumber || "Not provided"} />
        <SummaryRow label="Funding" value={draft.fundingType === "credit" ? "Credit" : "Cash"} />
        <SummaryRow label="Source amount" value={formatAmount(quote.sourceCurrency, quote.sourceAmount)} />
        <SummaryRow label="Commission" value={formatAmount(quote.sourceCurrency, quote.commissionAmount)} />
        <SummaryRow label="Payout amount" value={formatAmount(quote.payoutCurrency, quote.payoutAmount)} strong />
      </Panel>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      <View style={styles.quickActions}>
        <Button label="Edit" onPress={onEdit} variant="secondary" style={styles.actionButton} />
        <Button label={editingOrderId ? "Resubmit order" : "Send order"} onPress={submit} loading={loading} icon={<Send size={17} color="#ffffff" />} style={styles.actionButton} />
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
      <SummaryRow label="Commission" value={formatAmount(quote.sourceCurrency, quote.commissionAmount)} />
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
  settlementOwed: {
    color: colors.good
  },
  settlementDue: {
    color: colors.danger
  },
  settlementZero: {
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
  archiveBalanceGood: {
    color: colors.good
  },
  archiveBalanceDanger: {
    color: colors.danger
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
