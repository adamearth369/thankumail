// WHERE TO PASTE: client/src/components/CreateGiftForm.tsx
// ACTION: Full file replacement (paste exactly)

import React, { useMemo, useState } from "react";

type ApiError = {
  error: string;
  field?: string;
  code?: string;
  codes?: string[];
  issues?: any[];
  retryAfterSec?: number;
  version?: string;
  commit?: string;
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

function normalizePhoneToE164(input: string): string {
  const raw = String(input || "").trim();
  if (!raw) return "";

  if (raw.startsWith("00")) {
    const d2 = raw.slice(2).replace(/[^\d]/g, "");
    return d2 ? `+${d2}` : "";
  }

  const hasPlus = raw.startsWith("+");
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return "";

  if (hasPlus) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

function absoluteLink(maybeRelative: string) {
  if (!maybeRelative) return maybeRelative;
  if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const path = maybeRelative.startsWith("/") ? maybeRelative : `/${maybeRelative}`;
  return `${origin}${path}`;
}

function safeSetLastClaimUrl(url: string) {
  try {
    localStorage.setItem("thankumail:lastClaimUrl", url);
    localStorage.setItem("thankumail:lastClaimUrlTs", String(Date.now()));
  } catch {}
}

function toSearchParams(payload: Record<string, any>) {
  const p = new URLSearchParams();
  Object.entries(payload).forEach(([k, v]) => {
    if (v === undefined || v === null) return;
    p.set(k, String(v));
  });
  return p;
}

const API_BASE = "https://api.thankumail.com";

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export default function CreateGiftForm() {
  const [senderEmail, setSenderEmail] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("");
  const [amountDollars, setAmountDollars] = useState<number>(10);
  const [message, setMessage] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [apiError, setApiError] = useState<string>("");
  const [apiField, setApiField] = useState<string>("");
  const [created, setCreated] = useState<CreateGiftOk | null>(null);
  const [copied, setCopied] = useState(false);

  const presets = useMemo(
    () => [
      "Thinking of you. I appreciate you more than you know.",
      "Thank you for being there for me. You made a difference.",
      "You’ve helped me in ways I can’t fully explain — thank you.",
      "I’m proud of you. I see how hard you’re working.",
      "I’m grateful for you. No strings attached.",
      "This is just a small thank you for a big impact.",
    ],
    [],
  );

  const amountCents = useMemo(() => moneyToCents(amountDollars), [amountDollars]);
  const senderOk = useMemo(() => isEmail(senderEmail.trim()), [senderEmail]);

  const recipientEmailOk = useMemo(
    () => (recipientEmail.trim() ? isEmail(recipientEmail) : false),
    [recipientEmail],
  );

  const normalizedPhone = useMemo(() => (recipientPhone.trim() ? normalizePhoneToE164(recipientPhone) : ""), [recipientPhone]);
  const recipientPhoneOk = useMemo(
    () => (recipientPhone.trim() ? isE164(normalizedPhone) : false),
    [recipientPhone, normalizedPhone],
  );

  const recipientOk = useMemo(() => recipientEmailOk || recipientPhoneOk, [recipientEmailOk, recipientPhoneOk]);
  const messageOk = useMemo(() => message.trim().length >= 2, [message]);

  const formOk = useMemo(() => {
    const minOk = amountCents >= 1000;
    return senderOk && recipientOk && messageOk && minOk && !submitting;
  }, [senderOk, recipientOk, messageOk, amountCents, submitting]);

  function recipientHint() {
    if (recipientEmail.trim() && !recipientEmailOk) return "Email looks invalid.";
    if (recipientPhone.trim() && !recipientPhoneOk) return "Phone must be like 6043691517 or +16043691517.";
    if (!recipientEmail.trim() && !recipientPhone.trim()) return "Add an email or a phone number (at least one).";
    return "";
  }

  function clearFormInputs() {
    setSenderEmail("");
    setRecipientEmail("");
    setRecipientPhone("");
    setAmountDollars(10);
    setMessage("");
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;

    setApiError("");
    setApiField("");
    setCreated(null);
    setCopied(false);

    if (!senderOk) {
      setApiError("Sender email is required and must be valid.");
      setApiField("senderEmail");
      return;
    }
    if (!recipientOk) {
      setApiError("Please provide a valid recipient email or phone.");
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

    const phoneToSend = recipientPhone.trim() ? normalizePhoneToE164(recipientPhone) : "";
    if (recipientPhone.trim() && !isE164(phoneToSend)) {
      setApiError("Phone looks invalid. Try 6043691517 or +16043691517.");
      setApiField("recipientPhone");
      return;
    }

    setSubmitting(true);

    try {
      const payload: any = {
        senderEmail: senderEmail.trim(),
        recipientEmail: recipientEmail.trim() || undefined,
        recipientPhone: phoneToSend || undefined,
        message: message.trim(),
        amount: amountCents,
      };

      Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

      const body = toSearchParams(payload);

      const res = await fetch(`${API_BASE}/api/gifts`, {
        method: "POST",
        body,
      });

      const data = (await res.json().catch(() => ({}))) as CreateGiftResponse;

      if (!res.ok) {
        const msg = (data as any)?.error || `Request failed (${res.status})`;
        setApiError(msg);
        setApiField((data as any)?.field || "");
        return;
      }

      const ok = data as CreateGiftOk;
      setCreated(ok);

      const abs = absoluteLink(ok.claimUrl || "");
      if (abs) safeSetLastClaimUrl(abs);

      clearFormInputs();
    } catch {
      setApiError("Network error. Please try again.");
      setApiField("");
    } finally {
      setSubmitting(false);
    }
  }

  const claimUrl = created?.claimUrl ? absoluteLink(created.claimUrl) : "";

  async function copyLink() {
    if (!claimUrl) return;
    try {
      await navigator.clipboard?.writeText(claimUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  function openClaim() {
    if (!claimUrl) return;
    window.open(claimUrl, "_blank", "noopener,noreferrer");
  }

  const permissionCopy = recipientPhone.trim()
    ? "By sending via SMS, you confirm you have permission to contact this recipient."
    : "By sending, you confirm you have permission to contact the recipient.";

  return (
    <div className="w-full max-w-xl px-4 sm:px-0">
      <form onSubmit={onSubmit} className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="mb-4">
          <h2 className="text-xl font-semibold text-gray-900">Send a ThankuMail</h2>
          <p className="mt-1 text-sm text-gray-600">Send by email, phone, or both.</p>
        </div>

        {apiError ? (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{apiError}</div>
        ) : null}

        {created ? (
          <div className="mb-4 rounded-2xl border border-green-200 bg-green-50 px-4 py-4 text-sm text-green-900">
            <div className="text-base font-semibold">Sent.</div>

            {claimUrl ? (
              <div className="mt-3 rounded-xl border border-green-200 bg-white px-3 py-3">
                <div className="text-xs font-semibold text-gray-600">Claim link</div>
                <div className="mt-1 break-all text-xs text-gray-900">{claimUrl}</div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={openClaim}
                    className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:opacity-95 active:opacity-90"
                  >
                    Open claim page →
                  </button>

                  <button
                    type="button"
                    onClick={copyLink}
                    className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-900 hover:bg-gray-50"
                  >
                    {copied ? "Copied" : "Copy link"}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="grid gap-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-900">Your email</label>
            <input
              className={cx(
                "w-full box-border rounded-xl border bg-white px-3 py-2 text-sm outline-none",
                "border-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300",
                apiField === "senderEmail" ? "border-red-300" : "",
              )}
              placeholder="you@example.com"
              value={senderEmail}
              onChange={(e) => setSenderEmail(e.target.value)}
              inputMode="email"
              autoComplete="email"
            />
            <div className="mt-1 text-xs text-gray-600">Required.</div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-900">Recipient email (optional)</label>
            <input
              className={cx(
                "w-full box-border rounded-xl border bg-white px-3 py-2 text-sm outline-none",
                "border-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300",
                apiField === "recipientEmail" || apiField === "recipient" ? "border-red-300" : "",
              )}
              placeholder="friend@example.com"
              value={recipientEmail}
              onChange={(e) => setRecipientEmail(e.target.value)}
              inputMode="email"
              autoComplete="email"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-900">Recipient phone (optional)</label>
            <input
              className={cx(
                "w-full box-border rounded-xl border bg-white px-3 py-2 text-sm outline-none",
                "border-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300",
                apiField === "recipientPhone" || apiField === "recipient" ? "border-red-300" : "",
              )}
              placeholder="6043691517 or +16043691517"
              value={recipientPhone}
              onChange={(e) => setRecipientPhone(e.target.value)}
              inputMode="tel"
              autoComplete="tel"
            />
            <div className="mt-1 text-xs text-gray-600">{recipientHint()}</div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-900">Gift amount (CAD)</label>
            <input
              className={cx(
                "w-full box-border rounded-xl border bg-white px-3 py-2 text-sm outline-none",
                "border-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300",
                apiField === "amount" ? "border-red-300" : "",
              )}
              type="number"
              min={10}
              step={1}
              value={Number.isFinite(amountDollars) ? amountDollars : 10}
              onChange={(e) => setAmountDollars(Number(e.target.value))}
            />
            <div className="mt-1 text-xs text-gray-600">Minimum $10.00</div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-900">Your message</label>
            <textarea
              className={cx(
                "min-h-[140px] w-full box-border resize-y rounded-xl border bg-white px-3 py-2 text-sm outline-none",
                "border-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300",
                apiField === "message" ? "border-red-300" : "",
              )}
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
                  className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-xs text-gray-900 hover:opacity-90"
                  onClick={() => setMessage(p)}
                >
                  Use preset
                </button>
              ))}
            </div>
          </div>

          <button
            type="submit"
            disabled={!formOk}
            className="rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:opacity-95 active:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Sending…" : "Send ThankuMail"}
          </button>

          <div className="text-xs text-gray-600">{permissionCopy}</div>
        </div>
      </form>
    </div>
  );
}
