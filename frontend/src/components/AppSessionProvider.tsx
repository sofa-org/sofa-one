import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  configureAppSessionTransport, deleteAllAppSessions, deleteAppSession, exchangeAppSession,
  getAppSession, getApiErrorMessage, isApiError, type AppSessionSnapshot,
} from '@/lib/api';
import { bindDashboardStepUpSession, clearDashboardStepUpProof } from '@/pages/dashboard/step-up-session';

interface AppSessionContextValue {
  session: AppSessionSnapshot | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<AppSessionSnapshot | null>;
  exchange: (providerBearer: string) => Promise<AppSessionSnapshot>;
  signOut: () => Promise<void>;
  signOutAll: (stepUpToken: string) => Promise<void>;
}

const AppSessionContext = createContext<AppSessionContextValue | undefined>(undefined);

export function AppSessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AppSessionSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const sessionRef = useRef<AppSessionSnapshot | null>(null);
  const exchangeInFlight = useRef<Promise<AppSessionSnapshot> | null>(null);
  const refreshInFlight = useRef<Promise<AppSessionSnapshot | null> | null>(null);

  const clearSession = useCallback(() => {
    requestVersion.current += 1;
    refreshInFlight.current = null;
    sessionRef.current = null;
    configureAppSessionTransport(null, clearSession);
    bindDashboardStepUpSession(null);
    clearDashboardStepUpProof();
    setSession(null);
    setError(null);
    setLoading(false);
  }, []);

  const acceptSession = useCallback((snapshot: AppSessionSnapshot) => {
    if (sessionRef.current?.mfaVerified && !snapshot.mfaVerified) clearDashboardStepUpProof();
    bindDashboardStepUpSession(snapshot.sessionId);
    sessionRef.current = snapshot;
    configureAppSessionTransport(snapshot.csrfToken, clearSession);
    setSession(snapshot);
    setError(null);
    setLoading(false);
  }, [clearSession]);

  const refresh = useCallback(() => {
    if (exchangeInFlight.current) return exchangeInFlight.current;
    if (refreshInFlight.current) return refreshInFlight.current;
    const version = ++requestVersion.current;
    const pending = getAppSession().then((snapshot) => {
      if (version === requestVersion.current) acceptSession(snapshot);
      return version === requestVersion.current ? snapshot : sessionRef.current;
    }).catch((failure: unknown) => {
      if (version !== requestVersion.current) return sessionRef.current;
      if (isApiError(failure) && failure.statusCode === 401) {
        clearSession();
        return null;
      }
      setError(getApiErrorMessage(failure));
      setLoading(false);
      throw failure;
    }).finally(() => {
      if (refreshInFlight.current === pending) refreshInFlight.current = null;
    });
    refreshInFlight.current = pending;
    return pending;
  }, [acceptSession, clearSession]);

  const exchange = useCallback((providerBearer: string) => {
    if (exchangeInFlight.current) return exchangeInFlight.current;
    const version = ++requestVersion.current;
    refreshInFlight.current = null;
    const pending = exchangeAppSession(providerBearer).then((snapshot) => {
      if (version === requestVersion.current) acceptSession(snapshot);
      return snapshot;
    }).finally(() => { exchangeInFlight.current = null; });
    exchangeInFlight.current = pending;
    return pending;
  }, [acceptSession]);

  const signOut = useCallback(async () => {
    try {
      await deleteAppSession();
      clearSession();
    } catch (failure) {
      if (isApiError(failure) && failure.statusCode === 401) { clearSession(); return; }
      throw failure;
    }
  }, [clearSession]);

  const signOutAll = useCallback(async (stepUpToken: string) => {
    await deleteAllAppSessions(stepUpToken);
    clearSession();
  }, [clearSession]);

  useEffect(() => {
    configureAppSessionTransport(sessionRef.current?.csrfToken ?? null, clearSession);
    void refresh().catch(() => undefined);
    const onFocus = () => { void refresh().catch(() => undefined); };
    const onVisibility = () => { if (document.visibilityState === 'visible') onFocus(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      requestVersion.current += 1;
      refreshInFlight.current = null;
      configureAppSessionTransport(null);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [clearSession, refresh]);

  useEffect(() => {
    if (!session) return;
    const remaining = Date.parse(session.expiresAt) - Date.now();
    if (remaining <= 0) { clearSession(); return; }
    const timer = window.setTimeout(clearSession, remaining);
    return () => window.clearTimeout(timer);
  }, [session, clearSession]);

  return (
    <AppSessionContext.Provider value={{ session, loading, error, refresh, exchange, signOut, signOutAll }}>
      {session && error && <div role="alert" className="border-b border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        Session check unavailable: {error} <button onClick={() => { void refresh().catch(() => undefined); }} className="underline">Retry session check</button>
      </div>}
      {children}
    </AppSessionContext.Provider>
  );
}

export function useAppSession() {
  const context = useContext(AppSessionContext);
  if (!context) throw new Error('useAppSession requires AppSessionProvider');
  return context;
}
