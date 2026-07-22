import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { actionRequiredNoticesFor } from "../domain/workspace";
import type { AppScreen, UserSession, WorkspaceState } from "../types";

const actionChannelId = "action-required";
const seenKeyPrefix = "haderapay.action-notifications.v1";
const notificationLocks = new Set<string>();

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false
  })
});

function notificationScope(session: UserSession): string {
  return `${seenKeyPrefix}:${session.workspaceId}:${session.actorId}`;
}

async function notificationPermissionGranted(): Promise<boolean> {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(actionChannelId, {
      name: "Action required",
      description: "Orders and transfers that need your response",
      importance: Notifications.AndroidImportance.HIGH,
      sound: "default",
      enableVibrate: true,
      vibrationPattern: [0, 250, 180, 250]
    });
  }
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  const requested = await Notifications.requestPermissionsAsync();
  return requested.granted;
}

function readSeenKeys(value: string | null): Set<string> {
  if (!value) return new Set();
  try {
    const parsed = JSON.parse(value);
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

export async function notifyNewRequiredActions(session: UserSession, state: WorkspaceState): Promise<void> {
  if (session.role === "Owner" || state.offlineSnapshot) return;
  const scope = notificationScope(session);
  if (notificationLocks.has(scope)) return;
  notificationLocks.add(scope);
  try {
    const notices = actionRequiredNoticesFor(session, state);
    if (!notices.length) return;
    const seen = readSeenKeys(await AsyncStorage.getItem(scope));
    const unseen = notices.filter((notice) => !seen.has(notice.key));
    if (!unseen.length || !(await notificationPermissionGranted())) return;
    for (const notice of unseen) {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: notice.title,
          body: notice.body,
          sound: "default",
          priority: Notifications.AndroidNotificationPriority.HIGH,
          data: { actionKey: notice.key, screen: notice.screen }
        },
        trigger: Platform.OS === "android" ? { channelId: actionChannelId } : null
      });
      seen.add(notice.key);
    }
    await AsyncStorage.setItem(scope, JSON.stringify(Array.from(seen).slice(-250)));
  } finally {
    notificationLocks.delete(scope);
  }
}

export function subscribeToActionNotificationResponses(onNavigate: (screen: AppScreen) => void): () => void {
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    const screen = response.notification.request.content.data?.screen;
    if (screen === "orders" || screen === "transfers") onNavigate(screen);
  });
  return () => subscription.remove();
}
