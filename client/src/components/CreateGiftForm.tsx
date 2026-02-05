// WHERE TO PASTE: client/src/components/CreateGiftForm.tsx
// ACTION: Full file replacement (paste exactly)

import React, { useEffect, useMemo, useRef, useState } from "react";

type ApiError = {
  error: string;
  field?: string;
  code?: string;
  codes?: string[];
  issues?: any[];
  retryAfterSec?: number;
  version?: string;
};

type CreateGiftOk = {
  ok: true;
  publicId: string;
  claimUrl: string;
  deliveryOk?: boolean;
  emailSent?: boolean;
  smsQueued?: boolean;
  version?: string;
  deliveryError?: string;
};

type CreateGiftResponse = CreateGiftOk | ApiError;

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
          "refresh-expired"?: "auto" | "manual";
          "refresh-timeout"?: "auto" | "manual";
          size?: "normal" | "compact";
        }
      ) => string;
      reset: (widgetId?: string) => void;
      remove: (widgetId?: string) => void;
      getResponse: (widgetId?: string) => string;
    };
  }
}

const API_BASE = "https://api.thankumail.com";

// This is NOT secret. It’s the public Turnstile Site Key used by the frontend build.
const TURNSTILE_SITE_KEY = "0x4AAAAAACXaTgda6akpnmmC";
const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

function moneyToCents(dollars: number) {
  const cents = Math.round((Number(dollars) || 0) * 100);
  return Number.isFinite(cents) ? cents : 0;
}

function isEmail(s: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
}

function isE164Phone(s: string) {
  // E.164 basic: + and 8-15 digits
  return /^\+[1-9]\d{7,14}$/.test(String(s || "").trim());
}

function classNames(...xs: Array<string | false | undefined | null>) {
  return xs.filter(Boolean).join(" ");
}

function parseApiError(e: any): ApiError {
  if (!e) return { error: "Unknown error" };
  if (typeof e === "string") return { error: e };
  if (typeof e?.error === "string") return e as ApiError;
  return { error: "Request failed" };
}

export default function CreateGiftForm() {
  const [senderEmail, setSenderEmail] = useState("newstartmedia369@gmail.com");
  const [recipientEmail, setRecipientEmail] = useState("adamgdodds@gmail.com");
  const [recipientPhone, setRecipientPhone] = useState("");
  const [amountDollars, setAmountDollars] = useState<string>("10");
  const [message, setMessage] = useState<string>("");

  const [token, setToken] = useState<string>("");
  const [turnstileReady, setTurnstileReady] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);

  const [error, setError] = useState<string>("");
  const [fieldError, setFieldError] = useState<string>("");
  const [result, setResult] = useState<CreateGiftOk | null>(null);

  const widgetIdRef = useRef<string | null>(null);
  const widgetContainerRef = useRef<HTMLDivElement | null>(null);

  const cents = useMemo(() => moneyToCents(Number(amountDollars)), [amountDollars]);

  const canSubmit = useMemo(() => {
    const s = senderEmail.trim();
    const re = recipientEmail.trim();
    const rp = recipientPhone.trim();
    const hasRecipient = Boolean(re) || Boolean(rp);

    return (
      !submitting &&
      isEmail(s) &&
      hasRecipient &&
      (re ? isEmail(re) : true) &&
      (rp ? isE164Phone(rp) : true) &&
      cents >= 1 &&
      message.trim().length >= 1 &&
      token.length >= 20 // token is usually ~1000+; keep loose but not empty
    );
  }, [submitting, senderEmail, recipientEmail, recipientPhone, cents, message, token]);

  useEffect(() => {
    // Load Turnstile script (once)
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${TURNSTILE_SCRIPT_SRC}"]`);
    if (existing) {
      setTurnstileReady(Boolean(window.turnstile));
      return;
    }

    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT_SRC;
    script.async = true;
    script.defer = true;

    script.onload = () => {
      setTurnstileReady(Boolean(window.turnstile));
    };
    script.onerror = () => {
      setTurnstileReady(false);
      setError("Turnstile failed to load. Please refresh and try again.");
    };

    document.head.appendChild(script);

    return () => {
      // Do not remove script globally; multiple pages may rely on it.
    };
  }, []);

  useEffect(() => {
    // Render Turnstile explicitly into #tm-turnstile once turnstile is ready
    if (!turnstileReady) return;
    if (!widgetContainerRef.current) return;

    // Clear any prior widget
    try {
      if (widgetIdRef.current && window.turnstile?.remove) {
        window.turnstile.remove(widgetIdRef.current);
      }
    } catch {
      // ignore
    }
    widgetIdRef.current = null;
    setToken("");

    const el = widgetContainerRef.current;

    try {
      const id = window.turnstile?.render(el, {
        sitekey: TURNSTILE_SITE_KEY,
        theme: "auto",
        size: "normal",
        callback: (t: string) => {
          setToken(String(t || ""));
          setError("");
          setFieldError("");
        },
        "expired-callback": () => {
          setToken("");
        },
        "timeout-callback": () => {
          setToken("");
        },
        "error-callback": () => {
          setToken("");
          setError("Turnstile verification failed. Please try again.");
        },
        "refresh-expired": "auto",
        "refresh-timeout": "auto",
      });

      if (typeof id === "string") {
        widgetIdRef.current = id;
      }
    } catch {
      setError("Turnstile failed to initialize. Please refresh and try again.");
    }

    return () => {
      try {
        if (widgetIdRef.current && window.turnstile?.remove) {
          window.turnstile.remove(widgetIdRef.current);
        }
      } catch {
        // ignore
      }
      widgetIdRef.current = null;
    };
  }, [turnstileReady]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    setFieldError("");
    setResult(null);

    const s = senderEmail.trim();
    const re = recipientEmail.trim();
    const rp = recipientPhone.trim();
    const m = message.trim();

    // Frontend validation (keep minimal)
    if (!isEmail(s)) {
      setSubmitting(false);
      setFieldError("senderEmail");
      setError("Please enter a valid sender email.");
      return;
    }
    if (!re && !rp) {
      setSubmitting(false);
      setFieldError("recipient");
      setError("Please enter a recipient email or phone number.");
      return;
    }
    if (re && !isEmail(re)) {
      setSubmitting(false);
      setFieldError("recipientEmail");
      setError("Please enter a valid recipient email.");
      return;
    }
    if (rp && !isE164Phone(rp)) {
      setSubmitting(false);
      setFieldError("recipientPhone");
      setError("Phone must be in E.164 format (e.g. +16043691517).");
      return;
    }
    if (cents < 1) {
      setSubmitting(false);
      setFieldError("amount");
      setError("Please enter a valid amount.");
      return;
    }
    if (!m) {
      setSubmitting(false);
      setFieldError("message");
      setError("Please write a short message.");
      return;
    }
    if (!token) {
      setSubmitting(false);
      setFieldError("turnstile");
      setError("Please complete the Turnstile check.");
      return;
    }

    try {
      const resp = await fetch(`${API_BASE}/api/gifts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          senderEmail: s,
          recipientEmail: re || undefined,
          recipientPhone: rp || undefined,
          message: m,
          amount: cents, // ✅ NUMBER (cents), not string
          turnstileToken: token,
        }),
      });

      let data: any = null;
      try {
        data = await resp.json();
      } catch {
        // ignore
      }

      if (!resp.ok || !data?.ok) {
        const err = parseApiError(data || { error: "Request failed" });
        setError(err.error || "Request failed");
        setFieldError(err.field || "");
        setSubmitting(false);

        // If Turnstile failed server-side, reset the widget so user can retry cleanly
        try {
          if (widgetIdRef.current && window.turnstile?.reset) {
            window.turnstile.reset(widgetIdRef.current);
          }
        } catch {
          // ignore
        }
        setToken("");
        return;
      }

      setResult(data as CreateGiftOk);
      setSubmitting(false);

      // Reset Turnstile after a successful submit (prevents token reuse)
      try {
        if (widgetIdRef.current && window.turnstile?.reset) {
          window.turnstile.reset(widgetIdRef.current);
        }
      } catch {
        // ignore
      }
      setToken("");
    } catch (err: any) {
      setError(err?.message || "Network error");
      setSubmitting(false);

      try {
        if (widgetIdRef.current && window.turnstile?.reset) {
          window.turnstile.reset(widgetIdRef.current);
        }
      } catch {
        // ignore
      }
      setToken("");
    }
  }

  return (
    <div className="w-full max-w-xl mx-auto">
      <form onSubmit={onSubmit} className="rounded-2xl border border-tm-cream/30 bg-white/70 backdrop-blur p-5 shadow-soft">
        <h2 className="font-outfit text-2xl text-tm-charcoal mb-1">Send a ThankuMail</h2>
        <p className="text-sm text-tm-charcoal/70 mb-5">Write something real. Add a small gift. Let it land.</p>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-tm-charcoal mb-1">Your email</label>
            <input
              value={senderEmail}
              onChange={(e) => setSenderEmail(e.target.value)}
              type="email"
              autoComplete="email"
              className={classNames(
                "w-full rounded-xl border px-3 py-2 outline-none bg-white",
                fieldError === "senderEmail" ? "border-red-400" : "border-tm-cream/60 focus:border-tm-honey"
              )}
              placeholder="you@example.com"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-tm-charcoal mb-1">Recipient email (optional)</label>
              <input
                value={recipientEmail}
                onChange={(e) => setRecipientEmail(e.target.value)}
                type="email"
                autoComplete="email"
                className={classNames(
                  "w-full rounded-xl border px-3 py-2 outline-none bg-white",
                  fieldError === "recipientEmail" ? "border-red-400" : "border-tm-cream/60 focus:border-tm-honey"
                )}
                placeholder="friend@example.com"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-tm-charcoal mb-1">Recipient phone (optional)</label>
              <input
                value={recipientPhone}
                onChange={(e) => setRecipientPhone(e.target.value)}
                type="tel"
                autoComplete="tel"
                className={classNames(
                  "w-full rounded-xl border px-3 py-2 outline-none bg-white",
                  fieldError === "recipientPhone" ? "border-red-400" : "border-tm-cream/60 focus:border-tm-honey"
                )}
                placeholder="+16043691517"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-tm-charcoal mb-1">Gift amount (USD)</label>
            <div className="flex items-center gap-3">
              <input
                value={amountDollars}
                onChange={(e) => setAmountDollars(e.target.value)}
                inputMode="decimal"
                className={classNames(
                  "w-36 rounded-xl border px-3 py-2 outline-none bg-white",
                  fieldError === "amount" ? "border-red-400" : "border-tm-cream/60 focus:border-tm-honey"
                )}
                placeholder="10"
              />
              <div className="text-sm text-tm-charcoal/70">
                Sending <span className="font-medium text-tm-charcoal">{cents}</span> cents
              </div>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-tm-charcoal mb-1">Message</label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={5}
              className={classNames(
                "w-full rounded-xl border px-3 py-2 outline-none bg-white resize-none",
                fieldError === "message" ? "border-red-400" : "border-tm-cream/60 focus:border-tm-honey"
              )}
              placeholder="Say what you really mean…"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-tm-charcoal mb-2">Human check</label>
            <div
              id="tm-turnstile"
              ref={widgetContainerRef}
              className={classNames(
                "min-h-[65px] rounded-xl border bg-white flex items-center justify-center overflow-hidden",
                fieldError === "turnstile" ? "border-red-400" : "border-tm-cream/60"
              )}
            />
            <div className="mt-2 text-xs text-tm-charcoal/60">
              Token:{" "}
              {token ? (
                <span className="font-mono break-all">{token.slice(0, 24)}… ({token.length})</span>
              ) : (
                <span className="font-mono">none</span>
              )}
            </div>
          </div>

          {error ? <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div> : null}

          {result?.ok ? (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm text-emerald-800">
              <div className="font-medium mb-1">Sent!</div>
              <div className="break-all">
                Claim link:{" "}
                <a className="underline" href={result.claimUrl} target="_blank" rel="noreferrer">
                  {result.claimUrl}
                </a>
              </div>
              {result.deliveryError ? <div className="mt-2 text-emerald-900/80">Delivery note: {result.deliveryError}</div> : null}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={!canSubmit}
            className={classNames(
              "w-full rounded-2xl px-4 py-3 font-medium transition shadow-soft",
              canSubmit ? "bg-tm-amber text-tm-charcoal hover:opacity-95" : "bg-tm-cream/60 text-tm-charcoal/50 cursor-not-allowed"
            )}
          >
            {submitting ? "Sending…" : "Send ThankuMail"}
          </button>

          <div className="text-xs text-tm-charcoal/60">Tip: You can provide either email or phone (or both).</div>
        </div>
      </form>
    </div>
  );
}
