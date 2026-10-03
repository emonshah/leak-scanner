import { useEffect, useState, useCallback } from 'react';
import { apiFetch, apiPost } from '@/api/client';
import type { ProfileUser } from '@/types';

export function useAuth() {
  const [user, setUser] = useState<ProfileUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await apiFetch<{ ok: boolean; user: ProfileUser }>('/api/auth/me');
      setUser(data.user);
    } catch {
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = async (email: string, password: string): Promise<ProfileUser> => {
    const data = await apiPost<{ ok: boolean; user: ProfileUser }>('/api/auth/login', { email, password });
    setUser(data.user);
    return data.user;
  };

  const logout = async (): Promise<void> => {
    await apiPost<{ ok: boolean }>('/api/auth/logout', {});
    setUser(null);
  };

  return { user, isLoading, login, logout, refresh };
}
