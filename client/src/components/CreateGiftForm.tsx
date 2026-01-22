import React, { useEffect, useMemo, useRef, useState } from "react";

type CreateGiftOk = {
  ok: true;
  publicId: string;
  claimUrl: string;
  deliveryOk?: boolean;
};
type CreateGiftErr = {
  error: string;
  field?: string;
  code?: string;
  retryAfterSec?: number;
  issues?: any[];
};
type CreateGiftResponse = CreateGiftOk | CreateGiftErr;

declare global {
  interface Window {
    turnstile?: any;
  }
}

function isEmail(s: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}
function isE164(s: string) {
  return /^\+[1-9]\d{1,14}$/.test(s.trim());
}
function moneyToCentsFromLabel(label: string) {
  const n = Number(String(label).replace(/[^0-9.]/g, ""));
  const cents = Math.round(n * 100);
  return Number.isFinite(cents) ? cents : 0;
}
function absoluteLink(maybeRelative: string) {
  if (!maybeRelative) return maybeRelative;
  if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const path = maybeRelative.startsWith("/") ? maybeRelative : `/${maybeRelative}`;
  return `${origin}${path}`;
}

const TURNSTILE_SITE_KEY =
  (import.meta as any).env?.VITE_TURNSTILE_SITE_KEY ||
  (import.meta as any).env?.VITE_PUBLIC_TURNSTILE_SITE_KEY ||
  "";

const AMOUNTS = ["$10", "$25", "$50", "$100"] as const;

const PRESETS = [
  "Someone wanted you to know they’re genuinely grateful for you. Thank you.",
  "I appreciate you more than you know. This is a small thank you for a real impact.",
  "You made my day easier. I wanted to send something back with a sincere message.",
  "No big speech — just gratitude. Thank you for showing up the way you did.",
] as const;

export default function CreateGiftForm() {
  const [senderEmail, setSenderEmail] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("");
  const [message, setMessage] = useState<string>(PRESETS[0]);
  const [amountLabel, setAmountLabel] = useState<(typeof AMOUNTS)[number]>("$10");

  const [turnstileToken, setTurnstileToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [success, setSuccess] = useState("");
  const [lastClaimUrl, setLastClaimUrl] = useState("");

  const widgetRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<any>(null);
  const successTimerRef = useRef<any>(null);

  const amount = useMemo(() => moneyToCentsFromLabel(amountLabel), [amountLabel]);

  function setSuccessSticky(msg: string) {
    setSuccess(msg);
    if (successTimerRef.current) clearTimeout(successTimerRef.current);
    successTimerRef.current = setTimeout(() => setSuccess(""), 5000);
  }

  // load last link
  useEffect(() => {
    try {
      const v = localStorage.getItem("thankumail:lastClaimUrl") || "";
      if (v) setLastClaimUrl(v);
    } catch {}
    return () => {
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
    };
  }, []);

  // Load Turnstile script + render widget
  useEffect(() => {
    setTurnstileToken("");

    if (!TURNSTILE_SITE_KEY) return;

    const existing = document.querySelector('script[data-turnstile="1"]') as HTMLScriptElement | null;

    const renderWidget = () => {
      if (!window.turnstile || !widgetRef.current) return;

      try {
        if (widgetIdRef.current != null) {
          window.turnstile.remove(widgetIdRef.current);
          widgetIdRef.current = null;
        }
      } catch {}

      widgetIdRef.current = window.turnstile.render(widgetRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        callback: (token: string) => setTurnstileToken(token || ""),
        "expired-callback": () => setTurnstileToken(""),
        "error-callback": () => setTurnstileToken(""),
      });
    };

    if (existing) {
      const t = setInterval(() => {
        if (window.turnstile) {
          clearInterval(t);
          renderWidget();
        }
      }, 100);
      return () => clearInterval(t);
    }

    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.defer = true;
    s.setAttribute("data-turnstile", "1");
    s.onload = () => renderWidget();
    document.head.appendChild(s);

    const t = setInterval(() => {
      if (window.turnstile) {
        clearInterval(t);
        renderWidget();
      }
    }, 100);

    return () => clearInterval(t);
  }, []);

  async function submit() {
    setErr("");
    setSuccess("");

    const se = senderEmail.trim();
    const re = recipientEmail.trim();
    const rp = recipientPhone.trim();

    if (se && !isEmail(se)) return setErr("Sender email looks invalid.");
    if (!re && !rp) return setErr("Recipient email or phone is required.");
    if (re && !isEmail(re)) return setErr("Recipient email looks invalid.");
    if (rp && !isE164(rp)) return setErr("Phone must be E.164 (example: +15551234567).");
    if (!message.trim()) return setErr("Message is required.");
    if (!amount || amount < 1000) return setErr("Minimum amount is $10.");
    if (!turnstileToken) return setErr("Please complete the CAPTCHA.");

    setBusy(true);

    // IMPORTANT: show immediate feedback so user always sees it
    setSuccessSticky("Creating…");

    try {
      const res = await fetch("/api/gifts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          senderEmail: se || undefined,
          recipientEmail: re || undefined,
          recipientPhone: rp || undefined,
          message,
          amount,
          turnstileToken,
        }),
      });

      const text = await res.text();
      const data: CreateGiftResponse = (() => {
        try {
          return JSON.parse(text);
        } catch {
          return { error: text || `HTTP ${res.status}` };
        }
      })();

      if (!res.ok || "error" in data) {
        setSuccess(""); // clear "Creating…"
        setErr((data as any)?.error || `Request failed (HTTP ${res.status})`);
        setTurnstileToken("");
        try {
          if (window.turnstile && widgetIdRef.current != null) window.turnstile.reset(widgetIdRef.current);
        } catch {}
        return;
      }

      const claimUrlAbs = absoluteLink((data as CreateGiftOk).claimUrl);

      setLastClaimUrl(claimUrlAbs);
      try {
        localStorage.setItem("thankumail:lastClaimUrl", claimUrlAbs);
      } catch {}

      // show success and keep it visible even after we reset fields
      setSuccessSticky("Sent. Your message is on its way.");

      // reset form (keep sender email)
      setRecipientEmail("");
      setRecipientPhone("");
      setMessage(PRESETS[0]);
      setAmountLabel("$10");

      // reset captcha after success
      setTurnstileToken("");
      try {
        if (window.turnstile && widgetIdRef.current != null) window.turnstile.reset(widgetIdRef.current);
      } catch {}
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    if (!lastClaimUrl) return;
    try {
      await navigator.clipboard.writeText(lastClaimUrl);
      setSuccessSticky("Link copied.");
    } catch {}
  }

  return (
    <div style={{ maxWidth: 760, padding: "18px 14px" }}>
      <h1 style={{ margin: 0, fontSize: 30, fontWeight: 800 }}>ThankuMail</h1>
      <div style={{ marginTop: 6, fontSize: 18 }}>Send a gift with a real message.</div>

      <div style={{ marginTop: 14, fontSize: 22, fontWeight: 800 }}>
        A small gift. A message they’ll remember.
      </div>
      <div style={{ marginTop: 6, fontSize: 16, opacity: 0.9 }}>
        Your words arrive first. The gift follows when they’re ready.
      </div>

      <div style={{ marginTop: 18, paddingTop: 10 }}>
        <div style={{ fontWeight: 800, marginBottom: 6 }}>Last ThankuMail link</div>
        {lastClaimUrl ? (
          <>
            <div style={{ wordBreak: "break-all" }}>{lastClaimUrl}</div>
            <div style={{ display: "flex", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
              <button type="button" onClick={copyLink}>Copy link</button>
              <a href={lastClaimUrl} target="_blank" rel="noreferrer">Open claim page →</a>
            </div>
          </>
        ) : (
          <div style={{ opacity: 0.75 }}>None yet.</div>
        )}
      </div>

      <h2 style={{ marginTop: 22, marginBottom: 10 }}>Create a ThankuMail</h2>

      <div style={{ display: "grid", gap: 10 }}>
        <label style={{ display: "grid", gap: 6 }}>
          <div>Sender email (optional)</div>
          <input value={senderEmail} onChange={(e) => setSenderEmail(e.target.value)} placeholder="you@example.com" />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <div>Recipient email (optional)</div>
          <input value={recipientEmail} onChange={(e) => setRecipientEmail(e.target.value)} placeholder="friend@example.com" />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <div>Recipient phone (optional, E.164)</div>
          <input value={recipientPhone} onChange={(e) => setRecipientPhone(e.target.value)} placeholder="+15551234567" />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <div>Message</div>
          <select value={message} onChange={(e) => setMessage(e.target.value)}>
            {PRESETS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>

        <div style={{ display: "grid", gap: 6 }}>
          <div>Amount</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {AMOUNTS.map((a) => (
              <button key={a} type="button" onClick={() => setAmountLabel(a)} aria-pressed={amountLabel === a}>
                {a}
              </button>
            ))}
          </div>
        </div>

        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 12, marginBottom: 6, opacity: 0.85 }}>CAPTCHA</div>
          <div ref={widgetRef} />
          {!TURNSTILE_SITE_KEY ? (
            <div style={{ marginTop: 6, fontSize: 12, color: "crimson" }}>
              Missing VITE_TURNSTILE_SITE_KEY in frontend env.
            </div>
          ) : null}
        </div>

        {err ? <div style={{ color: "crimson", fontWeight: 700 }}>{err}</div> : null}
        {success ? <div style={{ color: "green", fontWeight: 800 }}>{success}</div> : null}

        <button type="button" onClick={submit} disabled={busy} style={{ padding: "10px 12px" }}>
          {busy ? "Creating…" : "Create gift"}
        </button>
      </div>
    </div>
  );
}
