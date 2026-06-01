import { useCallback, useEffect, useState } from 'react';
import { useUser } from '@openfort/react';
import { Bell, AlertTriangle, Loader2, RotateCcw, Check, CheckCheck } from 'lucide-react';
import { DashboardPage, DashboardCard } from './components/DashboardPage';
import {
  listSecurityNotificationsAuth,
  markSecurityNotificationReadAuth,
  markAllSecurityNotificationsReadAuth,
  getApiErrorMessage,
  type SecurityNotificationRecord,
} from '@/lib/api';
import { notifySecurityNotificationsChanged } from './notification-events';

function formatRelativeTime(iso: string | null) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Invalid date';
  const now = Date.now();
  const diff = now - date.getTime();
  const absDiff = Math.abs(diff);
  if (absDiff < 60_000) return 'Just now';
  if (absDiff < 3_600_000) return `${Math.floor(absDiff / 60_000)}m ago`;
  if (absDiff < 86_400_000) return `${Math.floor(absDiff / 3_600_000)}h ago`;
  if (absDiff < 30 * 86_400_000) return `${Math.floor(absDiff / 86_400_000)}d ago`;
  return date.toLocaleDateString();
}

function riskBadgeClasses(riskLevel: string) {
  switch (riskLevel.toLowerCase()) {
    case 'low':
      return 'bg-gray-100 text-gray-700 ring-gray-600/20';
    case 'medium':
      return 'bg-amber-50 text-amber-700 ring-amber-600/20';
    case 'high':
      return 'bg-red-50 text-red-700 ring-red-600/20';
    case 'critical':
      return 'bg-red-100 text-red-800 ring-red-600/30 font-bold';
    default:
      return 'bg-gray-50 text-gray-700 ring-gray-600/20';
  }
}

const DETAIL_FIELD_LABELS: Record<string, string> = {
  result: 'Result',
  reason: 'Policy reason',
  actorType: 'Actor',
  ip: 'IP address',
  userAgent: 'Device',
  requestId: 'Request ID',
  apiKeyPrefix: 'API key',
  keyPrefix: 'API key',
  keyName: 'API key name',
  chainId: 'Chain',
  executionMode: 'Execution mode',
  operation: 'Operation',
  interactionCount: 'Interactions',
  interactionIndex: 'Interaction',
  functionSelector: 'Function selector',
  selector: 'Function selector',
  target: 'Target contract',
  token: 'Token',
  amountUnits: 'Amount',
  maxAmountUnits: 'Limit',
  thresholdUnits: 'Threshold',
  address: 'Address',
  availableAt: 'Available after',
  cooldownHours: 'Cooldown',
  hasContractAllowlist: 'Contract allowlist',
  hasSelectorAllowlist: 'Selector allowlist',
  hasSpendLimit: 'Spend limit',
};

const HIDDEN_DETAIL_FIELDS = new Set(['eventType']);

function humanizeDetailKey(key: string) {
  return (
    DETAIL_FIELD_LABELS[key] ??
    key
      .replace(/([A-Z])/g, ' $1')
      .replace(/[_-]+/g, ' ')
      .replace(/^./, (char) => char.toUpperCase())
  );
}

function formatDetailValue(key: string, value: unknown) {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return JSON.stringify(value);

  if (key === 'availableAt') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  }
  if (key === 'cooldownHours') return `${value}h`;
  return value;
}

function getDetailEntries(metadata: SecurityNotificationRecord['metadata']) {
  if (!metadata) return [];
  return Object.entries(metadata).filter(
    ([key, value]) => !HIDDEN_DETAIL_FIELDS.has(key) && value !== null && value !== undefined && value !== '',
  );
}

export default function SecurityNotificationsPage() {
  const { getAccessToken, isAuthenticated, isLoading: authLoading } = useUser();
  const getToken = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) {
      throw new Error('Openfort session is not ready. Refresh and sign in again.');
    }
    return token;
  }, [getAccessToken]);

  const [notifications, setNotifications] = useState<SecurityNotificationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const unreadCount = notifications.filter((n) => !n.readAt).length;

  const fetchNotifications = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const data = await listSecurityNotificationsAuth(getToken, undefined, signal);
      const sorted = [...data].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
      if (!signal.aborted) {
        setNotifications(sorted);
      }
    } catch (err: unknown) {
      if (!signal.aborted) {
        setError(getApiErrorMessage(err));
      }
    } finally {
      if (!signal.aborted) {
        setLoading(false);
      }
    }
  }, [getToken]);

  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    fetchNotifications(controller.signal);
    return () => controller.abort();
  }, [authLoading, isAuthenticated, fetchNotifications, refreshNonce]);

  async function handleMarkAllRead() {
    if (unreadCount === 0) return;
    setActionLoading(true);
    setActionError(null);
    try {
      await markAllSecurityNotificationsReadAuth(getToken);
      setNotifications((prev) =>
        prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })),
      );
      notifySecurityNotificationsChanged();
    } catch (err: unknown) {
      setActionError(getApiErrorMessage(err));
    } finally {
      setActionLoading(false);
    }
  }

  async function handleMarkRead(notificationId: string) {
    setActionLoading(true);
    setActionError(null);
    try {
      await markSecurityNotificationReadAuth(getToken, notificationId);
      setNotifications((prev) =>
        prev.map((n) =>
          n.id === notificationId ? { ...n, readAt: n.readAt ?? new Date().toISOString() } : n,
        ),
      );
      notifySecurityNotificationsChanged();
    } catch (err: unknown) {
      setActionError(getApiErrorMessage(err));
    } finally {
      setActionLoading(false);
    }
  }

  return (
    <DashboardPage
      title="Security Alerts"
      description="Review security notifications for your wallet and API keys."
      tags={
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-accent/10 px-3 py-1 text-xs font-semibold text-brand-accent">
            <Bell className="h-3.5 w-3.5" />
            {unreadCount} unread
          </span>
        </div>
      }
    >
      {actionError && (
        <div className="flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800 shadow-sm">
          <AlertTriangle className="h-5 w-5 shrink-0 text-red-600" />
          {actionError}
        </div>
      )}

      <DashboardCard
        title="Notifications"
        description={
          unreadCount > 0
            ? `${unreadCount} unread notification${unreadCount === 1 ? '' : 's'}`
            : 'All caught up'
        }
      >
        <div className="mb-4 flex items-center justify-end">
          <button
            onClick={handleMarkAllRead}
            disabled={actionLoading || unreadCount === 0}
            className="inline-flex items-center gap-1.5 rounded-full border border-brand-border bg-white px-4 py-1.5 text-xs font-semibold text-brand-text transition-all hover:border-brand-accent hover:bg-brand-bg disabled:cursor-not-allowed disabled:opacity-50"
          >
            {actionLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckCheck className="h-3.5 w-3.5" />
            )}
            Mark all as read
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-brand-accent" />
          </div>
        ) : error ? (
          <div className="flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800 shadow-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <AlertTriangle className="h-5 w-5 shrink-0 text-red-600" />
              <span>{error}</span>
            </div>
            <button
              onClick={() => setRefreshNonce((n) => n + 1)}
              disabled={loading}
              className="inline-flex items-center justify-center gap-1.5 rounded-full border border-red-200 bg-white px-4 py-1.5 text-xs font-semibold text-red-700 transition-all hover:border-red-300 hover:bg-red-100 disabled:opacity-50"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Retry
            </button>
          </div>
        ) : notifications.length === 0 ? (
          <div className="py-12 text-center">
            <Bell className="mx-auto h-8 w-8 text-brand-muted/50" />
            <p className="mt-3 text-base font-semibold text-brand-text">No notifications</p>
            <p className="mt-1 text-sm text-brand-muted">
              Security alerts will appear here when there is activity on your account.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-brand-border">
            {notifications.map((notification) => {
              const detailEntries = getDetailEntries(notification.metadata);

              return (
                <div
                  key={notification.id}
                  className={`flex items-start gap-4 px-2 py-4 transition-colors sm:px-4 ${
                    !notification.readAt ? 'bg-brand-accent/[0.03]' : ''
                  }`}
                >
                {/* Unread indicator */}
                <div className="mt-2 shrink-0">
                  {!notification.readAt ? (
                    <span className="inline-block h-2.5 w-2.5 rounded-full bg-brand-accent" />
                  ) : (
                    <span className="inline-block h-2.5 w-2.5 rounded-full bg-brand-border" />
                  )}
                </div>

                {/* Content */}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${riskBadgeClasses(
                        notification.riskLevel,
                      )}`}
                    >
                      {notification.riskLevel}
                    </span>
                    <span
                      className="text-xs text-brand-muted"
                      title={new Date(notification.createdAt).toLocaleString()}
                    >
                      {formatRelativeTime(notification.createdAt)}
                    </span>
                  </div>
                  <h3 className="mt-1.5 text-sm font-semibold text-brand-text">
                    {notification.title}
                  </h3>
                  <p className="mt-0.5 text-sm text-brand-muted">{notification.body}</p>
                  {detailEntries.length > 0 && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-brand-muted hover:text-brand-text">
                        Details
                      </summary>
                      <dl className="mt-2 grid gap-2 rounded-lg bg-brand-bg p-3 text-xs sm:grid-cols-2">
                        {detailEntries.map(([key, value]) => (
                          <div key={key} className="min-w-0">
                            <dt className="font-medium text-brand-muted">{humanizeDetailKey(key)}</dt>
                            <dd className="mt-0.5 break-words font-mono text-brand-text">
                              {formatDetailValue(key, value)}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </details>
                  )}
                </div>

                {/* Action */}
                <div className="shrink-0">
                  {!notification.readAt ? (
                    <button
                      onClick={() => handleMarkRead(notification.id)}
                      disabled={actionLoading}
                      className="rounded-full border border-brand-border bg-white p-1.5 text-brand-muted transition-colors hover:border-brand-accent hover:text-brand-accent disabled:cursor-not-allowed disabled:opacity-50"
                      aria-label="Mark as read"
                      title="Mark as read"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
                </div>
              );
            })}
          </div>
        )}
      </DashboardCard>
    </DashboardPage>
  );
}
