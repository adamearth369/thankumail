// client/src/components/CreateGiftForm.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";

type CreateGiftResponse =
  | {
      publicId: string;
      claimUrl: string;
      emailSent?: boolean;
    }
  | {
      error: string;
      issues?: any[];
      field?: string;
      retryAfterSec?: number;
      code?: string;
      codes?: string[];
    };

function moneyToCents(dollars: number) {
  const cents = Math.round(dollars * 100);
  return Number.isFinite(cents) ? cents : 0;
}

function isEmail(s: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((s || "").trim());
}

function isE164(s: string) {
  return /^\+[1-9]\d{7,14}$/.test((s || "").trim());
}

function absoluteLink(maybeRelative: string) {
  if (!maybeRelative) return maybeRelative;
  if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const path = maybeRelative.startsWith("/") ? maybeRelative : `/${maybeRelative}`;
  return `${origin}${path}`;
}

function safeText(v: any) {
  return typeof v === "string" ? v : "";
}

function buildClaimUrlFromPublicId(publicId: string) {
  const pid = safeText(publicId).trim();
  if (!pid) return "";
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/claim/${encodeURIComponent(pid)}`;
}

function saveLastPublicId(publicId: string) {
  try {
    if (!publicId) return;
    localStorage.setItem("tm_last_publicId", publicId);
    localStorage.setItem("tm_last_savedAt", new Date().toISOString());
  } catch {
    // ignore
  }
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

/* -------------------- API helper -------------------- */
/**
 * Try root first (/gifts), then fallback to /api (/api/gifts) if root 404s.
 * Returns { res, usedUrl } so you can see which endpoint was actually hit.
 */
async function postJsonWithApiFallback(pathNoApi: string, body: any): Promise<{ res: Response; usedUrl: string }> {
  const rootUrl = pathNoApi.startsWith("/") ? pathNoApi : `/${pathNoApi}`;
  const apiUrl = `/api${rootUrl}`;

  const doPost = async (url: string) => {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  };

  const r1 = await doPost(rootUrl);
  if (r1.status !== 404) return { res: r1, usedUrl: rootUrl };

  const r2 = await doPost(apiUrl);
  return { res: r2, usedUrl: apiUrl };
}

export default function CreateGiftForm() {
  const [senderEmail, setSenderEmail] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("");
  const [message, setMessage] = useState("");
  const [amountDollars, setAmountDollars] = useState<number>(10);

  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string>("");
  const [result, setResult] = useState<{
    publicId: string;
    claimUrl: string;
    deliveryLabel: string;
    recipientLabel: string;
    sender: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  // Debug panel (helps you find payload + token)
  const [debugOpen, setDebugOpen] = useState(false);
  const [lastReq, setLastReq] = useState<{ url: string; body: any } | null>(null);
  const [lastRes, setLastRes] = useState<{ status: number; data: any } | null>(null);

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
    const senderOk = isEmail(senderEmail);
    const recipientEmailOk = !recipientEmail.trim() || isEmail(recipientEmail);
    const recipientPhoneOk = !recipientPhone.trim() || isE164(recipientPhone);
    const hasDelivery = !!recipientEmail.trim() || !!recipientPhone.trim();
    const msgOk = !!message.trim();
    const amtOk = Number.isFinite(amountDollars) && amountCents >= 1000;
    const captchaOk = !siteKey || (turnstileToken && turnstileToken.length > 10);
    return senderOk && recipientEmailOk && recipientPhoneOk && hasDelivery && msgOk && amtOk && captchaOk && !submitting;
  }, [senderEmail, recipientEmail, recipientPhone, message, amountDollars, amountCents, siteKey, turnstileToken, submitting]);

  useEffect(() => {
    if (!selectedPreset) return;
    setMessage(selectedPreset);
  }, [selectedPreset]);

  function getTurnstileResponseNow() {
    try {
      const id = turnstileWidgetIdRef.current;
      if (!siteKey) return "";
      if (!window.turnstile) return "";
      if (id == null) return "";
      const t = window.turnstile.getResponse?.(id);
      return typeof t === "string" ? t : "";
    } catch {
      return "";
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function init() {
      setTurnstileError("");
      setTurnstileReady(false);
      setTurnstileToken("");

      if (!siteKey) return;

      try {
        await loadTurnstileScript();
        if (cancelled) return;

        if (!window.turnstile) {
          setTurnstileError("CAPTCHA failed to load. Please refresh.");
          return;
        }

        setTurnstileReady(true);

        if (turnstileContainerRef.current) {
          // Always re-render into a fresh container to avoid stale widgets
          turnstileContainerRef.current.innerHTML = "";
          turnstileWidgetIdRef.current = null;

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

          // Some browsers/extensions can delay callback; do a quick pull
          const immediate = getTurnstileResponseNow();
          if (immediate && immediate.length > 10) setTurnstileToken(immediate);
        }
      } catch (e: any) {
        setTurnstileError(String(e?.message || e || "CAPTCHA failed to load."));
      }
    }

    init();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey]);

  function resetTurnstile() {
    if (!siteKey) return;
    try {
      const id = turnstileWidgetIdRef.current;
      if (id != null && window.turnstile) window.turnstile.reset(id);
    } catch {
      // ignore
    }
    setTurnstileToken("");
  }

  function resetFormForAnother() {
    setSenderEmail("");
    setRecipientEmail("");
    setRecipientPhone("");
    setSelectedPreset("");
    setMessage("");
    setAmountDollars(10);
    setErr("");
    setTurnstileError("");
    setCopied(false);
    setResult(null);
    setLastReq(null);
    setLastRes(null);
    resetTurnstile();
  }

  async function copyCaptchaToken() {
    const t = turnstileToken || getTurnstileResponseNow();
    if (!t) return;
    try {
      await navigator.clipboard.writeText(t);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();

    setErr("");
    setTurnstileError("");
    setCopied(false);
    setLastReq(null);
    setLastRes(null);

    const sender = senderEmail.trim();
    const email = recipientEmail.trim();
    const phone = recipientPhone.trim();
    const msg = message.trim();

    if (!isEmail(sender)) return setErr("Please enter a valid sender email.");

    if (!email && !phone) return setErr("Enter a recipient email or phone number.");
    if (email && !isEmail(email)) return setErr("Please enter a valid recipient email.");
    if (phone && !isE164(phone)) return setErr("Invalid phone number (use E.164 like +15551234567).");

    if (!msg) return setErr("Please choose a message.");
    if (amountCents < 1000) return setErr("Minimum amount is $10.");

    // If siteKey exists, force a final read from widget before blocking submit.
    let tokenForSubmit = turnstileToken;
    if (siteKey && (!tokenForSubmit || tokenForSubmit.length <= 10)) {
      const pulled = getTurnstileResponseNow();
      if (pulled && pulled.length > 10) {
        tokenForSubmit = pulled;
        setTurnstileToken(pulled);
      }
    }
    if (siteKey && (!tokenForSubmit || tokenForSubmit.length <= 10)) {
      return setTurnstileError("Please complete the CAPTCHA.");
    }

    setSubmitting(true);
    try {
      const payload: any = {
        senderEmail: sender,
        message: msg,
        amount: amountCents,
        ...(email ? { recipientEmail: email } : {}),
        ...(phone ? { recipientPhone: phone } : {}),
        ...(tokenForSubmit ? { turnstileToken: tokenForSubmit } : {}),
      };

      const { res: r, usedUrl } = await postJsonWithApiFallback("/gifts", payload);
      const data = (await r.json().catch(() => ({}))) as CreateGiftResponse;

      setLastReq({ url: usedUrl, body: payload });
      setLastRes({ status: r.status, data });

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

      const publicId = safeText((data as any)?.publicId);
      const serverClaimUrl = safeText((data as any)?.claimUrl);

      if (!publicId) {
        setErr("Unexpected response from server.");
        resetTurnstile();
        return;
      }

      saveLastPublicId(publicId);

      const deterministic = buildClaimUrlFromPublicId(publicId);
      const fallback = serverClaimUrl ? absoluteLink(serverClaimUrl) : "";
      const finalClaimUrl = deterministic || fallback;

      const deliveryLabel = email && phone ? "Email + SMS" : email ? "Email" : "SMS";
      const recipientLabel = email && phone ? `${email} / ${phone}` : email ? email : phone;

      setResult({
        publicId,
        claimUrl: finalClaimUrl,
        deliveryLabel,
        recipientLabel,
        sender,
      });

      // Clear inputs for next send
      setSenderEmail("");
      setRecipientEmail("");
      setRecipientPhone("");
      setSelectedPreset("");
      setMessage("");
      setAmountDollars(10);

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
    } catch {
      // ignore
    }
  }

  const moneyPresets = [
    { label: "$10", value: 10 },
    { label: "$25", value: 25 },
    { label: "$50", value: 50 },
    { label: "$100", value: 100 },
  ];

  return (
    <div className="rounded-3xl border border-violet-100 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-bold tracking-tight">Create a ThanküMail</h2>
        <button
          type="button"
          onClick={() => setDebugOpen((v) => !v)}
          className="rounded-xl border bg-white px-3 py-2 text-xs"
        >
          {debugOpen ? "Hide debug" : "Show debug"}
        </button>
      </div>

      {debugOpen ? (
        <div className="mt-4 space-y-2 rounded-2xl border bg-slate-50 p-4 text-[12px] leading-relaxed">
          <div>
            <span className="font-semibold">Turnstile site key:</span> {siteKey ? "SET" : "NOT SET"}
          </div>
          <div>
            <span className="font-semibold">Turnstile ready:</span> {turnstileReady ? "YES" : "NO"}
          </div>
          <div>
            <span className="font-semibold">Token status:</span>{" "}
            {turnstileToken ? `PRESENT (len ${turnstileToken.length})` : "EMPTY"}
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={copyCaptchaToken} className="rounded-xl bg-white px-3 py-2 text-xs border">
              Copy CAPTCHA token
            </button>
            <button
              type="button"
              onClick={() => {
                const pulled = getTurnstileResponseNow();
                if (pulled && pulled.length > 10) setTurnstileToken(pulled);
              }}
              className="rounded-xl bg-white px-3 py-2 text-xs border"
            >
              Pull token from widget
            </button>
          </div>

          {lastReq ? (
            <div className="mt-2">
              <div className="font-semibold">Last request</div>
              <div>URL: {lastReq.url}</div>
              <pre className="mt-2 overflow-auto rounded-xl border bg-white p-3 text-[11px]">
                {JSON.stringify(lastReq.body, null, 2)}
              </pre>
            </div>
          ) : null}

          {lastRes ? (
            <div className="mt-2">
              <div className="font-semibold">Last response</div>
              <div>Status: {lastRes.status}</div>
              <pre className="mt-2 overflow-auto rounded-xl border bg-white p-3 text-[11px]">
                {JSON.stringify(lastRes.data, null, 2)}
              </pre>
            </div>
          ) : null}

          {turnstileError ? (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {turnstileError}
            </div>
          ) : null}
        </div>
      ) : null}

      {!result ? (
        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <input
              value={senderEmail}
              onChange={(e) => setSenderEmail(e.target.value)}
              placeholder="Sender email"
              inputMode="email"
              autoComplete="email"
              className="w-full rounded-2xl border px-4 py-3"
            />

            <input
              value={recipientEmail}
              onChange={(e) => setRecipientEmail(e.target.value)}
              placeholder="Recipient email (optional)"
              inputMode="email"
              autoComplete="email"
              className="w-full rounded-2xl border px-4 py-3"
            />
          </div>

          <input
            value={recipientPhone}
            onChange={(e) => setRecipientPhone(e.target.value)}
            placeholder="Recipient phone (optional, E.164 like +15551234567)"
            inputMode="tel"
            autoComplete="tel"
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

          <div className="flex gap-2 flex-wrap">
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

          {siteKey ? (
            <div className="space-y-2">
              <div className="text-xs text-slate-500">
                {turnstileReady ? "Complete the CAPTCHA to create a gift." : "Loading CAPTCHA…"}
              </div>

              <div ref={turnstileContainerRef} className="min-h-[70px] rounded-2xl border bg-white px-4 py-4" />

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const pulled = getTurnstileResponseNow();
                    if (pulled && pulled.length > 10) setTurnstileToken(pulled);
                  }}
                  className="rounded-xl border bg-white px-3 py-2 text-xs"
                >
                  Pull token
                </button>
                <button type="button" onClick={copyCaptchaToken} className="rounded-xl border bg-white px-3 py-2 text-xs">
                  Copy token
                </button>
              </div>

              {turnstileError ? (
                <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                  {turnstileError}
                </div>
              ) : null}
            </div>
          ) : null}

          {err ? (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{err}</div>
          ) : null}

          <button
            type="submit"
            disabled={!canSubmit}
            className="w-full rounded-2xl bg-violet-600 px-4 py-3 text-white disabled:bg-slate-300"
          >
            {submitting ? "Creating…" : siteKey && (!turnstileToken || turnstileToken.length <= 10) ? "Complete CAPTCHA" : "Create gift"}
          </button>

          {siteKey ? (
            <div className="text-[11px] leading-relaxed text-slate-500">
              Protected by Cloudflare Turnstile. If it doesn’t load, disable aggressive ad blockers or refresh.
            </div>
          ) : null}

          <div className="text-[11px] leading-relaxed text-slate-500">
            Recipient email or phone is required. Phone must be E.164 (example: +15551234567).
          </div>
        </form>
      ) : (
        <div className="mt-6 space-y-4">
          <div className="rounded-2xl border border-violet-200 bg-violet-50 px-4 py-4 text-sm">
            <div className="font-semibold text-slate-900">Your ThanküMail has been created.</div>
            <div className="mt-1 text-slate-700">
              Delivery: <span className="font-semibold">{result.deliveryLabel}</span>
            </div>
            <div className="mt-1 text-slate-700">
              Sent to: <span className="font-semibold">{result.recipientLabel}</span>
            </div>

            <div className="mt-3 flex gap-2">
              <input readOnly value={result.claimUrl} className="flex-1 rounded-xl border bg-white px-3 py-2 text-xs" />
              <button type="button" onClick={copyLink} className="rounded-xl bg-violet-600 px-4 py-2 text-xs text-white">
                {copied ? "Copied" : "Copy"}
              </button>
            </div>

            <div className="mt-3 text-[11px] text-slate-500">Reference ID: {result.publicId}</div>
          </div>

          <button
            type="button"
            onClick={resetFormForAnother}
            className="w-full rounded-2xl border border-violet-200 bg-white px-4 py-3 text-sm text-slate-900"
          >
            Send another ThanküMail
          </button>
        </div>
      )}
    </div>
  );
}
