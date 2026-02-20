// WHERE TO PASTE: client/src/components/CreateGiftForm.tsx
// ACTION: Full file replacement (paste exactly)

import React, { useEffect, useMemo, useRef, useState } from "react";
import confetti from "canvas-confetti";

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
  messageMode?: "preset" | "custom";
  presetMessageId?: number | null;
  amount?: number | null;
};

type CreateGiftResponse = CreateGiftOk | ApiError;

type AuthMeOk = {
  ok?: boolean;
  user?: {
    id?: string | number;
    email?: string;
    createdAt?: string;
    [k: string]: any;
  };
  [k: string]: any;
};

declare global {
  interface Window {
    __turnstileToken?: string;
    turnstileToken?: string;
    getTurnstileToken?: () => string;
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
        },
      ) => string;
      reset: (widgetId?: string) => void;
      remove: (widgetId?: string) => void;
      getResponse: (widgetId?: string) => string;
    };
  }
}

const API_BASE = "https://api.thankumail.com";
const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

// Cloudflare Turnstile "Always Pass" test sitekey (safe for client-side fallback)
const FALLBACK_TURNSTILE_SITE_KEY = "0x4AAAAAACXaTgda6akpnmmC";

const SESSION_KEY = "tm_session_token";

// IMPORTANT: backend expects presetMessageId in [1..7]
const PRESET_MESSAGES: Array<{ id: number; text: string }> = [
  { id: 1, text: "I just wanted you to know how much you are appreciated. Thank you for being you." },
  { id: 2, text: "Your support made a bigger difference than you realize. I’m truly grateful." },
  { id: 3, text: "You showed up when it mattered most. That means everything. Thank you." },
  { id: 4, text: "Your kindness hasn’t gone unnoticed — I’m sincerely thankful for you." },
  { id: 5, text: "You mattered more in that moment than you probably realized. Thank you." },
  { id: 6, text: "What you did made a positive difference for those around you. I’m grateful. Thank you." },
  { id: 7, text: "What you did stayed with me. This is my way of saying thank you." },
];

const AMOUNT_PRESETS: Array<{ label: string; cents: number }> = [
  { label: "$25", cents: 2500 },
  { label: "$50", cents: 5000 },
  { label: "$100", cents: 10000 },
  { label: "$250", cents: 25000 },
  { label: "$500", cents: 50000 },
  { label: "$1000", cents: 100000 },
];

function isEmail(s: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
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

function isTurnstileErrorCode(code?: string) {
  return String(code || "").toUpperCase() === "TURNSTILE_FAILED";
}

function fireConfettiBurst() {
  try {
    const defaults = { origin: { y: 0.75 } };
    confetti({ ...defaults, particleCount: 90, spread: 70, startVelocity: 45 });
    confetti({ ...defaults, particleCount: 45, spread: 120, startVelocity: 35 });
    confetti({ ...defaults, particleCount: 25, spread: 160, startVelocity: 25 });
  } catch {
    // ignore
  }
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

function centsToLabel(cents: number | null | undefined) {
  const c = Number(cents);
  if (!Number.isFinite(c) || c <= 0) return "";
  const dollars = (c / 100).toFixed(0);
  return `$${dollars}`;
}

function getSessionToken() {
  try {
    return String(localStorage.getItem(SESSION_KEY) || "").trim();
  } catch {
    return "";
  }
}

function removeSessionToken() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
}

export default function CreateGiftForm() {
  const [recipientEmail, setRecipientEmail] = useState("");
  const [senderEmail, setSenderEmail] = useState("");

  const [sessionToken, setSessionToken] = useState<string>(() => getSessionToken());

  const [authChecked, setAuthChecked] = useState<boolean>(false);
  const [authOk, setAuthOk] = useState<boolean>(false);
  const [authEmail, setAuthEmail] = useState<string>("");

  const isRegistered = authOk;

  const [messageMode, setMessageMode] = useState<"preset" | "custom">("preset");
  const [customMessage, setCustomMessage] = useState<string>("");

  // Amount preset (cents). Optional for registered.
  const [amountCents, setAmountCents] = useState<number | null>(null);

  const [presetIdx, setPresetIdx] = useState<number>(1);

  const [token, setToken] = useState<string>("");
  const [turnstileReady, setTurnstileReady] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);

  const [error, setError] = useState<string>("");
  const [fieldError, setFieldError] = useState<string>("");
  const [result, setResult] = useState<CreateGiftOk | null>(null);

  const [lastSentRecipientEmail, setLastSentRecipientEmail] = useState<string>("");

  const widgetIdRef = useRef<string | null>(null);
  const widgetContainerRef = useRef<HTMLDivElement | null>(null);
  const renderSeqRef = useRef<number>(0);
  const errorLockRef = useRef<"none" | "server" | "turnstile">("none");
  const authReqSeqRef = useRef<number>(0);

  const TURNSTILE_SITE_KEY = useMemo(() => getTurnstileSiteKey(), []);
  const wordmark = "thankümail";

  // Expose latest token for DevTools / auth flow testing
  useEffect(() => {
    window.getTurnstileToken = () => String(window.__turnstileToken || window.turnstileToken || "").trim();
    return () => {
      try {
        delete window.getTurnstileToken;
      } catch {}
    };
  }, []);

  // Cross-tab/session updates
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === SESSION_KEY) setSessionToken(getSessionToken());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Verify session token with /api/auth/me (do NOT assume token => registered)
  useEffect(() => {
    let cancelled = false;
    const seq = ++authReqSeqRef.current;

    async function checkMe() {
      const st = String(sessionToken || "").trim();
      setAuthChecked(false);
      setAuthOk(false);
      setAuthEmail("");

      if (!st) {
        setAuthChecked(true);
        return;
      }

      try {
        const resp = await fetch(`${API_BASE}/api/auth/me`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${st}`,
            "Content-Type": "application/json",
          },
        });

        let data: any = null;
        try {
          data = await resp.json();
        } catch {
          // ignore
        }

        if (cancelled || seq !== authReqSeqRef.current) return;

        if (resp.ok) {
          const me = (data || {}) as AuthMeOk;
          const email = String(me?.user?.email || "").trim();
          setAuthOk(true);
          setAuthEmail(email);
          setAuthChecked(true);
          return;
        }

        // Invalid/expired token: treat as guest and clear local token
        removeSessionToken();
        setSessionToken("");
        setAuthOk(false);
        setAuthEmail("");
        setAuthChecked(true);
      } catch {
        if (cancelled || seq !== authReqSeqRef.current) return;
        // Network issues: do NOT delete token; just treat as guest until recovery
        setAuthOk(false);
        setAuthEmail("");
        setAuthChecked(true);
      }
    }

    checkMe();

    return () => {
      cancelled = true;
    };
  }, [sessionToken]);

  // Keep UI aligned with locked scope:
  // Guests: preset-only, no amount
  // Registered: preset/custom, amount optional
  useEffect(() => {
    if (!isRegistered) {
      setMessageMode("preset");
      setCustomMessage("");
      setAmountCents(null);
    }
  }, [isRegistered]);

  const presetOk = useMemo(() => presetIdx >= 0 && presetIdx < PRESET_MESSAGES.length, [presetIdx]);

  const customOk = useMemo(() => {
    const msg = String(customMessage || "").trim();
    return msg.length > 0 && msg.length <= 280;
  }, [customMessage]);

  const amountOk = useMemo(() => {
    if (!isRegistered) return true;
    if (amountCents === null) return true; // optional
    return amountCents >= 2500 && amountCents <= 100000;
  }, [isRegistered, amountCents]);

  const canSubmit = useMemo(() => {
    const re = recipientEmail.trim();
    const se = senderEmail.trim();
    const msgOk = isRegistered ? (messageMode === "preset" ? presetOk : customOk) : presetOk;

    return (
      !submitting &&
      isEmail(re) &&
      isEmail(se) &&
      msgOk &&
      amountOk &&
      token.length >= 20 &&
      TURNSTILE_SITE_KEY.length > 0
    );
  }, [
    submitting,
    recipientEmail,
    senderEmail,
    isRegistered,
    messageMode,
    presetOk,
    customOk,
    amountOk,
    token,
    TURNSTILE_SITE_KEY,
  ]);

  const showRetry =
    fieldError === "turnstile" ||
    errorLockRef.current === "turnstile" ||
    /verification|captcha|turnstile/i.test(error);

  function setErrorWithLock(msg: string, lock: "none" | "server" | "turnstile") {
    errorLockRef.current = lock;
    setError(msg);
  }

  function clearErrorsAndUnlock() {
    errorLockRef.current = "none";
    setError("");
    setFieldError("");
  }

  function clampPresetIndex(i: number) {
    const n = PRESET_MESSAGES.length;
    if (n <= 0) return 0;
    return ((i % n) + n) % n;
  }

  function selectPreset(i: number) {
    const idx = clampPresetIndex(i);
    setPresetIdx(idx);
  }

  useEffect(() => {
    let cancelled = false;

    async function ensureTurnstile() {
      const keyNow = getTurnstileSiteKey();
      if (!keyNow) {
        setTurnstileReady(false);
        setErrorWithLock("Verification is not configured (missing site key).", "turnstile");
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
          setErrorWithLock("Verification failed to load. Please refresh and try again.", "turnstile");
        };

        document.head.appendChild(script);
      }

      const ok = await waitForTurnstile(8000);
      if (cancelled) return;

      setTurnstileReady(ok);
      if (!ok) {
        setErrorWithLock(
          "Verification is taking too long to initialize. Please refresh and try again.",
          "turnstile",
        );
      }
    }

    ensureTurnstile();

    return () => {
      cancelled = true;
    };
  }, [TURNSTILE_SITE_KEY]);

  function destroyWidget() {
    try {
      if (widgetIdRef.current && window.turnstile?.remove) {
        window.turnstile.remove(widgetIdRef.current);
      }
    } catch {
      // ignore
    }
    widgetIdRef.current = null;

    const el = widgetContainerRef.current;
    if (el) el.innerHTML = "";

    try {
      window.__turnstileToken = "";
      window.turnstileToken = "";
    } catch {}
  }

  function renderWidget() {
    const el = widgetContainerRef.current;
    if (!el) return;
    if (!window.turnstile?.render) return;

    const sitekey = getTurnstileSiteKey();
    if (!sitekey) {
      setTurnstileReady(false);
      setErrorWithLock("Verification is not configured (missing site key).", "turnstile");
      return;
    }

    setToken("");
    try {
      window.__turnstileToken = "";
      window.turnstileToken = "";
    } catch {}

    el.innerHTML = "";

    const seq = ++renderSeqRef.current;

    try {
      const id = window.turnstile.render(el, {
        sitekey,
        theme: "auto",
        size: "normal",
        "response-field": true,
        "response-field-name": "cf-turnstile-response",
        callback: (t: string) => {
          const tt = String(t || "");
          setToken(tt);
          try {
            window.__turnstileToken = tt;
            window.turnstileToken = tt;
          } catch {}

          if (errorLockRef.current !== "server") {
            errorLockRef.current = "none";
            setError("");
            setFieldError("");
          }
        },
        "expired-callback": () => {
          setToken("");
          try {
            window.__turnstileToken = "";
            window.turnstileToken = "";
          } catch {}
          if (errorLockRef.current !== "server") errorLockRef.current = "turnstile";
        },
        "timeout-callback": () => {
          setToken("");
          try {
            window.__turnstileToken = "";
            window.turnstileToken = "";
          } catch {}
          if (errorLockRef.current !== "server") errorLockRef.current = "turnstile";
        },
        "error-callback": () => {
          setToken("");
          try {
            window.__turnstileToken = "";
            window.turnstileToken = "";
          } catch {}
          if (errorLockRef.current === "server") return;
          setErrorWithLock("Verification failed. Please try again.", "turnstile");
        },
        "refresh-expired": "auto",
        "refresh-timeout": "auto",
      });

      if (seq === renderSeqRef.current && typeof id === "string") widgetIdRef.current = id;
    } catch {
      if (errorLockRef.current !== "server") {
        setErrorWithLock("Verification failed to initialize. Please refresh and try again.", "turnstile");
      }
    }
  }

  useEffect(() => {
    if (!turnstileReady) return;
    if (!widgetContainerRef.current) return;
    if (!window.turnstile?.render) return;

    const sitekey = getTurnstileSiteKey();
    if (!sitekey) return;

    destroyWidget();

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        renderWidget();
      });
    });

    return () => {
      destroyWidget();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnstileReady, TURNSTILE_SITE_KEY]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    errorLockRef.current = "none";
    setError("");
    setFieldError("");
    setResult(null);

    const re = recipientEmail.trim();
    const se = senderEmail.trim();

    if (!isEmail(re)) {
      setSubmitting(false);
      setFieldError("recipientEmail");
      setErrorWithLock("Please enter a valid recipient email.", "none");
      return;
    }

    if (!isEmail(se)) {
      setSubmitting(false);
      setFieldError("senderEmail");
      setErrorWithLock("Please enter a valid sender email.", "none");
      return;
    }

    if (isRegistered && messageMode === "custom") {
      const msg = String(customMessage || "").trim();
      if (!msg) {
        setSubmitting(false);
        setFieldError("message");
        setErrorWithLock("Please write a short message.", "none");
        return;
      }
      if (msg.length > 280) {
        setSubmitting(false);
        setFieldError("message");
        setErrorWithLock("Message must be 280 characters or less.", "none");
        return;
      }
    }

    if (isRegistered && amountCents !== null) {
      if (amountCents < 2500 || amountCents > 100000) {
        setSubmitting(false);
        setFieldError("amount");
        setErrorWithLock("Amount must be between $25 and $1000.", "none");
        return;
      }
    }

    const sitekey = getTurnstileSiteKey();
    if (!sitekey) {
      setSubmitting(false);
      setFieldError("turnstile");
      setErrorWithLock("Verification is not configured. Please contact support.", "turnstile");
      return;
    }

    if (!token) {
      setSubmitting(false);
      setFieldError("turnstile");
      setErrorWithLock("Please complete the verification.", "turnstile");
      return;
    }

    const presetMessageId = PRESET_MESSAGES[presetIdx]?.id ?? 2;

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const st = authOk ? getSessionToken() : "";
    if (st) headers["Authorization"] = `Bearer ${st}`;

    const payload: any = {
      senderEmail: se,
      recipientEmail: re,
      turnstileToken: token,
    };

    // Locked scope enforcement on client:
    // Guests: preset-only, no amount
    // Registered: preset/custom, fixed preset amounts (optional) 25..1000
    if (!st) {
      payload.messageMode = "preset";
      payload.presetMessageId = presetMessageId;
    } else {
      payload.messageMode = messageMode;

      if (messageMode === "preset") {
        payload.presetMessageId = presetMessageId;
      } else {
        payload.message = String(customMessage || "").trim();
      }

      if (amountCents !== null) payload.amountCents = amountCents;
    }

    try {
      const resp = await fetch(`${API_BASE}/api/gifts`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      let data: any = null;
      try {
        data = await resp.json();
      } catch {
        // ignore
      }

      if (!resp.ok || !data?.ok) {
        const err = parseApiError(data || { error: "Request failed" });
        const code = String(err.code || "");
        const lock: "server" | "turnstile" = isTurnstileErrorCode(code) ? "turnstile" : "server";

        // If auth token got rejected mid-flight, clear it and fall back to guest
        if (resp.status === 401 || resp.status === 403) {
          removeSessionToken();
          setSessionToken("");
        }

        setErrorWithLock(err.error || "Request failed", lock);
        setFieldError(err.field || "");
        setSubmitting(false);

        try {
          if (widgetIdRef.current && window.turnstile?.reset) {
            window.turnstile.reset(widgetIdRef.current);
          }
        } catch {
          // ignore
        }
        setToken("");
        try {
          window.__turnstileToken = "";
          window.turnstileToken = "";
        } catch {}
        return;
      }

      setLastSentRecipientEmail(re);
      setResult(data as CreateGiftOk);
      setSubmitting(false);
      errorLockRef.current = "none";

      fireConfettiBurst();

      setRecipientEmail("");
      setSenderEmail("");
      setPresetIdx(1);
      setCustomMessage("");
      setAmountCents(null);
      setMessageMode("preset");

      try {
        if (widgetIdRef.current && window.turnstile?.reset) {
          window.turnstile.reset(widgetIdRef.current);
        }
      } catch {
        // ignore
      }
      setToken("");
      try {
        window.__turnstileToken = "";
        window.turnstileToken = "";
      } catch {}
    } catch (err: any) {
      setErrorWithLock(err?.message || "Network error", "server");
      setSubmitting(false);

      try {
        if (widgetIdRef.current && window.turnstile?.reset) {
          window.turnstile.reset(widgetIdRef.current);
        }
      } catch {
        // ignore
      }
      setToken("");
      try {
        window.__turnstileToken = "";
        window.turnstileToken = "";
      } catch {}
    }
  }

  function signOut() {
    removeSessionToken();
    setSessionToken("");
    setAuthOk(false);
    setAuthEmail("");
    setMessageMode("preset");
    setCustomMessage("");
    setAmountCents(null);
  }

  const inputBase =
    "w-full rounded-xl border px-3 py-2 outline-none bg-tm-cream text-tm-charcoal " +
    "placeholder:text-tm-charcoal/60 placeholder:opacity-100 border-tm-charcoal/30 " +
    "focus:border-tm-charcoal focus:ring-2 focus:ring-tm-honey/30";

  const currentPreset = PRESET_MESSAGES[presetIdx] || PRESET_MESSAGES[1] || PRESET_MESSAGES[0];

  const chipBase = "px-3 py-1.5 rounded-full text-xs border transition cursor-pointer select-none";
  const chipOn = "border-tm-charcoal bg-tm-charcoal text-tm-cream shadow-soft ring-2 ring-tm-honey/40";
  const chipOff = "border-tm-charcoal/20 bg-tm-cream text-tm-charcoal hover:bg-white";

  const authLabel = !authChecked ? "Checking session…" : isRegistered ? "Registered mode" : "Guest mode";

  return (
    <div className="w-full max-w-xl mx-auto">
      <form
        onSubmit={onSubmit}
        className="rounded-2xl border border-tm-charcoal/20 bg-white p-5 shadow-soft text-tm-charcoal"
      >
        <div className="space-y-4">
          <div className="space-y-1">
            <div className="text-lg font-outfit font-semibold tracking-tight text-tm-charcoal">
              Send a <span className="font-quicksand font-semibold">{wordmark}</span>
            </div>
          </div>

          {/* AUTH STRIP */}
          <div className="rounded-2xl border border-tm-charcoal/15 bg-tm-cream px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-medium text-tm-charcoal">{authLabel}</div>

              {isRegistered ? (
                <button type="button" onClick={signOut} className={classNames(chipBase, chipOff)}>
                  Sign out
                </button>
              ) : (
                <a href="/login" className={classNames(chipBase, chipOn)}>
                  Sign in
                </a>
              )}
            </div>

            <div className="mt-2 text-xs text-tm-charcoal/70">
              {isRegistered ? (
                <>
                  Custom message + optional gift amounts are unlocked
                  {authEmail ? <span className="text-tm-charcoal/70"> • {authEmail}</span> : null}.
                </>
              ) : (
                "Guests can send preset messages only (no amount)."
              )}
            </div>
          </div>

          {/* EMAILS */}
          <div>
            <input
              value={senderEmail}
              onChange={(e) => setSenderEmail(e.target.value)}
              type="email"
              autoComplete="email"
              aria-label="Your email"
              placeholder="Sender email"
              className={classNames(
                inputBase,
                fieldError === "senderEmail" ? "border-red-400 focus:border-red-500 focus:ring-red-500/10" : "",
              )}
            />
          </div>

          <div>
            <input
              value={recipientEmail}
              onChange={(e) => setRecipientEmail(e.target.value)}
              type="email"
              autoComplete="email"
              aria-label="Recipient email"
              placeholder="Recipient email"
              className={classNames(
                inputBase,
                fieldError === "recipientEmail" ? "border-red-400 focus:border-red-500 focus:ring-red-500/10" : "",
              )}
            />
          </div>

          {/* MESSAGE MODE (registered only) */}
          {isRegistered ? (
            <div className="rounded-2xl border border-tm-charcoal/15 bg-white p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium text-tm-charcoal">Message</div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setMessageMode("preset")}
                    className={classNames(chipBase, messageMode === "preset" ? chipOn : chipOff)}
                  >
                    Preset
                  </button>
                  <button
                    type="button"
                    onClick={() => setMessageMode("custom")}
                    className={classNames(chipBase, messageMode === "custom" ? chipOn : chipOff)}
                  >
                    Custom
                  </button>
                </div>
              </div>

              {messageMode === "custom" ? (
                <div className="mt-3">
                  <textarea
                    value={customMessage}
                    onChange={(e) => setCustomMessage(e.target.value)}
                    rows={5}
                    aria-label="Custom message"
                    placeholder="Write a short message (max 280)"
                    className={classNames(
                      inputBase,
                      "resize-none py-2",
                      fieldError === "message" ? "border-red-400 focus:border-red-500 focus:ring-red-500/10" : "",
                    )}
                  />
                  <div className="mt-1 flex items-center justify-between text-[11px] text-tm-charcoal/60">
                    <span />
                    <span className={customMessage.trim().length > 280 ? "text-red-600" : ""}>
                      {customMessage.trim().length}/280
                    </span>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* PRESET SELECTOR (guest always + registered when preset) */}
          {!isRegistered || messageMode === "preset" ? (
            <div>
              <div className="flex items-center justify-between gap-3 mb-2">
                <div className="text-sm font-medium text-tm-charcoal">Choose a message</div>
                <div className="text-xs text-tm-charcoal/60">
                  {presetIdx + 1}/{PRESET_MESSAGES.length}
                </div>
              </div>

              <div className="text-left rounded-xl border px-3 py-3 bg-tm-cream border-tm-charcoal/20">
                <div className="text-sm text-tm-charcoal leading-snug">{currentPreset?.text}</div>
              </div>

              <div className="mt-2 flex flex-wrap gap-2">
                {PRESET_MESSAGES.map((p, i) => {
                  const active = i === presetIdx;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => selectPreset(i)}
                      className={active ? chipOn : chipOff}
                      style={{
                        padding: "0.25rem 0.75rem",
                        borderRadius: "9999px",
                        borderWidth: active ? 2 : 1,
                        fontSize: "0.75rem",
                        fontWeight: active ? 700 : 400,
                      }}
                      aria-label={`Select preset ${i + 1}`}
                    >
                      {i + 1}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {/* AMOUNT PRESETS (registered only; optional) */}
          {isRegistered ? (
            <div>
              <div className="flex items-center justify-between gap-3 mb-2">
                <div className="text-sm font-medium text-tm-charcoal">Gift amount (optional)</div>
                <div className="text-xs text-tm-charcoal/60">
                  {amountCents === null ? "none" : centsToLabel(amountCents)}
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setAmountCents(null)}
                  className={classNames(chipBase, amountCents === null ? chipOn : chipOff)}
                >
                  None
                </button>

                {AMOUNT_PRESETS.map((a) => {
                  const active = amountCents === a.cents;
                  return (
                    <button
                      key={a.cents}
                      type="button"
                      onClick={() => setAmountCents(a.cents)}
                      className={classNames(chipBase, active ? chipOn : chipOff)}
                    >
                      {a.label}
                    </button>
                  );
                })}
              </div>

              {fieldError === "amount" ? (
                <div className="mt-2 text-xs text-red-600">Choose one of: 25, 50, 100, 250, 500, 1000.</div>
              ) : null}
            </div>
          ) : null}

          <div>
            <div className="text-sm font-medium text-tm-charcoal mb-2">Human check</div>

            <div
              id="tm-turnstile"
              ref={widgetContainerRef}
              className={classNames(
                "min-h-[65px] rounded-xl border bg-tm-cream flex items-center justify-center overflow-hidden",
                fieldError === "turnstile" ? "border-red-400" : "border-tm-charcoal/30",
              )}
            />

            {showRetry ? (
              <div className="mt-2 flex items-center justify-end gap-2 text-xs text-tm-charcoal/60">
                <button
                  type="button"
                  onClick={() => {
                    clearErrorsAndUnlock();
                    destroyWidget();
                    requestAnimationFrame(() => {
                      requestAnimationFrame(() => {
                        renderWidget();
                      });
                    });
                  }}
                  className="rounded-lg border border-tm-charcoal/20 bg-tm-cream px-2 py-1 text-tm-charcoal hover:opacity-90 cursor-pointer"
                >
                  Retry
                </button>
              </div>
            ) : null}
          </div>

          {error ? (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          ) : null}

          {result?.ok ? (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm text-emerald-800">
              <div className="font-medium mb-1">Sent.</div>

              <div className="text-sm text-emerald-900/85">
                Your thankümail has been sent to{" "}
                <span className="font-medium">{lastSentRecipientEmail || "the recipient"}</span>.
              </div>

              <div className="mt-2 text-xs text-emerald-900/75">
                If they don’t see it within a minute, ask them to check Spam or Promotions.
              </div>

              {result.emailSent ? (
                <div className="mt-2 text-xs text-emerald-900/80">Email: sent ✓</div>
              ) : result.deliveryOk ? (
                <div className="mt-2 text-xs text-emerald-900/80">Delivery: queued ✓</div>
              ) : null}

              {result.deliveryError ? (
                <div className="mt-2 text-emerald-900/80">Delivery note: {result.deliveryError}</div>
              ) : null}

              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => {
                    setResult(null);
                    clearErrorsAndUnlock();
                    setRecipientEmail("");
                    setSenderEmail("");
                    setPresetIdx(1);
                    setCustomMessage("");
                    setAmountCents(null);
                    setLastSentRecipientEmail("");
                    try {
                      if (widgetIdRef.current && window.turnstile?.reset) window.turnstile.reset(widgetIdRef.current);
                    } catch {}
                    setToken("");
                    try {
                      window.__turnstileToken = "";
                      window.turnstileToken = "";
                    } catch {}
                  }}
                  className="rounded-xl border border-emerald-300 bg-white px-3 py-2 text-xs font-medium text-emerald-900 hover:bg-emerald-50 cursor-pointer"
                >
                  Send another
                </button>
              </div>
            </div>
          ) : null}

          <button
            type="submit"
            disabled={!canSubmit}
            className={classNames(
              "w-full rounded-2xl px-5 py-4 transition font-outfit text-lg tracking-tight border-2",
              canSubmit
                ? "bg-tm-amber text-tm-charcoal border-tm-charcoal/30 cursor-pointer shadow-soft hover:shadow-xl hover:opacity-95 hover:-translate-y-[1px] active:translate-y-0 active:opacity-90"
                : "bg-slate-200 text-slate-500 border-slate-300 cursor-not-allowed",
            )}
          >
            {submitting ? (
              "Sending…"
            ) : (
              <>
                Send <span className="font-quicksand font-semibold">{wordmark}</span>
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
