import React, { useEffect, useMemo, useRef, useState } from "react";

type CreateGiftResponse =
  | {
      success: true;
      giftId: string;
      claimLink: string;
      claimUrl?: string;
      emailSent?: boolean;
      emailError?: string | null;
      email?: { ok: boolean };
    }
  | { error: string; issues?: any[]; field?: string; retryAfterSec?: number };

function moneyToCents(dollars: number) {
  const cents = Math.round(dollars * 100);
  return Number.isFinite(cents) ? cents : 0;
}

function isEmail(s: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function absoluteLink(maybeRelative: string) {
  if (!maybeRelative) return maybeRelative;
  if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const path = maybeRelative.startsWith("/") ? maybeRelative : `/${maybeRelative}`;
  return `${origin}${path}`;
}

/* -------------------- Turnstile helpers -------------------- */
declare global {
  interface Window {
    turnstile?: any;
  }
}

const TURNSTILE_SCRIPT_ID = "cf-turnstile-script";

function loadTurnstileScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") return resolve();
    if (window.turnstile) return resolve();

    const existing = document.getElementById(TURNSTILE_SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Failed to load Turnstile script")));
      return;
    }

    const s = document.createElement("script");
    s.id = TURNSTILE_SCRIPT_ID;
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load Turnstile script"));
    document.head.appendChild(s);
  });
}

export default function Home() {
  const [recipientEmail, setRecipientEmail] = useState("");
  const [message, setMessage] = useState("");
  const [amountDollars, setAmountDollars] = useState<number>(10);

  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string>("");
  const [result, setResult] = useState<{
    giftId: string;
    claimLink: string;
    emailStatus: "sent" | "queued";
    recipient: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  // Turnstile state
  const siteKey = (import.meta as any).env?.VITE_TURNSTILE_SITE_KEY || "";
  const [turnstileReady, setTurnstileReady] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string>("");
  const [turnstileError, setTurnstileError] = useState<string>("");

  const turnstileContainerRef = useRef<HTMLDivElement | null>(null);
  const turnstileWidgetIdRef = useRef<string | null>(null);

  const amountCents = useMemo(() => moneyToCents(amountDollars), [amountDollars]);

  const canSubmit = useMemo(() => {
    if (!isEmail(recipientEmail)) return false;
    if (!message.trim()) return false;
    if (!Number.isFinite(amountDollars)) return false;
    if (amountCents < 1000) return false;

    // If a site key is present, require a token before enabling submit.
    // (When TURNSTILE_ENFORCE is flipped on server, this prevents confusing 400s.)
    if (siteKey && !turnstileToken) return false;

    return true;
  }, [recipientEmail, message, amountDollars, amountCents, siteKey, turnstileToken]);

  // Initialize Turnstile widget (explicit render)
  useEffect(() => {
    let cancelled = false;

    async function init() {
      setTurnstileError("");
      setTurnstileReady(false);

      if (!siteKey) {
        // No site key configured: run without widget (safe rollout / dev)
        return;
      }

      try {
        await loadTurnstileScript();
        if (cancelled) return;

        if (!window.turnstile) {
          setTurnstileError("CAPTCHA failed to load. Please refresh.");
          return;
        }

        setTurnstileReady(true);

        // Render widget if not rendered yet
        if (turnstileContainerRef.current && !turnstileWidgetIdRef.current) {
          const widgetId = window.turnstile.render(turnstileContainerRef.current, {
            sitekey: siteKey,
            theme: "light",
            callback: (token: string) => {
              setTurnstileToken(token || "");
              setTurnstileError("");
            },
            "expired-callback": () => {
              setTurnstileToken("");
              setTurnstileError("CAPTCHA expired. Please try again.");
            },
            "error-callback": () => {
              setTurnstileToken("");
              setTurnstileError("CAPTCHA error. Please refresh and try again.");
            },
          });

          turnstileWidgetIdRef.current = widgetId;
        }
      } catch (e: any) {
        setTurnstileError(String(e?.message || e || "CAPTCHA failed to load."));
      }
    }

    init();

    return () => {
      cancelled = true;
    };
  }, [siteKey]);

  function resetTurnstile() {
    if (!siteKey) return;
    try {
      const id = turnstileWidgetIdRef.current;
      if (id && window.turnstile) {
        window.turnstile.reset(id);
      }
    } catch {}
    setTurnstileToken("");
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setTurnstileError("");
    setResult(null);
    setCopied(false);

    const email = recipientEmail.trim();
    const msg = message.trim();

    if (!isEmail(email)) return setErr("Please enter a valid email.");
    if (!msg) return setErr("Please write a message.");
    if (amountCents < 1000) return setErr("Minimum amount is $10.");

    if (siteKey && !turnstileToken) {
      return setTurnstileError("Please complete the CAPTCHA.");
    }

    setSubmitting(true);
    try {
      const r = await fetch("/api/gifts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipientEmail: email,
          message: msg,
          amount: amountCents,
          ...(turnstileToken ? { turnstileToken } : {}),
        }),
      });

      const data = (await r.json().catch(() => ({}))) as CreateGiftResponse;

      if (!r.ok) {
        const zodIssue = Array.isArray((data as any)?.issues) && (data as any).issues?.[0]?.message;

        const field = (data as any)?.field;
        const apiErr = (data as any)?.error || zodIssue || "Something went wrong.";

        // If server says captcha missing/failed, show it under the widget and reset.
        const captchaish =
          field === "turnstileToken" ||
          /captcha/i.test(apiErr) ||
          /turnstile/i.test(apiErr) ||
          /verification failed/i.test(apiErr);

        if (captchaish) {
          setTurnstileError(apiErr);
          resetTurnstile();
          return;
        }

        setErr(apiErr);
        // Some errors should also refresh token (safer)
        resetTurnstile();
        return;
      }

      if ((data as any)?.success) {
        const claimLink = absoluteLink((data as any).claimUrl || (data as any).claimLink);

        setResult({
          giftId: (data as any).giftId,
          claimLink,
          recipient: email,
          emailStatus: (data as any)?.emailSent === false || (data as any)?.email?.ok === false ? "queued" : "sent",
        });

        // Reset token after a successful create (one-time use)
        resetTurnstile();
        setRecipientEmail("");
        setMessage("");
        setAmountDollars(10);
        return;
      }

      setErr("Unexpected response.");
      resetTurnstile();
    } catch (e: any) {
      setErr(String(e?.message || e || "Network error"));
      resetTurnstile();
    } finally {
      setSubmitting(false);
    }
  }

  async function copyLink() {
    if (!result?.claimLink) return;
    try {
      await navigator.clipboard.writeText(result.claimLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  }

  const presets = [
    { label: "$10", value: 10 },
    { label: "$25", value: 25 },
    { label: "$50", value: 50 },
    { label: "$100", value: 100 },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-b from-white via-white to-violet-50 text-slate-900">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-2xl bg-violet-600 shadow-sm" />
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight">ThanküMail</div>
            <div className="text-xs text-slate-500">Send a gift with a real message.</div>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl grid-cols-1 gap-10 px-6 pb-20 pt-6 lg:grid-cols-2">
        <section>
          <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">
            A small gift.
            <span className="block text-violet-700">A message they’ll remember.</span>
          </h1>
          <p className="mt-4 max-w-xl text-base leading-relaxed text-slate-600">
            Your words arrive first. The gift follows when they’re ready.
          </p>
        </section>

        <section>
          <div className="rounded-3xl border border-violet-100 bg-white p-6 shadow-sm">
            <h2 className="text-xl font-bold tracking-tight">Create a ThanküMail</h2>

            <form onSubmit={onSubmit} className="mt-6 space-y-4">
              <input
                value={recipientEmail}
                onChange={(e) => setRecipientEmail(e.target.value)}
                placeholder="Recipient email"
                className="w-full rounded-2xl border px-4 py-3"
              />

              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Write something real…"
                className="h-28 w-full rounded-2xl border px-4 py-3"
                maxLength={1000}
              />

              <div className="flex gap-2">
                {presets.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => setAmountDollars(p.value)}
                    className={`rounded-xl px-4 py-2 text-sm ${
                      amountDollars === p.value ? "bg-violet-600 text-white" : "border bg-white"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              {/* Turnstile widget (shows only when VITE_TURNSTILE_SITE_KEY is set) */}
              {siteKey ? (
                <div className="space-y-2">
                  <div className="text-xs text-slate-500">
                    {turnstileReady ? "Complete the CAPTCHA to create a gift." : "Loading CAPTCHA…"}
                  </div>
                  <div
                    ref={turnstileContainerRef}
                    className="min-h-[70px] rounded-2xl border bg-white px-4 py-4"
                  />
                  {turnstileError ? (
                    <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                      {turnstileError}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {err && (
                <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                  {err}
                </div>
              )}

              {result && (
                <div className="rounded-2xl border border-violet-200 bg-violet-50 px-4 py-4 text-sm">
                  <div className="font-semibold text-slate-900">Gift created</div>
                  <div className="mt-1 text-slate-700">
                    Email {result.emailStatus === "sent" ? "sent to" : "queued for"}{" "}
                    <span className="font-semibold">{result.recipient}</span>
                  </div>

                  <div className="mt-3 flex gap-2">
                    <input readOnly value={result.claimLink} className="flex-1 rounded-xl border bg-white px-3 py-2 text-xs" />
                    <button
                      type="button"
                      onClick={copyLink}
                      className="rounded-xl bg-violet-600 px-4 py-2 text-xs text-white"
                    >
                      {copied ? "Copied" : "Copy"}
                    </button>
                  </div>
                </div>
              )}

              <button
                type="submit"
                disabled={!canSubmit || submitting}
                className="w-full rounded-2xl bg-violet-600 px-4 py-3 text-white disabled:bg-slate-300"
              >
                {submitting ? "Creating…" : siteKey && !turnstileToken ? "Complete CAPTCHA" : "Create gift"}
              </button>

              {siteKey ? (
                <div className="text-[11px] leading-relaxed text-slate-500">
                  Protected by Cloudflare Turnstile. If it doesn’t load, disable aggressive ad blockers or refresh.
                </div>
              ) : null}
            </form>
          </div>
        </section>
      </main>
    </div>
  );
}
