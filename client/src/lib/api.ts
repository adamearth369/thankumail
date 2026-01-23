// client/src/lib/api.ts
type Json = any;

export type ApiError = {
  error: string;
  code?: string;
  field?: string;
  issues?: any[];
  retryAfterSec?: number;
};

function getApiBase() {
  // If you deploy frontend + backend together (same domain), leave VITE_API_BASE_URL empty.
  // If frontend is a Render Static Site and backend is a Render Web Service, set:
  // VITE_API_BASE_URL=https://<your-backend-service>.onrender.com
  const envBase = (import.meta as any).env?.VITE_API_BASE_URL || "";
  if (envBase) return String(envBase).replace(/\/+$/, "");
  return ""; // same-origin
}

const API_BASE = getApiBase();

export function apiUrl(path: string) {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE}${p}`;
}

export async function apiJson<T = Json>(
  path: string,
  opts: RequestInit & { timeoutMs?: number } = {}
): Promise<T> {
  const { timeoutMs = 20000, ...rest } = opts;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(apiUrl(path), {
      ...rest,
      headers: {
        ...(rest.headers || {}),
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });

    const text = await res.text();
    const data = text ? safeJsonParse(text) : null;

    if (!res.ok) {
      // Normalize error shape
      const err: ApiError =
        (data && typeof data === "object" && (data.error || data.message)) ? {
          error: String((data as any).error || (data as any).message),
          code: (data as any).code,
          field: (data as any).field,
          issues: (data as any).issues,
          retryAfterSec: (data as any).retryAfterSec,
        } : { error: `HTTP ${res.status}` };

      throw err;
    }

    return data as T;
  } catch (e: any) {
    // Pass through normalized API errors; otherwise, make it human
    if (e && typeof e === "object" && typeof e.error === "string") throw e;
    if (e?.name === "AbortError") throw { error: "Request timed out" } as ApiError;
    throw { error: "Network error" } as ApiError;
  } finally {
    clearTimeout(t);
  }
}

function safeJsonParse(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
