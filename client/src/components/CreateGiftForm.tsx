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
const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

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
  const c = String(code || "").toUpperCase();
  return c === "TURNSTILE_FAILED";
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

export default function CreateGiftForm() {
  // Guest scope: email-only + preset-only + no amount
  const [recipientEmail, setRecipientEmail] = useState("");

  // Abuse-control: sender email used for rate limits; never shown to recipient
  const [senderEmail, setSenderEmail] = useState("");

  // Default to preset #2 (index 1)
  const [presetIdx, setPresetIdx] = useState<number>(1);

  const [token, setToken] = useState<string>("");
  const [turnstileReady, setTurnstileReady] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);

  const [error, setError] = useState<string>("");
  const [fieldError, setFieldError] = useState<string>("");
  const [result, setResult] = useState<CreateGiftOk | null>(null);

  const [lastSentRecipientEmail, setLastSentRecipientEmail] = useState<string>("");

  // Token UX for PowerShell
  const [copyStatus, setCopyStatus] = useState<string>("");
  const copyTimerRef = useRef<number | null>(null);

  const widgetIdRef = useRef<string | null>(null);
  const widgetContainerRef = useRef<HTMLDivElement | null>(null);
  const renderSeqRef = useRef<number>(0);
  const errorLockRef = useRef<"none" | "server" | "turnstile">("none");

  const TURNSTILE_SITE_KEY = useMemo(() => {
    const envKey = (import.meta as any)?.env?.VITE_TURNSTILE_SITE_KEY
      ? String((import.meta as any).env.VITE_TURNSTILE_SITE_KEY)
      : "";
    return (envKey || FALLBACK_TURNSTILE_SITE_KEY || "").trim();
  }, []);

  // BRAND: always use the real ü (U+00FC), never combining diaeresis
  const wordmark = "thankümail";

  const presetOk = useMemo(() => presetIdx >= 0 && presetIdx < PRESET_MESSAGES.length, [presetIdx]);

  const canSubmit = useMemo(() => {
    const re = recipientEmail.trim();
    const se = senderEmail.trim();
    return !submitting && isEmail(re) && isEmail(se) && presetOk && token.length >= 20 && TURNSTILE_SITE_KEY.length > 0;
  }, [submitting, recipientEmail, senderEmail, presetOk, token, TURNSTILE_SITE_KEY]);

  const showRetry =
    fieldError === "turnstile" ||
    errorLockRef.current === "turnstile" ||
    isTurnstileErrorCode(undefined) ||
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

  function setCopyToast(msg: string) {
    setCopyStatus(msg);
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopyStatus(""), 1800);
  }

  async function copyTokenToClipboard() {
    const t = String(token || "").trim();
    if (!t) return;

    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(t);
      } else {
        const ta = document.createElement("textarea");
        ta.value = t;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        ta.style.top = "-9999px";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopyToast("Token copied");
    } catch {
      setCopyToast("Copy failed");
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function ensureTurnstile() {
      if (!TURNSTILE_SITE_KEY) {
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
        setErrorWithLock("Verification is taking too long to initialize. Please refresh and try again.", "turnstile");
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
    if (!TURNSTILE_SITE_KEY) return;

    setToken("");
    el.innerHTML = "";

    const seq = ++renderSeqRef.current;

    try {
      const id = window.turnstile.render(el, {
        sitekey: TURNSTILE_SITE_KEY,
        theme: "auto",
        size: "normal",

        // IMPORTANT: this creates a hidden input with the token we can copy if needed
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
    if (!TURNSTILE_SITE_KEY) return;

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

    if (!TURNSTILE_SITE_KEY) {
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

  // EDIT: make placeholders visible on your tm palette (especially when inputs inherit dark backgrounds)
  const inputBase =
    "w-full rounded-xl border px-3 py-2 outline-none bg-tm-cream text-tm-charcoal " +
    "placeholder:text-tm-charcoal/60 placeholder:opacity-100 border-tm-charcoal/30 " +
    "focus:border-tm-charcoal focus:ring-2 focus:ring-tm-honey/30";

  const currentPreset = PRESET_MESSAGES[presetIdx] || PRESET_MESSAGES[1] || PRESET_MESSAGES[0];

  return (
    <div className="w-full max-w-xl mx-auto">
      <form onSubmit={onSubmit} className="rounded-2xl border border-tm-charcoal/20 bg-white p-5 shadow-soft text-tm-charcoal">
        <div className="space-y-4">
          {/* Header */}
          <div className="space-y-1">
            <div className="text-lg font-outfit font-semibold tracking-tight text-tm-charcoal">
              Send a <span className="font-quicksand font-semibold">{wordmark}</span>
            </div>
            <div className="text-xs text-tm-charcoal/60">Guest mode: preset message + email delivery. No account needed.</div>
          </div>

          {/* Sender email */}
          <div>
            <div className="mb-1 text-xs font-medium text-tm-charcoal/80">Sender email</div>
            <input
              value={senderEmail}
              onChange={(e) => setSenderEmail(e.target.value)}
              type="email"
              autoComplete="email"
              aria-label="Your email"
              placeholder="Your email (sender)"
              className={classNames(
                inputBase,
                fieldError === "senderEmail" ? "border-red-400 focus:border-red-500 focus:ring-red-500/10" : "",
              )}
            />
            <div className="mt-1 text-[11px] text-tm-charcoal/60">Used only for abuse protection. Not shared with the recipient.</div>
          </div>

          {/* Recipient email */}
          <div>
            <div className="mb-1 text-xs font-medium text-tm-charcoal/80">Recipient email</div>
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

          {/* Preset carousel */}
          <div>
            <div className="flex items-center justify-between gap-3 mb-2">
              <div className="text-sm font-medium text-tm-charcoal">Choose a message</div>
              <div className="text-xs text-tm-charcoal/60">
                {presetIdx + 1}/{PRESET_MESSAGES.length}
              </div>
            </div>

            <div className="flex items-stretch gap-2">
              <button
                type="button"
                aria-label="Previous message"
                onClick={() => selectPreset(presetIdx - 1)}
                className="shrink-0 w-10 rounded-xl border border-tm-charcoal/20 bg-tm-cream text-tm-charcoal hover:opacity-90 cursor-pointer"
              >
                ‹
              </button>

              <div className="flex-1 text-left rounded-xl border px-3 py-3 bg-tm-cream border-tm-charcoal/20">
                <div className="text-xs text-tm-charcoal/60 mb-1">Preset</div>
                <div className="text-sm text-tm-charcoal leading-snug">{currentPreset?.text}</div>
              </div>

              <button
                type="button"
                aria-label="Next message"
                onClick={() => selectPreset(presetIdx + 1)}
                className="shrink-0 w-10 rounded-xl border border-tm-charcoal/20 bg-tm-cream text-tm-charcoal hover:opacity-90 cursor-pointer"
              >
                ›
              </button>
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

          {/* Turnstile */}
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

            {/* PowerShell helper: copy a fresh token (must be used immediately + only once) */}
            <div className="mt-2 rounded-xl border border-tm-charcoal/10 bg-tm-cream/60 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] text-tm-charcoal/70">
                  PowerShell create helper (use token immediately; single-use)
                </div>
                <div className="flex items-center gap-2">
                  {copyStatus ? <div className="text-[11px] text-tm-charcoal/70">{copyStatus}</div> : null}
                  <button
                    type="button"
                    disabled={!token || token.length < 20}
                    onClick={copyTokenToClipboard}
                    className={classNames(
                      "rounded-lg border px-2 py-1 text-[11px] font-medium",
                      token && token.length >= 20
                        ? "border-tm-charcoal/20 bg-white text-tm-charcoal hover:opacity-90 cursor-pointer"
                        : "border-slate-200 bg-slate-100 text-slate-400 cursor-not-allowed",
                    )}
                  >
                    Copy token
                  </button>
                </div>
              </div>

              {/* Keep the token visible for manual copy/paste if needed */}
              <textarea
                readOnly
                value={token || ""}
                placeholder="Complete the Human check to generate a token…"
                className="mt-2 w-full h-[72px] resize-none rounded-lg border border-tm-charcoal/15 bg-white px-2 py-2 text-[11px] text-tm-charcoal/80 placeholder:text-tm-charcoal/40"
              />
            </div>
          </div>

          {error ? <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div> : null}

          {/* Success */}
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

              {result.deliveryError ? <div className="mt-2 text-emerald-900/80">Delivery note: {result.deliveryError}</div> : null}

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
                      if (widgetIdRef.current && window.turnstile?.reset) {
                        window.turnstile.reset(widgetIdRef.current);
                      }
                    } catch {}
                    setToken("");
                  }}
                  className="rounded-xl border border-emerald-300 bg-white px-3 py-2 text-xs font-medium text-emerald-900 hover:bg-emerald-50 cursor-pointer"
                >
                  Send another
                </button>
              </div>

              <div className="mt-2 text-[11px] text-emerald-900/70">We don’t show the claim link here to avoid confusion.</div>
            </div>
          ) : null}

          {/* Reassurance (ABOVE CTA) */}
          {!result?.ok ? (
            <div className="rounded-xl border border-tm-charcoal/10 bg-tm-cream/60 px-3 py-2 text-[12px] text-tm-charcoal/75">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="inline-flex items-center gap-1">
                  <span className="text-tm-forest">•</span> No account
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="text-tm-forest">•</span> Preset message only
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="text-tm-forest">•</span> Your email isn’t shown to them
                </span>
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

          <div className="text-[11px] text-tm-charcoal/60 text-center">Guest mode: preset messages only. No amount. No account.</div>
        </div>
      </form>
    </div>
  );
}
