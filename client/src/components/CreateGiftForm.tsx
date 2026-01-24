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

type LastLink = {
  claimUrl: string;
  createdAt: number; // ms
};

const LAST_LINK_STRUCTURED_KEY = "thankumail:lastClaim";
const LAST_LINK_LEGACY_KEY = "thankumail:lastClaimUrl";

function moneyToCents(dollars: number) {
  const cents = Math.round((Number(dollars) || 0) * 100);
  return Number.isFinite(cents) ? cents : 0;
}

function isEmail(s: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
}

function isE164(s: string) {
  return /^\+[1-9]\d{7,14}$/.test(String(s || "").trim());
}

function absoluteLink(maybeRelative: string) {
  if (!maybeRelative) return maybeRelative;
  if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const path = maybeRelative.startsWith("/") ? maybeRelative : `/${maybeRelative}`;
  return `${origin}${path}`;
}

function isValidHttpUrl(s: string) {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function saveLastClaimUrl(url: string) {
  try {
    if (!url) return;
    if (typeof window === "undefined") return;
    if (!isValidHttpUrl(url)) return;

    const structured: LastLink = { claimUrl: url, createdAt: Date.now() };
    localStorage.setItem(LAST_LINK_STRUCTURED_KEY, JSON.stringify(structured));
    localStorage.setItem(LAST_LINK_LEGACY_KEY, url);
  } catch {
    // ignore
  }
}

declare global {
  interface Window {
    turnstile?: any;
  }
}

const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

function loadTurnstileScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") return resolve();
    if (window.turnstile) return resolve();

    const existing = document.querySelector<HTMLScriptElement>(
      `script[src^="https://challenges.cloudflare.com/turnstile/"]`
    );
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Failed to load Turnstile script")), { once: true });
      return;
    }

    const s = document.createElement("script");
    s.src = TURNSTILE_SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load Turnstile script"));
    document.head.appendChild(s);
  });
}

export default function CreateGiftForm() {
  // ---- user inputs ----
  const [senderEmail, setSenderEmail] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("");
  const [amountDollars, setAmountDollars] = useState<number>(10);
  const [message, setMessage] = useState("");

  // ---- UI state ----
  const [submitting, setSubmitting] = useState(false);
  const [apiError, setApiError] = useState<string>("");
  const [apiField, setApiField] = useState<string>("");
  const [created, setCreated] = useState<CreateGiftOk | null>(null);

  // ---- Turnstile ----
  const siteKey =
    (import.meta as any).env?.VITE_TURNSTILE_SITE_KEY ||
    (import.meta as any).env?.VITE_CF_TURNSTILE_SITE_KEY ||
    "";

  const turnstileContainerRef = useRef<HTMLDivElement | null>(null);
  const turnstileWidgetIdRef = useRef<any>(null);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileReady, setTurnstileReady] = useState(false);
  const [turnstileRenderError, setTurnstileRenderError] = useState<string>("");

  const presets = useMemo(
    () => [
      "Thinking of you. I appreciate you more than you know.",
      "Thank you for being there for me. You made a difference.",
      "You’ve helped me in ways I can’t fully explain — thank you.",
      "I’m proud of you. I see how hard you’re working.",
      "I’m grateful for you. No strings attached.",
      "This is just a small thank you for a big impact.",
    ],
    []
  );

  const canUseTurnstile = Boolean(siteKey) && typeof window !== "undefined";

  function resetTurnstile() {
    try {
      const wid = turnstileWidgetIdRef.current;
      if (wid != null && window.turnstile?.reset) {
        window.turnstile.reset(wid);
      }
    } catch {}
    setTurnstileToken("");
  }

  async function renderTurnstile(force = false) {
    if (!canUseTurnstile) return;

    try {
      setTurnstileRenderError("");
      await loadTurnstileScript();
      if (!turnstileContainerRef.current) return;

      if (!force && turnstileWidgetIdRef.current != null && window.turnstile?.getResponse) {
        setTurnstileReady(true);
        return;
      }

      turnstileContainerRef.current.innerHTML = "";

      const wid = window.turnstile.render(turnstileContainerRef.current, {
        sitekey: siteKey,
        theme: "auto",
        callback: (token: string) => {
          setTurnstileToken(token || "");
          setApiError("");
          setApiField("");
        },
        "error-callback": () => {
          setTurnstileToken("");
          setApiError("CAPTCHA failed. Please try again.");
          setApiField("turnstileToken");
        },
        "expired-callback": () => {
          setTurnstileToken("");
          setApiError("CAPTCHA expired. Please complete it again.");
          setApiField("turnstileToken");
        },
      });

      turnstileWidgetIdRef.current = wid;
      setTurnstileReady(true);
    } catch {
      setTurnstileReady(false);
      setTurnstileRenderError("Unable to load CAPTCHA. Please refresh and try again.");
      setApiError("Unable to load CAPTCHA. Please refresh and try again.");
      setApiField("turnstileToken");
    }
  }

  useEffect(() => {
    renderTurnstile(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey]);

  // ---- validation ----
  const amountCents = useMemo(() => moneyToCents(amountDollars), [amountDollars]);

  const senderOk = useMemo(() => isEmail(senderEmail.trim()), [senderEmail]);

  const recipientEmailOk = useMemo(() => (recipientEmail.trim() ? isEmail(recipientEmail) : false), [recipientEmail]);
  const recipientPhoneOk = useMemo(() => (recipientPhone.trim() ? isE164(recipientPhone) : false), [recipientPhone]);

  const recipientOk = useMemo(() => recipientEmailOk || recipientPhoneOk, [recipientEmailOk, recipientPhoneOk]);

  const messageOk = useMemo(() => message.trim().length >= 2, [message]);

  const formOk = useMemo(() => {
    const minOk = amountCents >= 1000;
    const captchaOk = !canUseTurnstile || (!!turnstileToken && turnstileToken.length > 10);
    return senderOk && recipientOk && messageOk && minOk && captchaOk && !submitting;
  }, [senderOk, recipientOk, messageOk, amountCents, canUseTurnstile, turnstileToken, submitting]);

  function recipientHint() {
    if (recipientEmail.trim() && !recipientEmailOk) return "Email looks invalid.";
    if (recipientPhone.trim() && !recipientPhoneOk) return "Phone must be E.164 like +14165551234.";
    if (!recipientEmail.trim() && !recipientPhone.trim()) return "Add an email or a phone number (at least one).";
    return "";
  }

  // ---- submit ----
  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;

    setApiError("");
    setApiField("");
    setCreated(null);

    if (!senderOk) {
      setApiError("Sender email is required and must be valid.");
      setApiField("senderEmail");
      return;
    }
    if (!recipientOk) {
      setApiError("Please provide a valid recipient email or phone (+14165551234).");
      setApiField("recipient");
      return;
    }
    if (!messageOk) {
      setApiError("Please write a short message.");
      setApiField("message");
      return;
    }
    if (amountCents < 1000) {
      setApiError("Minimum amount is $10.00.");
      setApiField("amount");
      return;
    }

    if (canUseTurnstile) {
      if (!turnstileReady || turnstileRenderError) {
        setApiError("CAPTCHA isn’t ready yet. Please refresh and try again.");
        setApiField("turnstileToken");
        return;
      }
      if (!turnstileToken) {
        setApiError("Please complete the CAPTCHA.");
        setApiField("turnstileToken");
        return;
      }
    }

    setSubmitting(true);

    try {
      const payload: any = {
        senderEmail: senderEmail.trim(),
        recipientEmail: recipientEmail.trim() || undefined,
        recipientPhone: recipientPhone.trim() || undefined,
        message: message.trim(),
        amount: amountCents,
        turnstileToken: canUseTurnstile ? turnstileToken : undefined,
      };

      Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

      const res = await fetch("/api/gifts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = (await res.json().catch(() => ({}))) as CreateGiftResponse;

      if (!res.ok) {
        const msg = (data as any)?.error || `Request failed (${res.status})`;
        setApiError(msg);
        setApiField((data as any)?.field || "");

        resetTurnstile();
        await renderTurnstile(true);
        return;
      }

      const ok = data as CreateGiftOk;
      setCreated(ok);

      // Save "last link" locally (structured + legacy) so Home updates on next load
      const abs = ok?.claimUrl ? absoluteLink(ok.claimUrl) : "";
      if (abs) saveLastClaimUrl(abs);

      setRecipientEmail("");
      setRecipientPhone("");
      setAmountDollars(10);
      setMessage("");

      resetTurnstile();
      await renderTurnstile(true);
    } catch {
      setApiError("Network error. Please try again.");
      setApiField("");
      resetTurnstile();
      await renderTurnstile(true);
    } finally {
      setSubmitting(false);
    }
  }

  const claimUrl = created?.claimUrl ? absoluteLink(created.claimUrl) : "";

  return (
    <div className="w-full max-w-xl">
      <form onSubmit={onSubmit} className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="mb-4">
          <h2 className="text-xl font-semibold text-gray-900">Send a ThankuMail</h2>
          <p className="mt-1 text-sm text-gray-600">Send by email, phone, or both.</p>
        </div>

        {apiError ? (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {apiError}
          </div>
        ) : null}

        {created ? (
          <div className="mb-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900">
            <div className="font-semibold">Created</div>
            <div className="mt-1">
              Claim link:{" "}
              <a className="underline" href={claimUrl} target="_blank" rel="noreferrer">
                {claimUrl}
              </a>
            </div>
            {typeof created.deliveryOk === "boolean" ? (
              <div className="mt-1">Delivery: {created.deliveryOk ? "queued/sent" : "not sent"}</div>
            ) : null}
          </div>
        ) : null}

        <div className="grid gap-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-800">Sender email</label>
            <input
              className={`w-full rounded-xl border px-3 py-2 text-sm outline-none ${
                apiField === "senderEmail" ? "border-red-300" : "border-gray-200"
              }`}
              placeholder="you@example.com"
              value={senderEmail}
              onChange={(e) => setSenderEmail(e.target.value)}
              inputMode="email"
              autoComplete="email"
            />
            <div className="mt-1 text-xs text-gray-500">Required.</div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-800">Recipient email (optional)</label>
            <input
              className={`w-full rounded-xl border px-3 py-2 text-sm outline-none ${
                apiField === "recipientEmail" || apiField === "recipient" ? "border-red-300" : "border-gray-200"
              }`}
              placeholder="friend@example.com"
              value={recipientEmail}
              onChange={(e) => setRecipientEmail(e.target.value)}
              inputMode="email"
              autoComplete="email"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-800">Recipient phone (optional)</label>
            <input
              className={`w-full rounded-xl border px-3 py-2 text-sm outline-none ${
                apiField === "recipientPhone" || apiField === "recipient" ? "border-red-300" : "border-gray-200"
              }`}
              placeholder="+14165551234"
              value={recipientPhone}
              onChange={(e) => setRecipientPhone(e.target.value)}
              inputMode="tel"
              autoComplete="tel"
            />
            <div className="mt-1 text-xs text-gray-500">{recipientHint()}</div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-800">Amount (CAD)</label>
            <input
              className={`w-full rounded-xl border px-3 py-2 text-sm outline-none ${
                apiField === "amount" ? "border-red-300" : "border-gray-200"
              }`}
              type="number"
              min={10}
              step={1}
              value={Number.isFinite(amountDollars) ? amountDollars : 10}
              onChange={(e) => setAmountDollars(Number(e.target.value))}
            />
            <div className="mt-1 text-xs text-gray-500">Minimum $10.00</div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-800">Message</label>
            <textarea
              className={`min-h-[120px] w-full resize-y rounded-xl border px-3 py-2 text-sm outline-none ${
                apiField === "message" ? "border-red-300" : "border-gray-200"
              }`}
              placeholder="Write something real…"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={2000}
            />
            <div className="mt-2 flex flex-wrap gap-2">
              {presets.map((p) => (
                <button
                  key={p}
                  type="button"
                  className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-xs text-gray-700 hover:bg-gray-100"
                  onClick={() => setMessage(p)}
                >
                  Use preset
                </button>
              ))}
            </div>
          </div>

          {canUseTurnstile ? (
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-800">CAPTCHA</label>
              <div
                className={`inline-block rounded-xl border bg-white p-3 ${
                  apiField === "turnstileToken" ? "border-red-300" : "border-gray-200"
                }`}
              >
                <div ref={turnstileContainerRef} />
              </div>
              {turnstileRenderError ? <div className="mt-2 text-xs text-red-700">{turnstileRenderError}</div> : null}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={!formOk}
            className="rounded-xl bg-black px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Sending…" : "Create & Send"}
          </button>

          <div className="text-xs text-gray-500">By sending, you confirm you have permission to contact the recipient.</div>
        </div>
      </form>
    </div>
  );
}
