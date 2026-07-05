import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { apiGet, apiPost } from '../api/client';

export interface User {
  id: number;
  login: string;
  fio: string;
  role: 'admin' | 'operator';
}

interface RegisterInput {
  login: string;
  fio: string;
  password: string;
  code: string;
}

interface AuthCtx {
  user: User | null;
  loading: boolean;
  login: (login: string, password: string) => Promise<void>;
  register: (data: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
  isAdmin: boolean;
}

const Ctx = createContext<AuthCtx>(null as never);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiGet<{ user: User }>('/auth/me')
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = async (login: string, password: string) => {
    const r = await apiPost<{ user: User }>('/auth/login', { login, password });
    setUser(r.user);
  };

  const register = async (data: RegisterInput) => {
    const r = await apiPost<{ user: User }>('/auth/register', data);
    setUser(r.user);
  };

  const logout = async () => {
    await apiPost('/auth/logout', {});
    setUser(null);
  };

  return (
    <Ctx.Provider value={{ user, loading, login, register, logout, isAdmin: user?.role === 'admin' }}>
      {children}
    </Ctx.Provider>
  );
}

export const useAuth = () => useContext(Ctx);
