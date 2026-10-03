import { useEffect, useState, useCallback } from 'react';
import { apiFetch } from '@/api/client';

export function useSetup() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const checkSetup = useCallback(async () => {
    try {
      const data = await apiFetch<{ ok: boolean; configured: boolean }>('/api/setup/status');
      setConfigured(data.configured);
    } catch {
      setConfigured(false);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void checkSetup();
  }, [checkSetup]);

  return { configured, isLoading, checkSetup };
}
