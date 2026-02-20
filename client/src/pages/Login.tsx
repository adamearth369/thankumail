// WHERE TO PASTE: client/src/pages/Login.tsx
// ACTION: Full file replacement (paste exactly)

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { apiJson } from "@/lib/api";

type ApiError = {
  error: string;
  field?: string;
  code?: string;
  codes?: string[];
  issues?: any[];
  retryAfterSec?: number;
  version?: string;
};

type AuthRequestOk = {
  ok: true;
  token?: string;
  loginUrl?: string;
  expiresAt: string;
  sent?: boolean;
  emailSent?: boolean;
  version?: string;
};

declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement | string,
        opts: {
          sitekey: string;
          theme?: "light" | "dark" | "auto";
          callback?: (token: string) => void;
          "error-callback"?: () => void;
          "expired-callback"?: () => void;
          "timeout-callback"?: () => void;
          "response-field"?: boolean;
          "response-field-name"?: string;
          "refresh-expired"?: "auto" | "manual";
          "refresh-timeout"?: "auto" | "manual";
          size?: "normal" | "compact";
          [k: string]: any;
        }
      ) => string;
      reset: (widgetId?: string) => void;
      remove: (widgetId?: string) => void;
      getResponse?: (widgetId?: string) => string;
    };
    __tm_turnstile?: any;
  }
}

const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const FALLBACK_TURNSTILE_SITE_KEY = "0x4AAAAAACXaTgda6akpnmmC";

// Keep token very fresh to avoid "timeout-or-duplicate"
const MAX_TOKEN_AGE_MS = 45_000;

function isEmail(s: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
}

function classNames(...xs: Array<string | false | undefined | null>) {
  return xs.filter(Boolean).join(" ");
}

function waitForTurnstile(maxMs: number) {
  return new Promise<boolean>((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (window.turnstile && typeof window.turnstile.render === "function") return resolve(true);
      if (Date.now() - start >= maxMs) return resolve(false);
      setTimeout(tick, 50);
    };
    tick();
  });
}

function getTurnstileSiteKey() {
  try {
    const v = (import.meta as any)?.env?.VITE_TURNSTILE_SITE_KEY;
    const envKey = typeof v === "string" ? v.trim() : "";
    return (envKey || FALLBACK_TURNSTILE_SITE_KEY || "").trim();
  } catch {
    return (FALLBACK_TURNSTILE_SITE_KEY || "").trim();
  }
}

function parseApiError(e: any): ApiError {
  if (!e) return { error: "Unknown error" };
  if (typeof e === "string") return { error: e };
  if (typeof e?.error === "string") return e as ApiError;
  return { error: "Request failed" };
}

function isTurnstileFail(err: ApiError) {
  return String(err?.code || "").toUpperCase() === "TURNSTILE_FAILED";
}

export default function Login() {
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [tokenIssuedAt, setTokenIssuedAt] = useState<number>(0);

  const [turnstileReady, setTurnstileReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [error, setError] = useState("");
  const [result, setResult] = useState<AuthRequestOk | null>(null);

  const widgetIdRef = useRef<string | null>(null);
  const widgetContainerRef = useRef<HTMLDivElement | null>(null);

  const TURNSTILE_SITE_KEY = useMemo(() => getTurnstileSiteKey(), []);

  useEffect(() => {
    let cancelled = false;

    async function ensureTurnstile() {
      const keyNow = getTurnstileSiteKey();
      if (!keyNow) {
        setTurnstileReady(false);
        setError("Verification is not configured.");
        return;
      }

      const existing = document.querySelector<HTMLScriptElement>(`script[src="${TURNSTILE_SCRIPT_SRC}"]`);
      if (!existing) {
        const script = document.createElement("script");
        script.src = TURNSTILE_SCRIPT_SRC;
        script.async = true;
        script.defer = true;
        script.onerror = () => {
          if (cancelled) return;
          setTurnstileReady(false);
          setError("Verification failed to load. Please refresh and try again.");
        };
        document.head.appendChild(script);
      }

      const ok = await waitForTurnstile(8000);
      if (cancelled) return;

      setTurnstileReady(ok);
      if (!ok) setError("Verification is taking too long to initialize. Please refresh and try again.");
    }

    ensureTurnstile();
    return () => {
      cancelled = true;
    };
  }, [TURNSTILE_SITE_KEY]);

  function clearToken() {
    setToken("");
    setTokenIssuedAt(0);
  }

  function destroyWidget() {
    try {
      if (widgetIdRef.current && window.turnstile?.remove) window.turnstile.remove(widgetIdRef.current);
    } catch {}
    widgetIdRef.current = null;
    if (widgetContainerRef.current) widgetContainerRef.current.innerHTML = "";
    clearToken();
  }

  function resetWidget() {
    try {
      if (widgetIdRef.current && window.turnstile?.reset) window.turnstile.reset(widgetIdRef.current);
    } catch {}
    clearToken();
  }

  function renderWidget() {
    const el = widgetContainerRef.current;
    if (!el) return;
    if (!window.turnstile?.render) return;

    const sitekey = getTurnstileSiteKey();
    if (!sitekey) {
      setError("Verification is not configured.");
      return;
    }

    clearToken();
    el.innerHTML = "";

    try {
      const id = window.turnstile.render(el, {
        sitekey,
        theme: "auto",
        size: "normal",

        // IMPORTANT: create a hidden input so we can always read the freshest token
        "response-field": true,
        "response-field-name": "tm_auth_turnstile_response",

        callback: (t: string) => {
          const tt = String(t || "").trim();
          setToken(tt);
          setTokenIssuedAt(Date.now());
          setError("");
          try {
            window.__tm_turnstile = { page: "login", widgetId: id, tokenLen: tt.length, tokenIssuedAt: Date.now() };
          } catch {}
        },

        "expired-callback": () => {
          clearToken();
        },
        "timeout-callback": () => {
          clearToken();
        },
        "error-callback": () => {
          clearToken();
          setError("Verification failed. Please try again.");
        },

        "refresh-expired": "auto",
        "refresh-timeout": "auto",
      });

      if (typeof id === "string") widgetIdRef.current = id;
    } catch {
      setError("Verification failed to initialize. Please refresh and try again.");
    }
  }

  useEffect(() => {
    if (!turnstileReady) return;
    if (!widgetContainerRef.current) return;
    if (!window.turnstile?.render) return;

    destroyWidget();
    requestAnimationFrame(() => requestAnimationFrame(() => renderWidget()));

    return () => destroyWidget();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnstileReady, TURNSTILE_SITE_KEY]);

  function readHiddenInputToken() {
    try {
      const host = widgetContainerRef.current;
      const input = host?.querySelector<HTMLInputElement>('input[name="tm_auth_turnstile_response"]');
      const v = input?.value ? String(input.value).trim() : "";
      return v;
    } catch {
      return "";
    }
  }

  function readTurnstileTokenFresh() {
    const now = Date.now();

    // 1) hidden input (freshest)
    const fromInput = readHiddenInputToken();
    if (fromInput && fromInput.length > 20) return { token: fromInput, issuedAt: tokenIssuedAt || now };

    // 2) state
    const fromState = String(token || "").trim();
    if (fromState && fromState.length > 20) return { token: fromState, issuedAt: tokenIssuedAt || now };

    // 3) turnstile.getResponse
    try {
      const wid = widgetIdRef.current || undefined;
      const t = String(window.turnstile?.getResponse?.(wid) || "").trim();
      if (t && t.length > 20) return { token: t, issuedAt: tokenIssuedAt || now };
    } catch {}

    return { token: "", issuedAt: 0 };
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    setResult(null);

    const em = String(email || "").trim().toLowerCase();
    if (!isEmail(em)) {
      setSubmitting(false);
      setError("Enter a valid email.");
      return;
    }

    const { token: t, issuedAt } = readTurnstileTokenFresh();
    if (!t) {
      setSubmitting(false);
      setError("Please complete the verification.");
      return;
    }

    const age = issuedAt ? Date.now() - issuedAt : 999999;
    if (age > MAX_TOKEN_AGE_MS) {
      resetWidget();
      setSubmitting(false);
      setError("Verification expired — please verify again.");
      return;
    }

    try {
      const data = await apiJson<AuthRequestOk>("/api/auth/request", {
        method: "POST",
        body: JSON.stringify({ email: em, turnstileToken: t }),
        auth: false,
      });

      if (!data?.ok) {
        const err = parseApiError(data || { error: "Request failed" });
        setError(err.error || "Request failed");
        resetWidget();
        setSubmitting(false);
        return;
      }

      setResult(data);

      // Always reset so the next auth request cannot reuse token
      resetWidget();
      setSubmitting(false);
    } catch (e: any) {
      const err = parseApiError(e);
      setError(err.error || "Request failed");
      if (isTurnstileFail(err)) resetWidget();
      else resetWidget();
      setSubmitting(false);
    }
  }

  const box = "rounded-2xl border border-tm-charcoal/20 bg-white p-5 shadow-soft text-tm-charcoal";
  const input =
    "w-full rounded-xl border px-3 py-2 outline-none bg-tm-cream text-tm-charcoal " +
    "placeholder:text-tm-charcoal/60 placeholder:opacity-100 border-tm-charcoal/30 " +
    "focus:border-tm-charcoal focus:ring-2 focus:ring-tm-honey/30";

  const { token: canTok, issuedAt: canIssuedAt } = readTurnstileTokenFresh();
  const canSubmit =
    !submitting && isEmail(email) && canTok.length >= 20 && Date.now() - (canIssuedAt || 0) <= MAX_TOKEN_AGE_MS;

  return (
    <div className="w-full max-w-xl mx-auto">
      <div className={box}>
        <div className="flex items-center justify-between">
          <div className="text-lg font-outfit font-semibold tracking-tight">Registered login</div>
          <Link href="/" className="text-sm underline text-tm-charcoal/70 hover:text-tm-charcoal">
            Back
          </Link>
        </div>

        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            autoComplete="email"
            placeholder="Email"
            className={input}
          />

          <div className="text-sm font-medium text-tm-charcoal">Human check</div>

          <div
            id="tm-auth-turnstile"
            ref={widgetContainerRef}
            className="min-h-[65px] rounded-xl border bg-tm-cream flex items-center justify-center overflow-hidden border-tm-charcoal/30"
          />

          {error ? (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          ) : null}

          {result?.ok ? (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm text-emerald-800">
              <div className="font-medium">{result.token ? "Magic link token created." : "Magic link sent."}</div>

              {result.token ? (
                <>
                  <div className="mt-2 break-all text-xs text-emerald-900/80">
                    Token: <span className="font-mono">{result.token}</span>
                  </div>
                  <div className="mt-2 text-xs text-emerald-900/70">Expires: {result.expiresAt}</div>

                  <div className="mt-3">
                    <a
                      href={result.loginUrl || `/auth/consume?token=${encodeURIComponent(result.token)}`}
                      className="inline-block rounded-xl border border-emerald-300 bg-white px-3 py-2 text-xs font-medium text-emerald-900 hover:bg-emerald-50"
                    >
                      Consume token now
                    </a>
                  </div>
                </>
              ) : (
                <div className="mt-2 text-xs text-emerald-900/70">Expires: {result.expiresAt}</div>
              )}

              {result.emailSent === true ? (
                <div className="mt-2 text-[11px] text-emerald-900/60">Email queued.</div>
              ) : null}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={!canSubmit}
            className={classNames(
              "w-full rounded-2xl px-5 py-4 transition font-outfit text-lg tracking-tight border-2",
              canSubmit
                ? "bg-tm-amber text-tm-charcoal border-tm-charcoal/30 cursor-pointer shadow-soft hover:shadow-xl hover:opacity-95 hover:-translate-y-[1px] active:translate-y-0 active:opacity-90"
                : "bg-slate-200 text-slate-500 border-slate-300 cursor-not-allowed"
            )}
          >
            {submitting ? "Requesting…" : "Request magic link"}
          </button>
        </form>
      </div>
    </div>
  );
}
