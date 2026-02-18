// WHERE TO PASTE: client/src/pages/Login.tsx
// ACTION: Full file replacement

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";

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
  expiresAt: string;
  sent?: boolean;
  version?: string;
};

type AuthRequestResponse = AuthRequestOk | ApiError;

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
  }
}

const API_BASE = "https://api.thankumail.com";
const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const FALLBACK_TURNSTILE_SITE_KEY = "0x4AAAAAACXaTgda6akpnmmC";

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

export default function Login() {
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
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

  function destroyWidget() {
    try {
      if (widgetIdRef.current && window.turnstile?.remove) window.turnstile.remove(widgetIdRef.current);
    } catch {}
    widgetIdRef.current = null;
    if (widgetContainerRef.current) widgetContainerRef.current.innerHTML = "";
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

    setToken("");
    el.innerHTML = "";

    try {
      const id = window.turnstile.render(el, {
        sitekey,
        theme: "auto",
        size: "normal",
        // CRITICAL: do NOT use response-field on React forms; rely on callbacks + getResponse
        "response-field": false,
        callback: (t: string) => {
          const tt = String(t || "").trim();
          setToken(tt);
          setError("");
        },
        "expired-callback": () => setToken(""),
        "timeout-callback": () => setToken(""),
        "error-callback": () => {
          setToken("");
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

  function readTurnstileToken() {
    const fromState = String(token || "").trim();
    if (fromState) return fromState;

    try {
      const wid = widgetIdRef.current || undefined;
      const t = String(window.turnstile?.getResponse?.(wid) || "").trim();
      if (t) return t;
    } catch {}

    return "";
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

    const t = readTurnstileToken();
    if (!t) {
      setSubmitting(false);
      setError("Please complete the verification.");
      return;
    }

    try {
      const resp = await fetch(`${API_BASE}/api/auth/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: em, turnstileToken: t }),
      });

      let data: any = null;
      try {
        data = await resp.json();
      } catch {}

      if (!resp.ok || !data?.ok) {
        const err = parseApiError(data || { error: "Request failed" });
        setError(err.error || "Request failed");

        try {
          if (widgetIdRef.current && window.turnstile?.reset) window.turnstile.reset(widgetIdRef.current);
        } catch {}
        setToken("");
        setSubmitting(false);
        return;
      }

      setResult(data as AuthRequestOk);

      try {
        if (widgetIdRef.current && window.turnstile?.reset) window.turnstile.reset(widgetIdRef.current);
      } catch {}
      setToken("");
      setSubmitting(false);
    } catch (err: any) {
      setError(err?.message || "Network error");
      try {
        if (widgetIdRef.current && window.turnstile?.reset) window.turnstile.reset(widgetIdRef.current);
      } catch {}
      setToken("");
      setSubmitting(false);
    }
  }

  const box = "rounded-2xl border border-tm-charcoal/20 bg-white p-5 shadow-soft text-tm-charcoal";
  const input =
    "w-full rounded-xl border px-3 py-2 outline-none bg-tm-cream text-tm-charcoal " +
    "placeholder:text-tm-charcoal/60 placeholder:opacity-100 border-tm-charcoal/30 " +
    "focus:border-tm-charcoal focus:ring-2 focus:ring-tm-honey/30";

  const canSubmit = !submitting && isEmail(email) && readTurnstileToken().length >= 20;

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
                    <Link
                      href={`/auth/consume?token=${encodeURIComponent(result.token)}`}
                      className="inline-block rounded-xl border border-emerald-300 bg-white px-3 py-2 text-xs font-medium text-emerald-900 hover:bg-emerald-50"
                    >
                      Consume token now
                    </Link>
                  </div>
                </>
              ) : (
                <div className="mt-2 text-xs text-emerald-900/70">Expires: {result.expiresAt}</div>
              )}
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
