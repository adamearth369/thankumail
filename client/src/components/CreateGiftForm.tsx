import React, { useEffect, useMemo, useRef, useState } from "react";

type CreateGiftResponse =
  | {
      publicId: string;
      claimUrl: string;
      emailSent?: boolean;
    }
  | { error: string; issues?: any[]; field?: string; retryAfterSec?: number; code?: string; codes?: string[] };

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

export default function CreateGiftForm() {
  const [recipientEmail, setRecipientEmail] = useState("");
  const [message, setMessage] = useState("");
  const [amountDollars, setAmountDollars] = useState<number>(10);

  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string>("");
  const [result, setResult] = useState<{
    publicId: string;
    claimUrl: string;
    emailStatus: "sent" | "queued";
    recipient: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  // Non-KYC preset messages (must match server)
  const PRESET_MESSAGES = useMemo(
    () => [
      "Someone wanted you to know they’re genuinely grateful for you. Thank you.",
      "What you did made a real difference — you matter to someone. Thank you.",
      "This message is a simple expression of appreciation from someone who noticed. Thank you.",
      "Someone wanted to send you encouragement, because you deserve it. Thank you.",
      "You matter to people in a meaningful way. Your presence and actions had a positive impact. Thank you.",
      "Someone thought of you today and decided to send you a message of gratitude and kindness. Thank you.",
    ],
    [],
  );

  const [selectedPreset, setSelectedPreset] = useState<string>("");

  // Turnstile state
  const siteKey = (import.meta as any).env?.VITE_TURNSTILE_SITE_KEY || "";
  const [turnstileReady, setTurnstileReady] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string>("");
  const [turnstileError, setTurnstileError] = useState<string>("");

  const turnstileContainerRef = useRef<HTMLDivElement | null>(null);
  const turnstileWidgetIdRef = useRef<any>(null);

  const amountCents = useMemo(() => moneyToCents(amountDollars), [amountDollars]);

  const canSubmit = useMemo(() => {
    if (!isEmail(recipientEmail)) return false;
    if (!message.trim()) return false;
    if (!Number.isFinite(amountDollars)) return false;
    if (amountCents < 1000) return false;
    if (siteKey && !turnstileToken) return false;
    return true;
  }, [recipientEmail, message, amountDollars, amountCents, siteKey, turnstileToken]);

  // Keep message locked to preset (non-KYC mode)
  useEffect(() => {
    if (!selectedPreset) return;
    setMessage(selectedPreset);
  }, [selectedPreset]);

  // Initialize Turnstile widget (explicit render)
  useEffect(() => {
    let cancelled = false;

    async function init() {
      setTurnstileError("");
      setTurnstileReady(false);

      if (!siteKey) return;

      try {
        await loadTurnstileScript();
        if (cancelled) return;

        if (!window.turnstile) {
          setTurnstileError("CAPTCHA failed to load. Please refresh.");
          return;
        }

        setTurnstileReady(true);

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
      if (id && window.turnstile) window.turnstile.reset(id);
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
    if (!msg) return setErr("Please choose a message.");
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
        const zodIssue = Array.isArray((data as any)?.issues) && (data as any).issues?.[0]?.message;
        const field = (data as any)?.field;
        const apiErr = (data as any)?.error || zodIssue || "Something went wrong.";

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
        resetTurnstile();
        return;
      }

      const publicId = (data as any)?.publicId;
      const claimUrl = (data as any)?.claimUrl;

      if (publicId && claimUrl) {
        setResult({
          publicId,
          claimUrl: absoluteLink(claimUrl),
          recipient: email,
          emailStatus: (data as any)?.emailSent === false ? "queued" : "sent",
        });

        setRecipientEmail("");
        setSelectedPreset("");
        setMessage("");
        setAmountDollars(10);
        resetTurnstile();
        return;
      }

      setErr("Unexpected response from server.");
      resetTurnstile();
    } catch (e: any) {
      setErr(String(e?.message || e || "Network error"));
      resetTurnstile();
    } finally {
      setSubmitting(false);
    }
  }

  async function copyLink() {
    if (!result?.claimUrl) return;
    try {
      await navigator.clipboard.writeText(result.claimUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  }

  const moneyPresets = [
    { label: "$10", value: 10 },
    { label: "$25", value: 25 },
    { label: "$50", value: 50 },
    { label: "$100", value: 100 },
  ];

  return (
    <div className="rounded-3xl border border-violet-100 bg-white p-6 shadow-sm">
      <h2 className="text-xl font-bold tracking-tight">Create a ThanküMail</h2>

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <input
          value={recipientEmail}
          onChange={(e) => setRecipientEmail(e.target.value)}
          placeholder="Recipient email"
          className="w-full rounded-2xl border px-4 py-3"
        />

        <select
          value={selectedPreset}
          onChange={(e) => setSelectedPreset(e.target.value)}
          className="w-full rounded-2xl border px-4 py-3"
        >
          <option value="">Choose a message…</option>
          {PRESET_MESSAGES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>

        <div className="flex gap-2">
          {moneyPresets.map((p) => (
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

        {siteKey && !result ? (
          <div className="space-y-2">
            <div className="text-xs text-slate-500">
