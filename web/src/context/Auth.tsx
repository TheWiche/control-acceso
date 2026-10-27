import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib';
import type { Profile } from '../lib/types';

interface AuthState {
  profile: Profile | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthState>(null as never);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try { setProfile(await api.auth.getProfile()); }
    catch { setProfile(null); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void refresh();
    return api.auth.onChange(() => { void refresh(); });
  }, [refresh]);

  const signIn = useCallback(async (email: string, password: string) => {
    await api.auth.signIn(email.trim(), password);
    const p = await api.auth.getProfile();
    // Este panel es solo para administradores (las políticas RLS ya limitan los datos igualmente).
    if (!p || p.role !== 'admin' || p.status !== 'active') {
      await api.auth.signOut();
      throw new Error('Esta cuenta no tiene permisos de administrador.');
    }
    setProfile(p);
  }, []);

  const signOut = useCallback(async () => { await api.auth.signOut(); setProfile(null); }, []);

  return <Ctx.Provider value={{ profile, loading, signIn, signOut }}>{children}</Ctx.Provider>;
}
