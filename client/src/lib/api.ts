type Json = any;

export type ApiError = {
  error: string;
  code?: string;
  field?: string;
  issues?: any[];
  retryAfterSec?: number;
};

function getApiBase() {
  const envBase = (import.meta as any).env?.VITE_API_BASE_URL || "";
  if (envBase) return String(envBase).replace(/\/+$/, "");
  return ""; // same-origin
}

const API_BASE = getApiBase();

export function apiUrl(path: string) {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE}${p}`;
}

function getSessionToken() {
  try {
    return String(localStorage.getItem("tm_session_token") || "").trim();
  } catch {
    return "";
  }
}

function rememberBackendCommit(commit: string) {
  try {
    if (commit) localStorage.setItem("tm_api_commit", commit);
  } catch {}
}

function getRememberedBackendCommit() {
  try {
    return String(localStorage.getItem("tm_api_commit") || "").trim();
  } catch {
    return "";
  }
}

export async function apiJson<T = Json>(
  path: string,
  opts: RequestInit & { timeoutMs?: number; auth?: boolean } = {},
): Promise<T> {
  const { timeoutMs = 20000, auth = true, ...rest } = opts;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const token = auth ? getSessionToken() : "";
    const headers: Record<string, string> = {
      ...(rest.headers as any),
    };

    if (rest.body != null && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    if (token && !headers["Authorization"]) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch(apiUrl(path), {
      ...rest,
      headers,
      signal: controller.signal,
    });

    const xCommit = res.headers.get("x-commit") || "";
    if (xCommit) rememberBackendCommit(xCommit);

    const text = await res.text();
    const data = text ? safeJsonParse(text) : null;

    if (!res.ok) {
      const err: ApiError =
        data && typeof data === "object" && ((data as any).error || (data as any).message)
          ? {
              error: String((data as any).error || (data as any).message),
              code: (data as any).code,
              field: (data as any).field,
              issues: (data as any).issues,
              retryAfterSec: (data as any).retryAfterSec,
            }
          : { error: `HTTP ${res.status}` };

      throw err;
    }

    return data as T;
  } catch (e: any) {
    if (e && typeof e === "object" && typeof e.error === "string") throw e;
    if (e?.name === "AbortError") throw { error: "Request timed out" } as ApiError;
    throw { error: "Network error" } as ApiError;
  } finally {
    clearTimeout(t);
  }
}

export async function getBackendCommit(): Promise<string> {
  const remembered = getRememberedBackendCommit();
  if (remembered) return remembered;

  try {
    const res = await fetch(apiUrl("/api/version"), { method: "GET" });
    const xCommit = res.headers.get("x-commit") || "";
    if (xCommit) {
      rememberBackendCommit(xCommit);
      return xCommit;
    }
  } catch {}

  return "";
}

function safeJsonParse(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}