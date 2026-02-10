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

const PRESET_MESSAGES: Array<{ id: string; text: string }> = [
  {
    id: "p1",
    text: "I just wanted you to know how much I appreciate you. Thank you for being you.",
  },
  {
    id: "p2",
    text: "Your support made a bigger difference than you realize. I’m truly grateful.",
  },
  {
    id: "p3",
    text: "You showed up when it mattered most. That means everything. Thank you.",
  },
  {
    id: "p4",
    text: "Your kindness hasn’t gone unnoticed — I’m sincerely thankful for you.",
  },
  {
    id: "p5",
    text: "This is a small thank you for the quiet impact you’ve had on my life.",
  },
];

function moneyToCents(dollars: number) {
  const cents = Math.round((Number(dollars) || 0) * 100);
  return Number.isFinite(cents) ? cents : 0;
}

function isEmail(s: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
}

function isE164Phone(s: string) {
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

function countTurnstileIframes() {
  const iframes = Array.from(document.querySelectorAll("iframe"));
  return iframes.filter((f) =>
    String((f as HTMLIFrameElement).src || "").includes(
      "challenges.cloudflare.com"
    )
  ).length;
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
  const [senderEmail, setSenderEmail] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("");
  const [amountDollars, setAmountDollars] = useState<string>("");

  const [message, setMessage] = useState<string>("");
  const [presetIdx, setPresetIdx] = useState<number>(0);
  const [messageTouched, setMessageTouched] = useState<boolean>(false);

  const [token, setToken] = useState<string>("");
  const [turnstileReady, setTurnstileReady] = useState<boolean>(false);
  const [turnstileBlocked, setTurnstileBlocked] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);

  const [error, setError] = useState<string>("");
  const [fieldError, setFieldError] = useState<string>("");
  const [result, setResult] = useState<CreateGiftOk | null>(null);

  const widgetIdRef = useRef<string | null>(null);
  const widgetContainerRef = useRef<HTMLDivElement | null>(null);
  const renderSeqRef = useRef<number>(0);
  const errorLockRef = useRef<"none" | "server" | "turnstile">("none");

  const TURNSTILE_SITE_KEY = (import.meta as any)?.env?.VITE_TURNSTILE_SITE_KEY
    ? String((import.meta as any).env.VITE_TURNSTILE_SITE_KEY)
    : "";

  const wordmark = useMemo(() => {
    const dia = "\u0308";
    return `thanku${dia}mail`;
  }, []);

  const cents = useMemo(() => {
    const raw = String(amountDollars || "").trim();
    const cleaned = raw.replace(/[^0-9.]/g, "");
    return moneyToCents(Number(cleaned));
  }, [amountDollars]);

  const canSubmit = useMemo(() => {
    const s = senderEmail.trim();
    const re = recipientEmail.trim();
    const rp = recipientPhone.trim();

    const hasEmail = Boolean(re);
    const hasPhone = Boolean(rp);

    const emailOk = hasEmail ? isEmail(re) : false;
    const phoneOk = hasPhone ? isE164Phone(rp) : false;

    const deliveryOk =
      (hasEmail && emailOk) || (!hasEmail && hasPhone && phoneOk);

    return (
      !submitting &&
      isEmail(s) &&
      deliveryOk &&
      cents >= 1 &&
      message.trim().length >= 1 &&
      token.length >= 20 &&
      TURNSTILE_SITE_KEY.length > 0
    );
  }, [
    submitting,
    senderEmail,
    recipientEmail,
    recipientPhone,
    cents,
    message,
    token,
    TURNSTILE_SITE_KEY,
  ]);

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
    setMessageTouched(false);
    setMessage(PRESET_MESSAGES[idx]?.text || "");
  }

  useEffect(() => {
    // Initialize message with first preset on first mount
    if (!messageTouched && !message.trim()) {
      selectPreset(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

    setTurnstileBlocked(false);
    setToken("");

    el.innerHTML = "";

    const seq = ++renderSeqRef.current;

    const start = Date.now();
    const poll = () => {
      if (seq !== renderSeqRef.current) return;
      const tmIframes = countTurnstileIframes();
      if (tmIframes > 0) {
        setTurnstileBlocked(false);
        return;
      }
      if (Date.now() - start >= 5200) {
        setTurnstileBlocked(true);
        return;
      }
      setTimeout(poll, 400);
    };

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
          if (errorLockRef.current !== "server")
            errorLockRef.current = "turnstile";
        },
        "timeout-callback": () => {
          setToken("");
          if (errorLockRef.current !== "server")
            errorLockRef.current = "turnstile";
        },
        "error-callback": () => {
          setToken("");
          if (errorLockRef.current === "server") return;
          setErrorWithLock("Verification failed. Please try again.", "turnstile");
        },
        "refresh-expired": "auto",
        "refresh-timeout": "auto",
      });

      if (typeof id === "string") widgetIdRef.current = id;

      setTimeout(poll, 250);
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
    const rpRaw = recipientPhone.trim();
    const m = message.trim();

    const hasEmail = Boolean(re);
    const hasPhone = Boolean(rpRaw);

    const emailOk = hasEmail ? isEmail(re) : false;
    const phoneOk = hasPhone ? isE164Phone(rpRaw) : false;

    const phoneToSend = phoneOk ? rpRaw : undefined;

    if (!isEmail(s)) {
      setSubmitting(false);
      setFieldError("senderEmail");
      setErrorWithLock("Please enter a valid sender email.", "none");
      return;
    }

    if (!hasEmail && !hasPhone) {
      setSubmitting(false);
      setFieldError("recipient");
      setErrorWithLock("Please enter a recipient email or phone number.", "none");
      return;
    }

    if (hasEmail && !emailOk) {
      setSubmitting(false);
      setFieldError("recipientEmail");
      setErrorWithLock("Please enter a valid recipient email.", "none");
      return;
    }

    if (!hasEmail && hasPhone && !phoneOk) {
      setSubmitting(false);
      setFieldError("recipientPhone");
      setErrorWithLock("Phone must be in E.164 format (e.g. +16043691517).", "none");
      return;
    }

    if (cents < 1) {
      setSubmitting(false);
      setFieldError("amount");
      setErrorWithLock("Please enter a valid amount.", "none");
      return;
    }

    if (!m) {
      setSubmitting(false);
      setFieldError("message");
      setErrorWithLock("Please write a short message.", "none");
      return;
    }

    if (!TURNSTILE_SITE_KEY) {
      setSubmitting(false);
      setFieldError("turnstile");
      setErrorWithLock(
        "Verification is not configured. Please contact support.",
        "turnstile"
      );
      return;
    }

    if (!token) {
      setSubmitting(false);
      setFieldError("turnstile");
      setErrorWithLock("Please complete the verification.", "turnstile");
      return;
    }

    try {
      const resp = await fetch(`${API_BASE}/api/gifts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          senderEmail: s,
          recipientEmail: emailOk ? re : undefined,
          recipientPhone: phoneToSend,
          message: m,
          amount: cents,
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
        const lock: "server" | "turnstile" = isTurnstileErrorCode(code)
          ? "turnstile"
          : "server";

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

      setSenderEmail("");
      setRecipientEmail("");
      setRecipientPhone("");
      setAmountDollars("");

      selectPreset(0);

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

  const showSoftTurnstileHint =
    turnstileReady && turnstileBlocked && !token && fieldError !== "turnstile";

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

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <input
                value={recipientEmail}
                onChange={(e) => setRecipientEmail(e.target.value)}
                type="email"
                autoComplete="email"
                aria-label="Receivers email"
                placeholder="Receivers email"
                className={classNames(
                  inputBase,
                  fieldError === "recipientEmail"
                    ? "border-red-400 focus:border-red-500 focus:ring-red-500/10"
                    : ""
                )}
              />
            </div>

            <div>
              <input
                value={recipientPhone}
                onChange={(e) => setRecipientPhone(e.target.value)}
                type="tel"
                autoComplete="tel"
                aria-label="Recipient phone"
                placeholder="Recipient phone (optional)"
                className={classNames(
                  inputBase,
                  fieldError === "recipientPhone"
                    ? "border-red-400 focus:border-red-500 focus:ring-red-500/10"
                    : ""
                )}
              />
              <div className="mt-1 text-[11px] text-slate-500">
                Format: <span className="font-mono">+12223334444</span>
              </div>
            </div>
          </div>

          <div>
            <div className="text-sm font-medium text-slate-900 mb-2">
              Gift Amount
            </div>
            <div className="flex items-center gap-3">
              <input
                value={amountDollars}
                onChange={(e) => setAmountDollars(e.target.value)}
                inputMode="decimal"
                aria-label="Gift amount"
                placeholder="$25 (USD)"
                className={classNames(
                  "w-44",
                  inputBase,
                  fieldError === "amount"
                    ? "border-red-400 focus:border-red-500 focus:ring-red-500/10"
                    : ""
                )}
              />
            </div>
          </div>

          {/* -------------------- PRESET CAROUSEL -------------------- */}
          <div>
            <div className="flex items-center justify-between gap-3 mb-2">
              <div className="text-sm font-medium text-slate-900">
                Choose a message
              </div>
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

              <button
                type="button"
                onClick={() => {
                  setMessageTouched(false);
                  setMessage(currentPreset?.text || "");
                }}
                className={classNames(
                  "flex-1 text-left rounded-xl border px-3 py-3 bg-white transition",
                  "border-slate-300 hover:bg-slate-50"
                )}
              >
                <div className="text-xs text-slate-500 mb-1">Preset</div>
                <div className="text-sm text-slate-900 leading-snug">
                  {currentPreset?.text}
                </div>
              </button>

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

            <div className="mt-2 text-[11px] text-slate-500">
              Tip: pick a preset, then tweak it below if you want.
            </div>
          </div>

          <div>
            <textarea
              value={message}
              onChange={(e) => {
                setMessageTouched(true);
                setMessage(e.target.value);
              }}
              rows={5}
              aria-label="Message"
              placeholder="Message"
              className={classNames(
                "w-full resize-none",
                inputBase,
                fieldError === "message"
                  ? "border-red-400 focus:border-red-500 focus:ring-red-500/10"
                  : ""
              )}
            />
          </div>

          <div>
            <div className="text-sm font-medium text-slate-900 mb-2">
              Human check
            </div>

            {showSoftTurnstileHint ? (
              <div className="mb-2 text-xs text-slate-500">
                If verification doesn’t appear, allow{" "}
                <span className="font-medium">challenges.cloudflare.com</span> or refresh.
              </div>
            ) : null}

            <div
              id="tm-turnstile"
              ref={widgetContainerRef}
              className={classNames(
                "min-h-[65px] rounded-xl border bg-white flex items-center justify-center overflow-hidden",
                fieldError === "turnstile"
                  ? "border-red-400"
                  : "border-slate-400/70"
              )}
            />

            <div className="mt-2 flex items-center justify-between gap-2 text-xs text-slate-500">
              <div>
                Token:{" "}
                {token ? (
                  <span className="font-mono break-all">
                    {token.slice(0, 24)}… ({token.length})
                  </span>
                ) : (
                  <span className="font-mono">none</span>
                )}
              </div>

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
                <a
                  className="underline"
                  href={result.claimUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {result.claimUrl}
                </a>
              </div>
              {result.deliveryError ? (
                <div className="mt-2 text-emerald-900/80">
                  Delivery note: {result.deliveryError}
                </div>
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
