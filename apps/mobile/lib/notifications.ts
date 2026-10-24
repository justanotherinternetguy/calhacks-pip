import * as Notifications from 'expo-notifications';
import { AndroidImportance } from 'expo-notifications';
import { router } from 'expo-router';
import { Platform } from 'react-native';

// Native posts the real alerts (check-in, heads-up, alarm). JS only handles foreground display + deep-link routing.
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

function routeFrom(data: Record<string, unknown> | undefined) {
  const route = data?.route;
  if (typeof route === 'string' && route.startsWith('/')) router.push(route as never);
}

export function initNotifications() {
  if (Platform.OS === 'web') return () => {};
  const sub = Notifications.addNotificationResponseReceivedListener((r) => routeFrom(r.notification.request.content.data as Record<string, unknown>));
  Notifications.getLastNotificationResponseAsync().then((r) => r && routeFrom(r.notification.request.content.data as Record<string, unknown>)).catch(() => {});
  if (Platform.OS === 'android') {
    Notifications.setNotificationChannelAsync('safe-alerts', {
      name: 'Safety alerts', importance: AndroidImportance.MAX, vibrationPattern: [0, 500, 250, 500], bypassDnd: true,
    }).catch(() => {});
  }
  return () => sub.remove();
}
