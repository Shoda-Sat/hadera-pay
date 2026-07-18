import React from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleProp,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  View,
  ViewStyle
} from "react-native";
import { colors, radius, shadow, spacing } from "../theme";

let userActivityHandler: (() => void) | null = null;

export function setUserActivityHandler(handler: (() => void) | null): void {
  userActivityHandler = handler;
}

function reportUserActivity(): void {
  userActivityHandler?.();
}

type ButtonVariant = "primary" | "secondary" | "danger";
export type PillTone = "neutral" | "good" | "warn" | "danger" | "assigned" | "returned" | "cancelled" | "voided";

export function BrandHeader({ subtitle }: { subtitle?: string }) {
  return (
    <View style={styles.brand}>
      <View style={styles.brandMark}>
        <Text style={styles.brandMarkText}>HP</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.brandName}>HaderaPay</Text>
        <Text style={styles.brandSub}>{subtitle || "Clearing ledger"}</Text>
      </View>
    </View>
  );
}

export function Button({
  label,
  onPress,
  variant = "primary",
  icon,
  loading = false,
  disabled = false,
  style
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  icon?: React.ReactNode;
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      onPress={() => {
        reportUserActivity();
        onPress();
      }}
      style={({ pressed }) => [
        styles.button,
        styles[variant],
        (pressed || disabled || loading) && styles.buttonPressed,
        style
      ]}
    >
      {loading ? <ActivityIndicator color={variant === "primary" ? "#ffffff" : colors.accent} /> : icon}
      <Text style={[styles.buttonText, variant === "primary" && styles.primaryText]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Panel({
  title,
  badge,
  badgeTone,
  children,
  style
}: {
  title?: string;
  badge?: string;
  badgeTone?: PillTone;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.panel, style]}>
      {(title || badge) && (
        <View style={styles.panelHead}>
          {title ? <Text style={styles.panelTitle}>{title}</Text> : <View />}
          {badge ? <Pill label={badge} tone={badgeTone} /> : null}
        </View>
      )}
      {children}
    </View>
  );
}

export function Field({
  label,
  value,
  onChangeText,
  inputRef,
  placeholder,
  keyboardType,
  secureTextEntry,
  multiline,
  onFocus,
  style,
  ...inputProps
}: TextInputProps & {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  inputRef?: React.Ref<TextInput>;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={(nextValue) => {
          reportUserActivity();
          onChangeText?.(nextValue);
        }}
        onFocus={(event) => {
          reportUserActivity();
          onFocus?.(event);
        }}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        keyboardType={keyboardType}
        secureTextEntry={secureTextEntry}
        multiline={multiline}
        style={[styles.input, multiline && styles.textarea, style]}
        {...inputProps}
      />
    </View>
  );
}

export function SelectRow<T extends string>({
  label,
  options,
  value,
  onChange
}: {
  label: string;
  options: T[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.segmented}>
        {options.map((option) => {
          const active = option === value;
          return (
            <Pressable
              accessibilityRole="button"
              key={option}
              onPress={() => {
                reportUserActivity();
                onChange(option);
              }}
              style={[styles.segment, active && styles.segmentActive]}
            >
              <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{option}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function Pill({ label, tone = "neutral" }: { label: string; tone?: PillTone }) {
  return (
    <View style={[
      styles.pill,
      tone === "good" && styles.pillGood,
      tone === "warn" && styles.pillWarn,
      tone === "danger" && styles.pillDanger,
      tone === "assigned" && styles.pillAssigned,
      tone === "returned" && styles.pillReturned,
      tone === "cancelled" && styles.pillCancelled,
      tone === "voided" && styles.pillVoided
    ]}>
      <Text style={[
        styles.pillText,
        tone === "good" && styles.pillGoodText,
        tone === "warn" && styles.pillWarnText,
        tone === "danger" && styles.pillDangerText,
        tone === "assigned" && styles.pillAssignedText,
        tone === "returned" && styles.pillReturnedText,
        tone === "cancelled" && styles.pillCancelledText,
        tone === "voided" && styles.pillVoidedText
      ]}>
        {label}
      </Text>
    </View>
  );
}

export function SummaryRow({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.summaryRow}>
      <Text style={styles.summaryLabel}>{label}</Text>
      <Text style={[styles.summaryValue, strong && styles.summaryStrong]}>{value}</Text>
    </View>
  );
}

export const styles = StyleSheet.create({
  brand: {
    flexDirection: "row",
    gap: spacing.md,
    alignItems: "center"
  },
  brandMark: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.accent
  },
  brandMarkText: {
    color: "#ffffff",
    fontWeight: "900"
  },
  brandName: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: "900"
  },
  brandSub: {
    color: colors.muted,
    marginTop: 2
  },
  button: {
    minHeight: 44,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: spacing.sm
  },
  primary: {
    backgroundColor: colors.accent
  },
  secondary: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.line
  },
  danger: {
    backgroundColor: colors.dangerSoft,
    borderWidth: 1,
    borderColor: "#ffd0ca"
  },
  buttonPressed: {
    opacity: 0.72
  },
  buttonText: {
    color: colors.ink,
    fontWeight: "800"
  },
  primaryText: {
    color: "#ffffff"
  },
  panel: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.lg,
    gap: spacing.md,
    ...shadow
  },
  panelHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm
  },
  panelTitle: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: "900",
    flexShrink: 1
  },
  field: {
    gap: spacing.sm
  },
  label: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "800"
  },
  input: {
    minHeight: 46,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
    paddingHorizontal: spacing.md,
    color: colors.ink
  },
  textarea: {
    minHeight: 88,
    paddingTop: spacing.md,
    textAlignVertical: "top"
  },
  segmented: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm
  },
  segment: {
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    minHeight: 38,
    justifyContent: "center"
  },
  segmentActive: {
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft
  },
  segmentText: {
    color: colors.muted,
    fontWeight: "800"
  },
  segmentTextActive: {
    color: colors.accent
  },
  pill: {
    alignSelf: "flex-start",
    maxWidth: "62%",
    paddingVertical: 4,
    paddingHorizontal: 9,
    borderRadius: radius.sm,
    backgroundColor: colors.accentSoft
  },
  pillGood: {
    backgroundColor: colors.goodSoft
  },
  pillWarn: {
    backgroundColor: colors.warnSoft
  },
  pillDanger: {
    backgroundColor: colors.dangerSoft
  },
  pillAssigned: {
    backgroundColor: colors.assignedSoft
  },
  pillReturned: {
    backgroundColor: colors.returnedSoft
  },
  pillCancelled: {
    backgroundColor: colors.cancelledSoft
  },
  pillVoided: {
    backgroundColor: colors.voided
  },
  pillText: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: "900",
    flexShrink: 1
  },
  pillGoodText: {
    color: colors.good
  },
  pillWarnText: {
    color: colors.warn
  },
  pillDangerText: {
    color: colors.danger
  },
  pillAssignedText: {
    color: colors.assigned
  },
  pillReturnedText: {
    color: colors.returned
  },
  pillCancelledText: {
    color: colors.cancelled
  },
  pillVoidedText: {
    color: "#ffffff"
  },
  summaryRow: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.line
  },
  summaryLabel: {
    flex: 1,
    color: colors.muted,
    fontWeight: "700"
  },
  summaryValue: {
    flex: 1,
    color: colors.ink,
    fontWeight: "800",
    textAlign: "right"
  },
  summaryStrong: {
    color: colors.accent,
    fontSize: 16,
    fontWeight: "900"
  }
});
