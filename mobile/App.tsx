import { StatusBar } from "expo-status-bar";
import React, { useMemo, useState } from "react";
import {
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
  Repeat2,
  Send,
  ShieldCheck,
  UserPlus
} from "lucide-react-native";
import type { LucideProps } from "lucide-react-native";
import { loginWithPlaceholder, signupWithPlaceholder, submitTransferOrderPlaceholder } from "./src/api/client";
import { BrandHeader, Button, Field, Panel, Pill, SelectRow, SummaryRow } from "./src/components/ui";
import { colors, radius, shadow, spacing } from "./src/theme";
import type { AppScreen, AuthMode, Currency, FundingType, SubmittedOrder, TransferDraft, UserSession } from "./src/types";
import { calculateQuote, compactAmount, currencies, formatAmount } from "./src/utils/money";

type IconComponent = React.ComponentType<LucideProps>;

const initialDraft: TransferDraft = {
  broker: "Brokers Hub",
  sourceCurrency: "EUR",
  payoutCurrency: "ETB",
  sourceAmount: "1000",
  payoutAmount: "",
  rate: "62.5",
  commissionPercent: "1.5",
  fundingType: "cash",
  senderName: "Samir Ali",
  receiverName: "Amina Tesfaye",
  phoneNumber: "+251 900 000 000",
  accountNumber: "",
  remarks: ""
};

const demoOrders = [
  { id: "ORD-128", name: "Amina Tesfaye", amount: "ETB62,500.00", state: "Assigned" },
  { id: "ORD-127", name: "Meron Gebre", amount: "USD540.00", state: "Pending" },
  { id: "ORD-126", name: "Dawit Tesfa", amount: "ERN18,200.00", state: "Paid" }
];

export default function App() {
  const [session, setSession] = useState<UserSession | null>(null);
  const [screen, setScreen] = useState<AppScreen>("home");
  const [draft, setDraft] = useState<TransferDraft>(initialDraft);
  const [submittedOrder, setSubmittedOrder] = useState<SubmittedOrder | null>(null);
  const quote = useMemo(() => calculateQuote(draft), [draft]);

  if (!session) {
    return <AuthScreen onAuthenticated={(nextSession) => setSession(nextSession)} />;
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView style={styles.app} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {screen === "home" && (
            <HomeScreen
              session={session}
              onTransfer={() => setScreen("transfer")}
              onConversion={() => setScreen("conversion")}
            />
          )}
          {screen === "transfer" && (
            <TransferScreen
              draft={draft}
              setDraft={setDraft}
              quote={quote}
              onConversion={() => setScreen("conversion")}
              onContinue={() => setScreen("confirmation")}
            />
          )}
          {screen === "conversion" && (
            <ConversionScreen
              draft={draft}
              quote={quote}
              onEdit={() => setScreen("transfer")}
              onContinue={() => setScreen("confirmation")}
            />
          )}
          {screen === "confirmation" && (
            <ConfirmationScreen
              draft={draft}
              quote={quote}
              submittedOrder={submittedOrder}
              onSubmitted={setSubmittedOrder}
              onEdit={() => setScreen("transfer")}
              onHome={() => {
                setSubmittedOrder(null);
                setDraft(initialDraft);
                setScreen("home");
              }}
            />
          )}
        </ScrollView>
        <BottomTabs current={screen} onChange={setScreen} />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function AuthScreen({ onAuthenticated }: { onAuthenticated: (session: UserSession) => void }) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [loginEmail, setLoginEmail] = useState("master@haderapay.local");
  const [loginPassword, setLoginPassword] = useState("password");
  const [name, setName] = useState("Broker One");
  const [signupEmail, setSignupEmail] = useState("broker@haderapay.local");
  const [signupPassword, setSignupPassword] = useState("password");
  const [inviteCode, setInviteCode] = useState("INVITE-001");

  const submit = async () => {
    setLoading(true);
    setError("");
    try {
      const session = mode === "login"
        ? await loginWithPlaceholder(loginEmail, loginPassword)
        : await signupWithPlaceholder({ name, email: signupEmail, password: signupPassword, inviteCode });
      onAuthenticated(session);
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

function HomeScreen({
  session,
  onTransfer,
  onConversion
}: {
  session: UserSession;
  onTransfer: () => void;
  onConversion: () => void;
}) {
  return (
    <View style={styles.screen}>
      <View style={styles.headerRow}>
        <BrandHeader subtitle={session.workspace} />
        <Pill label={session.role} tone="good" />
      </View>
      <Panel title="Dashboard" badge="Balanced">
        <View style={styles.metricsGrid}>
          <Metric label="Open orders" value="3" />
          <Metric label="Approvals" value="2" />
          <Metric label="Journal lines" value="18" />
          <Metric label="Net" value="USD760" />
        </View>
      </Panel>
      <View style={styles.quickActions}>
        <Button label="New transfer" onPress={onTransfer} icon={<Send size={17} color="#ffffff" />} style={styles.actionButton} />
        <Button label="Convert" onPress={onConversion} variant="secondary" icon={<Repeat2 size={17} color={colors.ink} />} style={styles.actionButton} />
      </View>
      <Panel title="Orderbook" badge="Routing">
        {demoOrders.map((order) => (
          <View key={order.id} style={styles.orderRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.orderId}>{order.id}</Text>
              <Text style={styles.mutedText}>{order.name}</Text>
            </View>
            <View style={styles.orderRight}>
              <Text style={styles.orderAmount}>{order.amount}</Text>
              <Pill label={order.state} tone={order.state === "Paid" ? "good" : order.state === "Pending" ? "warn" : "neutral"} />
            </View>
          </View>
        ))}
      </Panel>
      <Panel title="State Machine" badge="Strict">
        {["Draft", "Pending", "Assigned", "Paid", "Voided"].map((item, index) => (
          <View key={item} style={styles.stepRow}>
            <View style={[styles.stepDot, index < 4 && styles.stepDotActive]} />
            <Text style={styles.stepText}>{item}</Text>
          </View>
        ))}
      </Panel>
    </View>
  );
}

function TransferScreen({
  draft,
  setDraft,
  quote,
  onConversion,
  onContinue
}: {
  draft: TransferDraft;
  setDraft: React.Dispatch<React.SetStateAction<TransferDraft>>;
  quote: ReturnType<typeof calculateQuote>;
  onConversion: () => void;
  onContinue: () => void;
}) {
  const setField = <K extends keyof TransferDraft>(key: K, value: TransferDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  return (
    <View style={styles.screen}>
      <HeaderTitle title="Create Order" subtitle="Mobile money transfer form" />
      <Panel title="Money Transfer" badge="Draft">
        <Field label="Broker" value={draft.broker} onChangeText={(value) => setField("broker", value)} />
        <View style={styles.twoColumn}>
          <SelectRow<Currency> label="Source currency" options={currencies} value={draft.sourceCurrency} onChange={(value) => setField("sourceCurrency", value)} />
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
        <Button label="Preview conversion" onPress={onConversion} variant="secondary" icon={<Repeat2 size={17} color={colors.ink} />} style={styles.actionButton} />
        <Button label="Review order" onPress={onContinue} icon={<ArrowRight size={17} color="#ffffff" />} style={styles.actionButton} />
      </View>
    </View>
  );
}

function ConversionScreen({
  draft,
  quote,
  onEdit,
  onContinue
}: {
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
        <SummaryRow label="Source leg" value={`${compactAmount(quote.sourceCurrency, quote.sourceAmount)} from ${draft.broker}`} />
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
  draft,
  quote,
  submittedOrder,
  onSubmitted,
  onEdit,
  onHome
}: {
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
      const order = await submitTransferOrderPlaceholder(draft);
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
        <HeaderTitle title="Submitted" subtitle="Placeholder API response" />
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
        <SummaryRow label="Broker" value={draft.broker} />
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
      <Text style={styles.metricValue}>{value}</Text>
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

function BottomTabs({ current, onChange }: { current: AppScreen; onChange: (screen: AppScreen) => void }) {
  const tabs: Array<{ id: AppScreen; label: string; Icon: IconComponent }> = [
    { id: "home", label: "Home", Icon: LayoutDashboard },
    { id: "transfer", label: "Transfer", Icon: Send },
    { id: "conversion", label: "Convert", Icon: Repeat2 },
    { id: "confirmation", label: "Confirm", Icon: ShieldCheck }
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
    paddingBottom: 110
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
  screen: {
    gap: spacing.lg
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md
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
    fontSize: 22,
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
  stepRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 34
  },
  stepDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.line
  },
  stepDotActive: {
    borderColor: colors.accent,
    backgroundColor: colors.accent
  },
  stepText: {
    color: colors.ink,
    fontWeight: "800"
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
