import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { get, post, setCsrfToken } from '@/lib/api';

export interface SessionState {
  authenticated: boolean;
  csrfToken: string | null;
  mode: 'live' | 'demo';
  passwordConfigured: boolean;
}

interface SessionCtx {
  session: SessionState | null;
  refresh: () => Promise<void>;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionState | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await get<SessionState>('/api/auth/session');
      setCsrfToken(s.csrfToken);
      setSession(s);
    } catch {
      setSession({ authenticated: false, csrfToken: null, mode: 'live', passwordConfigured: true });
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onUnauthorized = () => setSession((s) => (s ? { ...s, authenticated: false } : s));
    window.addEventListener('hq:unauthorized', onUnauthorized);
    return () => window.removeEventListener('hq:unauthorized', onUnauthorized);
  }, [refresh]);

  const login = useCallback(
    async (password: string) => {
      const r = await post<{ csrfToken: string }>('/api/auth/login', { password });
      setCsrfToken(r.csrfToken);
      await refresh();
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    await post('/api/auth/logout').catch(() => undefined);
    setCsrfToken(null);
    await refresh();
  }, [refresh]);

  return <Ctx.Provider value={{ session, refresh, login, logout }}>{children}</Ctx.Provider>;
}

export function useSession() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('SessionProvider 밖에서 사용할 수 없습니다.');
  return ctx;
}
