// client/src/components/CreateGiftForm.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";

type CreateGiftOk = {
  ok: true;
  publicId: string;
  claimUrl: string;
  deliveryOk?: boolean;
};

type CreateGiftErr = {
  error: string;
  code?: string;
  field?: string;
  issues?: any[];
  retryAfterSec?: number;
  codes?: string[];
};

type CreateGiftResponse = CreateGiftOk | CreateGiftErr;

function isEmail(s: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
}

function isE164Phone(s: string) {
  // +15551234567 (min 8 digits after +, max 15)
  return /^\+[1-9]\d{7,14}$/.test(String(s || "").trim());
}

function getApiBase() {
  const v = (import.meta as any).env?.VITE_API_BASE_URL || "";
  return String(v || "").replace(/\/+$/, "");
}

function getTurnstileSiteKey() {
  return (
    (import.meta as any).env?.VITE_TURNSTILE_SITE_KEY ||
    (import.meta as any).env?.VITE_PUBLIC_TURNSTILE_SITE_KEY ||
    (import.meta as any).env?.VITE_PUBLIC_TURNSTILE_SITEKEY ||
    ""
  );
}

function readLocalLastLink() {
  try {
    return localStorage.getItem("thankumail:lastClaimUrl") || "";
  } catch {
    return "";
  }
}

function writeLocalLastLink(url: string) {
  try {
    localStorage.setItem("thankumail:lastClaimUrl", url);
  } catch {}
}

async function readJson(res: Response) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text || `HTTP ${res.status}` };
  }
}

declare global {
  interface Window {
    turnstile?: any;
  }
}

const PRESET_MESSAGES = [
  "Someone wanted you to know they’re genuinely grateful for you. Thank you.",
  "No big speech — just gratitude. Thank you for showing up the way you did.",
  "You made my day easier. I wanted to send something back with a sincere message.",
  "You matter to people in a meaningful way. Your presence and actions had a positive impact. Thank you.",
  "I appreciate you more than you know. This is a small thank you for a real impact.",
];

const AMOUNTS = [
  { label: "$10", cents: 1000 },
  { label: "$25", cents: 2500 },
  { label: "$50", cents: 5000 },
  { label: "$100", cents: 10000 },
];

export default function CreateGiftForm() {
  const apiBase = useMemo(() => getApiBase(), []);
  const turnstileSiteKey = useMemo(() => getTurnstileSiteKey(), []);

  const [senderEmail, setSenderEmail] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("");
  const [message, setMessage] = useState(PRESET_MESSAGES[0]);
  const [amount, setAmount] = useState<number>(AMOUNTS[0].cents);

  const [creating, setCreating] = useState(false);
  const [statusLine, setStatusLine] = useState("");
  const [error, setError] = useState("");
  const [lastClaimUrl, setLastClaimUrl] = useState(readLocalLastLink());

  // Turnstile
  const turnstileDivRef = useRef<HTMLDivElement | null>(null);
  const turnstileWidgetIdRef = useRef<any>(null);
  const [turnstileToken, setTurnstileToken] = useState("");

  const createUrl = useMemo(() => {
    const path = `/api/gifts`;
    return apiBase ? `${apiBase}${path}` : path;
  }, [apiBase]);

  useEffect(() => {
    // keep last link in sync if user opens in another tab
    const t = setInterval(() => {
      const v = readLocalLastLink();
      if (v && v !== lastClaimUrl) setLastClaimUrl(v);
    }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!turnstileSiteKey) return;

    // load Turnstile script once
    const id = "cf-turnstile-script";
    if (!document.getElementById(id)) {
      const s = document.createElement("script");
      s.id = id;
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true;
      s.defer = true;
      document.head.appendChild(s);
    }

    let cancelled = false;

    const tryRender = () => {
      if (cancelled) return;
      if (!window.turnstile) return;

      if (!turnstileDivRef.current) return;

      // avoid duplicate renders
      if (turnstileWidgetIdRef.current != null) return;

      turnstileWidgetIdRef.current = window.turnstile.render(turnstileDivRef.current, {
        sitekey: turnstileSiteKey,
        theme: "light",
        callback: (token: string) => {
          setTurnstileToken(String(token || ""));
          setError("");
        },
        "error-callback": () => {
          setTurnstileToken("");
        },
        "expired-callback": () => {
          setTurnstileToken("");
        },
      });
    };

    const iv = setInterval(() => {
      tryRender();
      if (window.turnstile && turnstileWidgetIdRef.current != null) clearInterval(iv);
    }, 200);

    return () => {
      cancelled = true;
      clearInterval(iv);
      try {
        if (window.turnstile && turnstileWidgetIdRef.current != null) {
          window.turnstile.remove(turnstileWidgetIdRef.current);
        }
      } catch {}
      turnstileWidgetIdRef.current = null;
      setTurnstileToken("");
    };
  }, [turnstileSiteKey]);

  function resetTurnstile() {
    try {
      if (window.turnstile && turnstileWidgetIdRef.current != null) {
        window.turnstile.reset(turnstileWidgetIdRef.current);
      }
    } catch {}
    setTurnstileToken("");
  }

  async function onCreate() {
    setError("");
    setStatusLine("");

    const se = senderEmail.trim();
    const re = recipientEmail.trim();
    const rp = recipientPhone.trim();

    if (se && !isEmail(se)) {
      setError("Sender email looks invalid.");
      return;
    }

    const hasEmail = !!re;
    const hasPhone = !!rp;

    if (!hasEmail && !hasPhone) {
      setError("Recipient email or phone is required. Phone must be E.164 (example: +15551234567).");
      return;
    }
    if (hasEmail && !isEmail(re)) {
      setError("Recipient email looks invalid.");
      return;
    }
    if (hasPhone && !isE164Phone(rp)) {
      setError("Recipient phone must be E.164 (example: +15551234567).");
      return;
    }

    if (!turnstileSiteKey) {
      setError("Missing VITE_TURNSTILE_SITE_KEY in frontend env.");
      return;
    }
    if (!turnstileToken) {
      setError("Please complete the CAPTCHA.");
      return;
    }

    setCreating(true);
    setStatusLine("Creating…");

    try {
      const payload: any = {
        senderEmail: se || undefined,
        recipientEmail: re || undefined,
        recipientPhone: rp || undefined,
        message: String(message || "").trim(),
        amount: Number(amount || 0),
        turnstileToken,
      };

      const res = await fetch(createUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = (await readJson(res)) as CreateGiftResponse;

      if (!res.ok || (data && typeof data === "object" && "error" in data)) {
        const msg =
          (data as any)?.error ||
          (data as any)?.message ||
          `Create failed (HTTP ${res.status})`;

        setError(String(msg));
        setStatusLine("");
        resetTurnstile();
        return;
      }

      const ok = data as CreateGiftOk;
      const claim = ok.claimUrl || (ok.publicId ? `${window.location.origin}/claim/${ok.publicId}` : "");

      if (claim) {
        writeLocalLastLink(claim);
        setLastClaimUrl(claim);
      }

      setStatusLine("Sent. Your message is on its way.");
      // Polished copy for Option B:
      // (keeps it short + emotionally aligned)
      // shown directly under the status line
      setCreating(false);

      // clear fields lightly (keep sender as convenience)
      setRecipientEmail("");
      setRecipientPhone("");
      setMessage(PRESET_MESSAGES[0]);
      setAmount(AMOUNTS[0].cents);

      resetTurnstile();
    } catch (e: any) {
      setError(e?.message || "Network error.");
      setStatusLine("");
      resetTurnstile();
    } finally {
      setCreating(false);
    }
  }

  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 28, fontWeight: 900, marginBottom: 6 }}>ThanküMail</div>
      <div style={{ fontSize: 16, opacity: 0.9 }}>Send a gift with a real message.</div>

      <div style={{ marginTop: 16, fontSize: 26, fontWeight: 900 }}>A small gift. A message they’ll remember.</div>
      <div style={{ marginTop: 6, fontSize: 16, opacity: 0.9 }}>
        Your words arrive first. The gift follows when they’re ready.
      </div>

      <div style={{ marginTop: 18 }}>
        <div style={{ fontWeight: 800, marginBottom: 6 }}>Last ThanküMail link</div>
        {lastClaimUrl ? (
          <>
            <div style={{ fontFamily: "monospace", wordBreak: "break-all" }}>{lastClaimUrl}</div>
            <div style={{ marginTop: 8, display: "flex", gap: 10, alignItems: "center" }}>
              <button
                type="button"
                onClick={() => {
                  try {
                    navigator.clipboard.writeText(lastClaimUrl);
                  } catch {}
                }}
              >
                Copy link
              </button>
              <a href={lastClaimUrl} style={{ textDecoration: "none" }}>
                Open claim page →
              </a>
            </div>
            <div style={{ marginTop: 8, opacity: 0.85 }}>
              Tip: This saves your latest link in your browser so you can grab it again easily.
            </div>
          </>
        ) : (
          <div style={{ opacity: 0.8 }}>None yet.</div>
        )}
      </div>

      <div style={{ marginTop: 26, fontSize: 18, fontWeight: 900 }}>Create a ThanküMail</div>

      <div style={{ marginTop: 14 }}>
        <div style={{ marginTop: 10, fontWeight: 700 }}>Sender email (optional)</div>
        <input
          value={senderEmail}
          onChange={(e) => setSenderEmail(e.target.value)}
          placeholder="you@example.com"
          style={{ width: "100%", padding: "10px 12px", marginTop: 6 }}
        />

        <div style={{ marginTop: 14, fontWeight: 700 }}>Recipient email (optional)</div>
        <input
          value={recipientEmail}
          onChange={(e) => setRecipientEmail(e.target.value)}
          placeholder="friend@example.com"
          style={{ width: "100%", padding: "10px 12px", marginTop: 6 }}
        />

        <div style={{ marginTop: 14, fontWeight: 700 }}>Recipient phone (optional, E.164)</div>
        <input
          value={recipientPhone}
          onChange={(e) => setRecipientPhone(e.target.value)}
          placeholder="+15551234567"
          style={{ width: "100%", padding: "10px 12px", marginTop: 6 }}
        />

        <div style={{ marginTop: 14, fontWeight: 700 }}>Message</div>
        <select
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          style={{ width: "100%", padding: "10px 12px", marginTop: 6 }}
        >
          {PRESET_MESSAGES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>

        <div style={{ marginTop: 16, fontWeight: 700 }}>Amount</div>
        <div style={{ marginTop: 8, display: "flex", gap: 12, flexWrap: "wrap" }}>
          {AMOUNTS.map((a) => {
            const selected = amount === a.cents;
            return (
              <button
                key={a.cents}
                type="button"
                onClick={() => setAmount(a.cents)}
                style={{
                  padding: "10px 14px",
                  borderRadius: 10,
                  border: selected ? "2px solid #111" : "1px solid #ccc",
                  fontWeight: 800,
                  cursor: "pointer",
                }}
              >
                {a.label}
              </button>
            );
          })}
        </div>

        <div style={{ marginTop: 18, fontSize: 12, letterSpacing: 0.6, opacity: 0.85 }}>CAPTCHA</div>

        {!turnstileSiteKey ? (
          <div style={{ marginTop: 8, color: "crimson", fontWeight: 800 }}>
            Missing VITE_TURNSTILE_SITE_KEY in frontend env.
          </div>
        ) : (
          <div style={{ marginTop: 8 }}>
            <div ref={turnstileDivRef} />
          </div>
        )}

        {error ? (
          <div style={{ marginTop: 12, color: "crimson", fontWeight: 900 }}>{error}</div>
        ) : null}

        <div style={{ marginTop: 18 }}>
          <button
            type="button"
            onClick={onCreate}
            disabled={creating}
            style={{ padding: "12px 14px", fontWeight: 900, minWidth: 160 }}
          >
            {creating ? "Creating…" : "Create gift"}
          </button>
        </div>

        {statusLine ? (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 900, color: "green" }}>{statusLine}</div>
            <div style={{ marginTop: 6, opacity: 0.9 }}>
              Your words arrive first. The gift follows when they’re ready.
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
