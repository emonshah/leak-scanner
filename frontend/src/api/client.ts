const API_URL = import.meta.env.VITE_API_URL || '';

export interface ApiResponse {
  ok: boolean;
  [key: string]: unknown;
}

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) },
      ...options,
    });
  } catch (err) {
    const detail = err instanceof Error && err.message ? ` (${err.message})` : '';
    throw new Error(
      `Cannot reach the backend server. Check that it is running by opening ${API_URL || ''}/api/health in your browser, then restart it in the terminal.${detail}`,
    );
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (data as { error?: string }).error || `HTTP ${res.status}`;
    throw new Error(err);
  }
  return data as T;
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, { method: 'PUT', body: JSON.stringify(body) });
}

export async function apiDelete<T>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, { method: 'DELETE', body: body ? JSON.stringify(body) : undefined });
}
