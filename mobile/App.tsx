import { StatusBar } from "expo-status-bar";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
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
  ArrowRight,
  CheckCircle2,
  LayoutDashboard,
  LogIn,
  LogOut,
  RefreshCw,
  Repeat2,
  Send,
  ShieldCheck,
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
import type {
  ActorRecord,
  AppScreen,
  AuthMode,
  Currency,
  FundingType,
  OrderRecord,
  SubmittedOrder,
  TransferDraft,
  UserSession,
  WorkspaceState
} from "./src/types";
import { calculateQuote, compactAmount, currencies, formatAmount } from "./src/utils/money";

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

function actorForSession(session: UserSession, workspaceState: WorkspaceState | null): ActorRecord | undefined {
  return workspaceState?.actors.find((actor) => actor.id === session.actorId) ||
    workspaceState?.actors.find((actor) => actor.name === session.actorName);
}

function majorFromMinor(amountMinor = 0): number {
  return Number(amountMinor || 0) / 100;
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

export default function App() {
  const [session, setSession] = useState<UserSession | null>(null);
  const [booting, setBooting] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);
  const [screen, setScreen] = useState<AppScreen>("home");
  const [draft, setDraft] = useState<TransferDraft>(emptyDraft);
  const [submittedOrder, setSubmittedOrder] = useState<SubmittedOrder | null>(null);
  const [workspaceState, setWorkspaceState] = useState<WorkspaceState | null>(null);
  const [stateLoading, setStateLoading] = useState(false);
  const [stateError, setStateError] = useState("");
  const quote = useMemo(() => calculateQuote(draft), [draft]);

  useEffect(() => {
    let mounted = true;
    getCurrentSession()
      .then((savedSession) => {
        if (!mounted || !savedSession) return;
        setSession(savedSession);
        setDraft(draftForSession(savedSession));
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

  const orderFlowAllowed = canCreateOrders(session);
  const currentScreen = orderFlowAllowed ? screen : "home";

  useEffect(() => {
    if (!orderFlowAllowed && screen !== "home") setScreen("home");
  }, [orderFlowAllowed, screen]);

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
    setScreen("home");
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
      setDraft(emptyDraft);
      setScreen("home");
    }
  };

  if (booting) {
    return <LoadingScreen />;
  }

  if (!session) {
    return <AuthScreen onAuthenticated={handleAuthenticated} />;
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView style={styles.app} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <AppTopBar session={session} onLogout={handleLogout} loggingOut={loggingOut} />
          {stateError ? <Text style={styles.errorText}>{stateError}</Text> : null}
          {currentScreen === "home" && (
            <HomeScreen
              session={session}
              workspaceState={workspaceState}
              stateLoading={stateLoading}
              onRefresh={refreshWorkspace}
              onTransfer={() => setScreen("transfer")}
              onConversion={() => setScreen("conversion")}
            />
          )}
          {orderFlowAllowed && currentScreen === "transfer" && (
            <TransferScreen
              session={session}
              workspaceState={workspaceState}
              draft={draft}
              setDraft={setDraft}
              quote={quote}
              onConversion={() => setScreen("conversion")}
              onContinue={() => setScreen("confirmation")}
            />
          )}
          {orderFlowAllowed && currentScreen === "conversion" && (
            <ConversionScreen
              session={session}
              draft={draft}
              quote={quote}
              onEdit={() => setScreen("transfer")}
              onContinue={() => setScreen("confirmation")}
            />
          )}
          {orderFlowAllowed && currentScreen === "confirmation" && (
            <ConfirmationScreen
              session={session}
              draft={draft}
              quote={quote}
              submittedOrder={submittedOrder}
              onSubmitted={(order) => {
                setSubmittedOrder(order);
                setWorkspaceState(order.state);
              }}
              onEdit={() => setScreen("transfer")}
              onHome={() => {
                setSubmittedOrder(null);
                setDraft(draftForSession(session));
                setScreen("home");
              }}
            />
          )}
        </ScrollView>
        <BottomTabs session={session} current={currentScreen} onChange={setScreen} />
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
  onLogout,
  loggingOut
}: {
  session: UserSession;
  onLogout: () => void;
  loggingOut: boolean;
}) {
  return (
    <View style={styles.sessionBar}>
      <BrandHeader subtitle={session.workspace} />
      <View style={styles.sessionTools}>
        <Pill label={session.actorRole} tone={canCreateOrders(session) ? "good" : "neutral"} />
        <Pressable accessibilityRole="button" accessibilityLabel="Logout" onPress={onLogout} style={styles.iconButton} disabled={loggingOut}>
          {loggingOut ? <ActivityIndicator size="small" color={colors.accent} /> : <LogOut size={20} color={colors.ink} />}
        </Pressable>
      </View>
    </View>
  );
}

function HomeScreen({
  session,
  workspaceState,
  stateLoading,
  onRefresh,
  onTransfer,
  onConversion
}: {
  session: UserSession;
  workspaceState: WorkspaceState | null;
  stateLoading: boolean;
  onRefresh: () => void;
  onTransfer: () => void;
  onConversion: () => void;
}) {
  const orders = visibleOrdersFor(session, workspaceState);
  const assignedOrders = orders.filter((order) => order.state === "Assigned");
  const paidOrders = orders.filter((order) => order.state === "Paid");
  const actorCanSendOrders = canCreateOrders(session);

  return (
    <View style={styles.screen}>
      <Panel title="Dashboard" badge={stateLoading ? "Syncing" : "Live"}>
        <View style={styles.metricsGrid}>
          <Metric label="Open orders" value={String(orders.length)} />
          <Metric label="Assigned" value={String(assignedOrders.length)} />
          <Metric label="Paid" value={String(paidOrders.length)} />
          <Metric label="Currency" value={session.currency} />
        </View>
      </Panel>
      <View style={styles.quickActions}>
        {actorCanSendOrders ? (
          <>
            <Button label="New order" onPress={onTransfer} icon={<Send size={17} color="#ffffff" />} style={styles.actionButton} />
            <Button label="Convert" onPress={onConversion} variant="secondary" icon={<Repeat2 size={17} color={colors.ink} />} style={styles.actionButton} />
          </>
        ) : (
          <Button label="Refresh" onPress={onRefresh} loading={stateLoading} variant="secondary" icon={<RefreshCw size={17} color={colors.ink} />} style={styles.actionButton} />
        )}
      </View>
      <Panel title="Orderbook" badge={session.actorRole}>
        {orders.length ? orders.map((order) => (
          <View key={order.id} style={styles.orderRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.orderId}>{order.id}</Text>
              <Text style={styles.mutedText}>{order.broker === session.actorName ? order.receiverName : order.broker}</Text>
            </View>
            <View style={styles.orderRight}>
              <Text style={styles.orderAmount}>{compactAmount(order.payoutCurrency, majorFromMinor(order.payoutAmountMinor))}</Text>
              <Pill label={order.state} tone={stateTone(order.state)} />
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

function TransferScreen({
  session,
  workspaceState,
  draft,
  setDraft,
  quote,
  onConversion,
  onContinue
}: {
  session: UserSession;
  workspaceState: WorkspaceState | null;
  draft: TransferDraft;
  setDraft: React.Dispatch<React.SetStateAction<TransferDraft>>;
  quote: ReturnType<typeof calculateQuote>;
  onConversion: () => void;
  onContinue: () => void;
}) {
  const actor = actorForSession(session, workspaceState);
  const sourceOptions = actor?.orderMultiCurrencyEnabled === true
    ? currencies
    : [actor?.currency || session.currency].filter((currency): currency is Currency => currencies.includes(currency));
  const sourceCurrency = sourceOptions.includes(draft.sourceCurrency) ? draft.sourceCurrency : sourceOptions[0] || session.currency;
  const setField = <K extends keyof TransferDraft>(key: K, value: TransferDraft[K]) => {
    setDraft((current) => ({ ...current, broker: session.actorName, [key]: value }));
  };

  return (
    <View style={styles.screen}>
      <HeaderTitle title="Create Order" subtitle="Mobile money transfer form" />
      <Panel title="Money Transfer" badge="Draft">
        <SummaryRow label="Broker" value={session.actorName} strong />
        <View style={styles.twoColumn}>
          <SelectRow<Currency> label="Source currency" options={sourceOptions} value={sourceCurrency} onChange={(value) => setField("sourceCurrency", value)} />
          <SelectRow<Currency> label="Payout currency" options={currencies} value={draft.payoutCurrency} onChange={(value) => setField("payoutCurrency", value)} />
        </View>
        <Field label="Source amount" value={draft.sourceAmount} onChangeText={(value) => setField("sourceAmount", value)} keyboardType="decimal-pad" />
        <Field label="Exchange rate" value={draft.rate} onChangeText={(value) => setField("rate", value)} keyboardType="decimal-pad" />
        <Field label="Total payout" value={draft.payoutAmount} onChangeText={(value) => setField("payoutAmount", value)} keyboardType="decimal-pad" placeholder="Auto from source and rate" />
        <Field label="Commission %" value={draft.commissionPercent} onChangeText={(value) => setField("commissionPercent", value)} keyboardType="decimal-pad" />
        <SelectRow<FundingType> label="Payment type" options={["cash", "credit"]} value={draft.fundingType} onChange={(value) => setField("fundingType", value)} />
      </Panel>
      <Panel title="Receiver Details" badge="Required">
        <Field label="Sender name" value={draft.senderName} onChangeText={(value) => setField("senderName", value)} />
        <Field label="Receiver name" value={draft.receiverName} onChangeText={(value) => setField("receiverName", value)} />
        <Field label="Phone number" value={draft.phoneNumber} onChangeText={(value) => setField("phoneNumber", value)} keyboardType="phone-pad" />
        <Field label="Account number" value={draft.accountNumber} onChangeText={(value) => setField("accountNumber", value)} keyboardType="number-pad" />
        <Field label="Remarks" value={draft.remarks} onChangeText={(value) => setField("remarks", value)} multiline />
      </Panel>
      <QuotePanel quote={quote} />
      <View style={styles.quickActions}>
        <Button label="Preview" onPress={onConversion} variant="secondary" icon={<Repeat2 size={17} color={colors.ink} />} style={styles.actionButton} />
        <Button label="Review" onPress={onContinue} icon={<ArrowRight size={17} color="#ffffff" />} style={styles.actionButton} />
      </View>
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
  onSubmitted,
  onEdit,
  onHome
}: {
  session: UserSession;
  draft: TransferDraft;
  quote: ReturnType<typeof calculateQuote>;
  submittedOrder: SubmittedOrder | null;
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
      const order = await submitTransferOrder(session, draft);
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
        <HeaderTitle title="Submitted" subtitle="Sent to Master for routing" />
        <Panel title={submittedOrder.orderId} badge={submittedOrder.status}>
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
      <HeaderTitle title="Confirm Order" subtitle="Review before sending to Master" />
      <Panel title="Order Summary" badge="Ready">
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
        <Button label="Send order" onPress={submit} loading={loading} icon={<Send size={17} color="#ffffff" />} style={styles.actionButton} />
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

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue} numberOfLines={1}>{value}</Text>
    </View>
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
  current,
  onChange
}: {
  session: UserSession;
  current: AppScreen;
  onChange: (screen: AppScreen) => void;
}) {
  const tabs: Array<{ id: AppScreen; label: string; Icon: IconComponent }> = [
    { id: "home", label: "Home", Icon: LayoutDashboard }
  ];
  if (canCreateOrders(session)) {
    tabs.push(
      { id: "transfer", label: "Order", Icon: Send },
      { id: "conversion", label: "Convert", Icon: Repeat2 },
      { id: "confirmation", label: "Confirm", Icon: ShieldCheck }
    );
  }

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
    minHeight: 62,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md
  },
  sessionTools: {
    alignItems: "flex-end",
    gap: spacing.sm
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
