const SECURITY_NOTIFICATIONS_CHANGED_EVENT = 'sofa:security-notifications-changed';

export function notifySecurityNotificationsChanged() {
  window.dispatchEvent(new Event(SECURITY_NOTIFICATIONS_CHANGED_EVENT));
}

export function onSecurityNotificationsChanged(listener: () => void) {
  window.addEventListener(SECURITY_NOTIFICATIONS_CHANGED_EVENT, listener);
  return () => window.removeEventListener(SECURITY_NOTIFICATIONS_CHANGED_EVENT, listener);
}
