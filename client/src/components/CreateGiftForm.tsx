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
          "refresh-expired"?: "auto" | "manual";
          "refresh-timeout"?: "auto" | "manual";
          size?: "normal" | "compact";
          [k: string]: any;
        }
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

const FALLBACK_TURNSTILE_SITE_KEY = "0x4AAAAAACXaTgda6akpnmmC";

// IMPORTANT: backend expects presetMessageId in [1..5] (not p1..p5)
const PRESET_MESSAGES: Array<{ id: number; text: string }> = [
  {
    id: 1,
    text: "I just wanted you to know how much I appreciate you. Thank you for being you.",
  },
  {
    id: 2,
    text: "Your support made a bigger difference than you realize. I’m truly grateful.",
  },
  {
    id: 3,
    text: "You showed up when it mattered most. That means everything. Thank you.",
  },
  {
    id: 4,
    text: "Your kindness hasn’t gone unnoticed — I’m sincerely thankful for you.",
  },
  {
    id: 5,
    text: "This is a small thank you for the quiet impact you’ve had on my life.",
  },
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
      if (window.turnstile && typeof window.turnstile.render === "function")
        return resolve(true);
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
  const [senderEmail, setSenderEmail] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");

  const [presetIdx, setPresetIdx] = useState<number>(0);

  const [token, setToken] = useState<string>("");
  const [turnstileReady, setTurnstileReady] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);

  const [error, setError] = useState<string>("");
  const [fieldError, setFieldError] = useState<string>("");
  const [result, setResult] = useState<CreateGiftOk | null>(null);

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

  const wordmark = useMemo(() => {
    const dia = "\u0308";
    return `thanku${dia}mail`;
  }, []);

  const canSubmit = useMemo(() => {
    const s = senderEmail.trim();
    const re = recipientEmail.trim();
    const presetOk = presetIdx >= 0 && presetIdx < PRESET_MESSAGES.length;

    return (
      !submitting &&
      isEmail(s) &&
      isEmail(re) &&
      presetOk &&
      token.length >= 20 &&
      TURNSTILE_SITE_KEY.length > 0
    );
  }, [submitting, senderEmail, recipientEmail, presetIdx, token, TURNSTILE_SITE_KEY]);

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
      if (!TURNSTILE_SITE_KEY) {
        setTurnstileReady(false);
        setErrorWithLock(
          "Verification is not configured (missing site key).",
          "turnstile"
        );
        return;
      }

      const existing = document.querySelector<HTMLScriptElement>(
        `script[src="${TURNSTILE_SCRIPT_SRC}"]`
      );
      if (!existing) {
        const script = document.createElement("script");
        script.src = TURNSTILE_SCRIPT_SRC;
        script.async = true;
        script.defer = true;

        script.onerror = () => {
          if (cancelled) return;
          setTurnstileReady(false);
          setErrorWithLock(
            "Verification failed to load. Please refresh and try again.",
            "turnstile"
          );
        };

        document.head.appendChild(script);
      }

      const ok = await waitForTurnstile(8000);
      if (cancelled) return;

      setTurnstileReady(ok);
      if (!ok) {
        setErrorWithLock(
          "Verification is taking too long to initialize. Please refresh and try again.",
          "turnstile"
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
    if (!TURNSTILE_SITE_KEY) return;

    setToken("");
    el.innerHTML = "";

    const seq = ++renderSeqRef.current;

    try {
      const id = window.turnstile.render(el, {
        sitekey: TURNSTILE_SITE_KEY,
        theme: "auto",
        size: "normal",
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
        setErrorWithLock(
          "Verification failed to initialize. Please refresh and try again.",
          "turnstile"
        );
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

    const s = senderEmail.trim();
    const re = recipientEmail.trim();

    if (!isEmail(s)) {
      setSubmitting(false);
      setFieldError("senderEmail");
      setErrorWithLock("Please enter a valid sender email.", "none");
      return;
    }

    if (!isEmail(re)) {
      setSubmitting(false);
      setFieldError("recipientEmail");
      setErrorWithLock("Please enter a valid recipient email.", "none");
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

    const presetMessageId = PRESET_MESSAGES[presetIdx]?.id ?? 1;

    try {
      const resp = await fetch(`${API_BASE}/api/gifts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          senderEmail: s,
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

      setResult(data as CreateGiftOk);
      setSubmitting(false);
      errorLockRef.current = "none";

      fireConfettiBurst();

      setRecipientEmail("");
      setPresetIdx(0);

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
    "w-full rounded-xl border px-3 py-2 outline-none bg-white text-slate-900 placeholder:text-slate-400 border-slate-400/70 focus:border-slate-900 focus:ring-2 focus:ring-slate-900/10";

  const currentPreset = PRESET_MESSAGES[presetIdx] || PRESET_MESSAGES[0];

  return (
    <div className="w-full max-w-xl mx-auto">
      <form
        onSubmit={onSubmit}
        className="rounded-2xl border border-slate-300 bg-white p-5 shadow-soft text-slate-900"
      >
        <div className="space-y-4">
          <div>
            <input
              value={senderEmail}
              onChange={(e) => setSenderEmail(e.target.value)}
              type="email"
              autoComplete="email"
              aria-label="Your email"
              placeholder="Your email"
              className={classNames(
                inputBase,
                fieldError === "senderEmail"
                  ? "border-red-400 focus:border-red-500 focus:ring-red-500/10"
                  : ""
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
                fieldError === "recipientEmail"
                  ? "border-red-400 focus:border-red-500 focus:ring-red-500/10"
                  : ""
              )}
            />
          </div>

          {/* -------------------- PRESET CAROUSEL (LOCKED) -------------------- */}
          <div>
            <div className="flex items-center justify-between gap-3 mb-2">
              <div className="text-sm font-medium text-slate-900">Choose a message</div>
              <div className="text-xs text-slate-500">
                {presetIdx + 1}/{PRESET_MESSAGES.length}
              </div>
            </div>

            <div className="flex items-stretch gap-2">
              <button
                type="button"
                aria-label="Previous message"
                onClick={() => selectPreset(presetIdx - 1)}
                className="shrink-0 w-10 rounded-xl border border-slate-300 bg-white text-slate-900 hover:bg-slate-50"
              >
                ‹
              </button>

              <div className="flex-1 text-left rounded-xl border px-3 py-3 bg-white border-slate-300">
                <div className="text-xs text-slate-500 mb-1">Preset</div>
                <div className="text-sm text-slate-900 leading-snug">{currentPreset?.text}</div>
              </div>

              <button
                type="button"
                aria-label="Next message"
                onClick={() => selectPreset(presetIdx + 1)}
                className="shrink-0 w-10 rounded-xl border border-slate-300 bg-white text-slate-900 hover:bg-slate-50"
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
                      "px-2 py-1 rounded-full text-xs border transition",
                      active
                        ? "border-slate-900 bg-slate-900 text-white"
                        : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
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
            <div className="text-sm font-medium text-slate-900 mb-2">Human check</div>

            <div
              id="tm-turnstile"
              ref={widgetContainerRef}
              className={classNames(
                "min-h-[65px] rounded-xl border bg-white flex items-center justify-center overflow-hidden",
                fieldError === "turnstile" ? "border-red-400" : "border-slate-400/70"
              )}
            />

            <div className="mt-2 flex items-center justify-end gap-2 text-xs text-slate-500">
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
                className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-slate-900 hover:opacity-90"
              >
                Retry
              </button>
            </div>
          </div>

          {error ? (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          ) : null}

          {result?.ok ? (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm text-emerald-800">
              <div className="font-medium mb-1">Sent!</div>
              <div className="break-all">
                Claim link:{" "}
                <a className="underline" href={result.claimUrl} target="_blank" rel="noreferrer">
                  {result.claimUrl}
                </a>
              </div>
              {result.deliveryError ? (
                <div className="mt-2 text-emerald-900/80">Delivery note: {result.deliveryError}</div>
              ) : null}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={!canSubmit}
            className={classNames(
              "w-full rounded-2xl px-4 py-3 transition shadow-soft",
              "font-quicksand font-semibold tracking-tight",
              canSubmit
                ? "bg-tm-amber text-tm-charcoal hover:opacity-95"
                : "bg-slate-200 text-slate-500 cursor-not-allowed"
            )}
          >
            {submitting ? "Sending…" : `Send ${wordmark}`}
          </button>
        </div>
      </form>
    </div>
  );
}
