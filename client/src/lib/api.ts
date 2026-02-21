// WHERE TO PASTE: client/src/lib/api.ts
// ACTION: Full file replacement (paste exactly)

type Json = any;

export type ApiError = {
  error: string;
  code?: string;
  field?: string;
  issues?: any[];
  retryAfterSec?: number;
};

const SESSION_TOKEN_KEY = "tm_session_token";

/* -------------------- API BASE -------------------- */

function normalizeBase(b: string) {
  return String(b || "").trim().replace(/\/+$/, "");
}

function getApiBase() {
  // 1) Runtime override (optional): window.__TM_API_BASE__ = "https://api.thankumail.com"
  try {
    const w = typeof window !== "undefined" ? (window as any) : null;
    const rt = typeof w?.__TM_API_BASE__ === "string" ? w.__TM_API_BASE__ : "";
    if (rt) return normalizeBase(rt);
  } catch {}

  // 2) Vite env (preferred name moving forward)
  try {
    const v1 = (import.meta as any).env?.VITE_API_BASE;
    if (typeof v1 === "string" && v1.trim()) return normalizeBase(v1);
  } catch {}

  // 3) Back-compat env (old name)
  try {
    const v2 = (import.meta as any).env?.VITE_API_BASE_URL;
    if (typeof v2 === "string" && v2.trim()) return normalizeBase(v2);
  } catch {}

  // 4) Locked production fallback
  return "https://api.thankumail.com";
}

const API_BASE = getApiBase();

export function apiUrl(path: string) {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE}${p}`;
}

/* -------------------- SESSION TOKEN -------------------- */

export function getSessionToken() {
  try {
    return String(localStorage.getItem(SESSION_TOKEN_KEY) || "").trim();
  } catch {
    return "";
  }
}

export function setSessionToken(token: string) {
  try {
    const t = String(token || "").trim();
    if (!t) return;
    localStorage.setItem(SESSION_TOKEN_KEY, t);
  } catch {}
}

export function clearSessionToken() {
  try {
    localStorage.removeItem(SESSION_TOKEN_KEY);
  } catch {}
}

/* -------------------- BACKEND IDENTITY (COMMIT + API VERSION) -------------------- */

function rememberBackendCommit(commit: string) {
  try {
    if (commit) localStorage.setItem("tm_api_commit", commit);
  } catch {}
}

function rememberBackendApiVersion(v: string) {
  try {
    if (v) localStorage.setItem("tm_api_version", v);
  } catch {}
}

function getRememberedBackendCommit() {
  try {
    return String(localStorage.getItem("tm_api_commit") || "").trim();
  } catch {
    return "";
  }
}

function getRememberedBackendApiVersion() {
  try {
    return String(localStorage.getItem("tm_api_version") || "").trim();
  } catch {
    return "";
  }
}

function getHeader(res: Response, name: string) {
  const direct = res.headers.get(name);
  if (direct) return direct;

  const lower = name.toLowerCase();
  const upper = name.toUpperCase();

  return (
    res.headers.get(lower) ||
    res.headers.get(upper) ||
    res.headers.get(lower.replace(/_/g, "-")) ||
    res.headers.get(upper.replace(/_/g, "-")) ||
    ""
  );
}

function captureBackendIdentityFromResponse(res: Response) {
  const xCommit = getHeader(res, "x-commit") || getHeader(res, "X-Commit") || "";
  const xApiVersion = getHeader(res, "x-api-version") || getHeader(res, "X-Api-Version") || "";

  if (xCommit) rememberBackendCommit(xCommit);
  if (xApiVersion) rememberBackendApiVersion(xApiVersion);
}

/* -------------------- API JSON -------------------- */

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
      credentials: "include",
    });

    captureBackendIdentityFromResponse(res);

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

/* -------------------- READ BACKEND IDENTITY -------------------- */

export async function getBackendCommit(): Promise<string> {
  const remembered = getRememberedBackendCommit();
  if (remembered) return remembered;

  try {
    const res = await fetch(apiUrl("/api/version"), { method: "GET", credentials: "include" });
    captureBackendIdentityFromResponse(res);

    const xCommit = getRememberedBackendCommit();
    if (xCommit) return xCommit;
  } catch {}

  return "";
}

export async function getBackendApiVersion(): Promise<string> {
  const remembered = getRememberedBackendApiVersion();
  if (remembered) return remembered;

  try {
    const res = await fetch(apiUrl("/api/version"), { method: "GET", credentials: "include" });
    captureBackendIdentityFromResponse(res);

    const v = getRememberedBackendApiVersion();
    if (v) return v;
  } catch {}

  return "";
}

/* -------------------- UTILS -------------------- */

function safeJsonParse(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}