import React, { useEffect, useMemo, useRef, useState } from "react";

type CreateGiftResponse =
  | { publicId: string }
  | { error: string; issues?: any[]; field?: string; retryAfterSec?: number };

function moneyToCents(dollars: number) {
  const cents = Math.round(dollars * 100);
  return Number.isFinite(cents) ? cents : 0;
}

function isEmail(s: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
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
    recipient: string;
  } | null>(null);

  // Turnstile
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
    if (amountCents < 1000) return false;
    if (siteKey && !turnstileToken) return false;
    return true;
  }, [recipientEmail, message, amountCents, siteKey, turnstileToken]);

  useEffect(() => {
    if (!siteKey) return;

    let cancelled = false;

    async function init() {
      try {
        await loadTurnstileScript();
        if (cancelled || !window.turnstile || !turnstileContainerRef.current) return;

        setTurnstileReady(true);

        if (!turnstileWidgetIdRef.current) {
          turnstileWidgetIdRef.current = window.turnstile.render(turnstileContainerRef.current, {
            sitekey: siteKey,
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
              setTurnstileError("CAPTCHA error. Please refresh.");
            },
          });
        }
      } catch {
        setTurnstileError("CAPTCHA failed to load. Please refresh.");
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
      if (id && window.turnstile) window.turnstile.reset(id);
    } catch {}
    setTurnstileToken("");
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;

    setErr("");
    setTurnstileError("");

    const email = recipientEmail.trim();
    const msg = message.trim();

    if (!isEmail(email)) return setErr("Please enter a valid email.");
    if (!msg) return setErr("Please write a message.");
    if (amountCents < 1000) return setErr("Minimum amount is $10.");
    if (siteKey && !turnstileToken) return setTurnstileError("Please complete the CAPTCHA.");

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
        const apiErr = (data as any)?.error || "Something went wrong.";
        if ((data as any)?.field === "turnstileToken") {
          setTurnstileError(apiErr);
          resetTurnstile();
          return;
        }
        setErr(apiErr);
        resetTurnstile();
        return;
      }

      if ((data as any)?.publicId) {
        setResult({ recipient: email });
        setRecipientEmail("");
        setMessage("");
        setAmountDollars(10);
        resetTurnstile();
        return;
      }

      setErr("Unexpected response.");
    } catch (e: any) {
      setErr(String(e?.message || "Network error"));
    } finally {
      setSubmitting(false);
    }
  }

  const presets = [
    { label: "$10", value: 10 },
    { label: "$25", value: 25 },
    { label: "$50", value: 50 },
    { label: "$100", value: 100 },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-b from-white via-white to-violet-50 text-slate-900">
      <main className="mx-auto max-w-xl px-6 pb-20 pt-10">
        <h1 className="text-4xl font-extrabold tracking-tight">
          A small gift.
          <span className="block text-violet-700">A message they’ll remember.</span>
        </h1>

        {!result && (
          <form onSubmit={onSubmit} className="mt-8 space-y-4 rounded-3xl border bg-white p-6 shadow-sm">
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

            {siteKey && (
              <div className="space-y-2">
                <div ref={turnstileContainerRef} className="min-h-[70px] rounded-2xl border bg-white px-4 py-4" />
                {turnstileError && (
                  <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                    {turnstileError}
                  </div>
                )}
              </div>
            )}

            {err && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                {err}
              </div>
            )}

            <button
              type="submit"
              disabled={!canSubmit || submitting}
              className="w-full rounded-2xl bg-violet-600 px-4 py-3 text-white disabled:bg-slate-300"
            >
              {submitting ? "Creating…" : siteKey && !turnstileToken ? "Complete CAPTCHA" : "Create gift"}
            </button>

            {siteKey && (
              <div className="text-[11px] text-slate-500">
                Protected by Cloudflare Turnstile.
              </div>
            )}
          </form>
        )}

        {result && (
          <div className="mt-8 rounded-3xl border border-violet-200 bg-violet-50 p-6 text-sm">
            <div className="text-lg font-semibold">Your ThanküMail has been delivered.</div>
            <div className="mt-2 text-slate-700">
              Email sent to <span className="font-semibold">{result.recipient}</span>
            </div>
            <div className="mt-3 text-slate-600">
              If they don’t receive it within 48 hours, a reminder email will be sent.
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
