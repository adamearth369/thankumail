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
        },
      ) => string;
      reset: (widgetId?: string) => void;
      remove: (widgetId?: string) => void;
      getResponse: (widgetId?: string) => string;
    };
  }
}

const API_BASE = "https://api.thankumail.com";
const TURNSTILE_SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

// Cloudflare Turnstile "Always Pass" test sitekey (safe for client-side fallback)
const FALLBACK_TURNSTILE_SITE_KEY = "0x4AAAAAACXaTgda6akpnmmC";

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

export default function CreateGiftForm() {
  const [recipientEmail, setRecipientEmail] = useState("");
  const [senderEmail, setSenderEmail] = useState("");

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

  const TURNSTILE_SITE_KEY = useMemo(() => getTurnstileSiteKey(), []);

  const wordmark = "thankümail";

  const presetOk = useMemo(
    () => presetIdx >= 0 && presetIdx < PRESET_MESSAGES.length,
    [presetIdx],
  );

  const canSubmit = useMemo(() => {
    const re = recipientEmail.trim();
    const se = senderEmail.trim();
    return (
      !submitting &&
      isEmail(re) &&
      isEmail(se) &&
      presetOk &&
      token.length >= 20 &&
      TURNSTILE_SITE_KEY.length > 0
    );
  }, [submitting, recipientEmail, senderEmail, presetOk, token, TURNSTILE_SITE_KEY]);

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

      const existing = document.querySelector<HTMLScriptElement>(
        `script[src="${TURNSTILE_SCRIPT_SRC}"]`,
      );
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
          setToken(String(t || ""));
          if (errorLockRef.current !== "server") {
            errorLockRef.current = "none";
            setError("");
            setFieldError("");
          }
        },
        "expired-callback": () => {
          setToken("");
          if (errorLockRef.current !== "server") errorLockRef.current = "turnstile";
        },
        "timeout-callback": () => {
          setToken("");
          if (errorLockRef.current !== "server") errorLockRef.current = "turnstile";
        },
        "error-callback": () => {
          setToken("");
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

    try {
      const resp = await fetch(`${API_BASE}/api/gifts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          senderEmail: se,
          recipientEmail: re,
          messageMode: "preset",
          presetMessageId,
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
        const code = String(err.code || "");
        const lock: "server" | "turnstile" = isTurnstileErrorCode(code) ? "turnstile" : "server";

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

      try {
        if (widgetIdRef.current && window.turnstile?.reset) {
          window.turnstile.reset(widgetIdRef.current);
        }
      } catch {
        // ignore
      }
      setToken("");
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
    }
  }

  const inputBase =
    "w-full rounded-xl border px-3 py-2 outline-none bg-tm-cream text-tm-charcoal " +
    "placeholder:text-tm-charcoal/60 placeholder:opacity-100 border-tm-charcoal/30 " +
    "focus:border-tm-charcoal focus:ring-2 focus:ring-tm-honey/30";

  const currentPreset = PRESET_MESSAGES[presetIdx] || PRESET_MESSAGES[1] || PRESET_MESSAGES[0];

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

          <div>
            <div className="mb-1 text-xs font-medium text-tm-charcoal/80">Sender email</div>
            <input
              value={senderEmail}
              onChange={(e) => setSenderEmail(e.target.value)}
              type="email"
              autoComplete="email"
              aria-label="Your email"
              className={classNames(
                inputBase,
                fieldError === "senderEmail"
                  ? "border-red-400 focus:border-red-500 focus:ring-red-500/10"
                  : "",
              )}
            />
          </div>

          <div>
            <div className="mb-1 text-xs font-medium text-tm-charcoal/80">Recipient email</div>
            <input
              value={recipientEmail}
              onChange={(e) => setRecipientEmail(e.target.value)}
              type="email"
              autoComplete="email"
              aria-label="Recipient email"
              className={classNames(
                inputBase,
                fieldError === "recipientEmail"
                  ? "border-red-400 focus:border-red-500 focus:ring-red-500/10"
                  : "",
              )}
            />
          </div>

          <div>
            <div className="flex items-center justify-between gap-3 mb-2">
              <div className="text-sm font-medium text-tm-charcoal">Choose a message</div>
              <div className="text-xs text-tm-charcoal/60">
                {presetIdx + 1}/{PRESET_MESSAGES.length}
              </div>
            </div>

            <div className="text-left rounded-xl border px-3 py-3 bg-tm-cream border-tm-charcoal/20">
              <div className="text-xs text-tm-charcoal/60 mb-1">Preset</div>
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
                    className={classNames(
                      "px-2 py-1 rounded-full text-xs border transition cursor-pointer",
                      active
                        ? "border-tm-charcoal bg-tm-charcoal text-tm-cream"
                        : "border-tm-charcoal/20 bg-tm-cream text-tm-charcoal hover:opacity-90",
                    )}
                    aria-label={`Select preset ${i + 1}`}
                  >
                    {i + 1}
                  </button>
                );
              })}
            </div>
          </div>

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
            <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
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
                    setLastSentRecipientEmail("");
                    try {
                      if (widgetIdRef.current && window.turnstile?.reset) window.turnstile.reset(widgetIdRef.current);
                    } catch {}
                    setToken("");
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
