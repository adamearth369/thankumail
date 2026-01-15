// ===============================
// FILE TO REPLACE (FULL FILE)
// WHERE TO PASTE: client/src/components/CreateGiftForm.tsx
// PURPOSE:
// - Fix "Unexpected response" false error
// - Clear fields on success
// - Robust Turnstile token handling + reset
// - Success = HTTP 200 + JSON contains { publicId }
// ===============================

import React, { useEffect, useMemo, useRef, useState } from "react";

declare global {
  interface Window {
    turnstile?: any;
    __TURNSTILE_SITE_KEY__?: string;
  }
}

type CreateGiftResponse = { publicId: string };

function isEmail(s: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function safeJsonParse(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function getTurnstileSiteKey() {
  // Try Vite env first
  const viteKey =
    (import.meta as any)?.env?.VITE_TURNSTILE_SITE_KEY ||
    (import.meta as any)?.env?.VITE_CF_TURNSTILE_SITE_KEY ||
    "";
  if (viteKey) return String(viteKey);

  // Optional server-injected global fallback
  if (window.__TURNSTILE_SITE_KEY__) return String(window.__TURNSTILE_SITE_KEY__);

  return "";
}

function injectTurnstileScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.turnstile) return resolve();

    const existing = document.querySelector<HTMLScriptElement>(
      'script[src^="https://challenges.cloudflare.com/turnstile/v0/api.js"]'
    );
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Turnstile script failed to load")));
      return;
    }

    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Turnstile script failed to load"));
    document.head.appendChild(s);
  });
}

export default function CreateGiftForm() {
  const [recipientEmail, setRecipientEmail] = useState("");
  const [message, setMessage] = useState("");
  const [amountCents, setAmountCents] = useState(1000);

  const [turnstileToken, setTurnstileToken] = useState<string>("");
  const [turnstileReady, setTurnstileReady] = useState(false);
  const [turnstileError, setTurnstileError] = useState<string>("");

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorText, setErrorText] = useState<string>("");
  const [successPublicId, setSuccessPublicId] = useState<string>("");

  const siteKey = useMemo(() => getTurnstileSiteKey(), []);

  const widgetRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);

  const presetAmounts = useMemo(
    () => [
      { label: "$10", cents: 1000 },
      { label: "$25", cents: 2500 },
      { label: "$50", cents: 5000 },
      { label: "$100", cents: 10000 },
    ],
    []
  );

  function resetForm() {
    setRecipientEmail("");
    setMessage("");
    setAmountCents(1000);
    setTurnstileToken("");
    setErrorText("");
    // keep successPublicId (so user sees confirmation)
  }

  async function resetTurnstile() {
    try {
      if (window.turnstile && widgetIdRef.current) {
        window.turnstile.reset(widgetIdRef.current);
      }
    } catch {
      // ignore
    } finally {
      setTurnstileToken("");
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      setTurnstileError("");
      if (!siteKey) {
        setTurnstileError("Turnstile site key missing.");
        return;
      }

      try {
        await injectTurnstileScript();
        if (cancelled) return;

        if (!widgetRef.current) return;

        // If already rendered, skip
        if (widgetIdRef.current) {
          setTurnstileReady(true);
          return;
        }

        const id = window.turnstile.render(widgetRef.current, {
          sitekey: siteKey,
          callback: (token: string) => {
            setTurnstileToken(token || "");
            setErrorText("");
          },
          "error-callback": () => {
            setTurnstileToken("");
            setTurnstileError("CAPTCHA error. Refresh and try again.");
          },
          "expired-callback": () => {
            setTurnstileToken("");
          },
        });

        widgetIdRef.current = id;
        setTurnstileReady(true);
      } catch (e: any) {
        setTurnstileError(String(e?.message || e || "CAPTCHA failed to load."));
      }
    }

    boot();
    return () => {
      cancelled = true;
    };
  }, [siteKey]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (isSubmitting) return;

    setErrorText("");
    setSuccessPublicId("");

    const to = recipientEmail.trim();
    const msg = message.trim();

    if (!isEmail(to)) {
      setErrorText("Please enter a valid recipient email.");
      return;
    }
    if (!Number.isFinite(amountCents) || amountCents < 1000) {
      setErrorText("Minimum amount is $10.");
      return;
    }
    if (!turnstileToken) {
      setErrorText("Complete CAPTCHA.");
      return;
    }

    setIsSubmitting(true);

    try {
      const res = await fetch("/api/gifts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          recipientEmail: to,
          message: msg,
          amount: amountCents,
          turnstileToken,
        }),
      });

      const text = await res.text();
      const data = safeJsonParse(text);

      // If not ok, show server error if present
      if (!res.ok) {
        const serverMsg =
          (data && (data.error || data.message)) ||
          text?.slice(0, 200) ||
          `Request failed (${res.status})`;
        setErrorText(String(serverMsg));
        await resetTurnstile();
        return;
      }

      // Success if publicId exists
      const publicId = (data as CreateGiftResponse | null)?.publicId;
      if (publicId && typeof publicId === "string") {
        setSuccessPublicId(publicId);
        resetForm();
        await resetTurnstile();
        return;
      }

      // If API returned OK but shape unexpected, treat as success-ish but show details
      setErrorText("Unexpected response from server (missing publicId).");
      await resetTurnstile();
    } catch (err: any) {
      setErrorText(String(err?.message || err || "Network error"));
      await resetTurnstile();
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} style={{ maxWidth: 560 }}>
      <h2 style={{ margin: "12px 0 8px" }}>Create a ThanküMail</h2>

      <label style={{ display: "block", marginTop: 10, fontWeight: 600 }}>Recipient email</label>
      <input
        value={recipientEmail}
        onChange={(e) => setRecipientEmail(e.target.value)}
        placeholder="name@example.com"
        autoComplete="email"
        style={{ width: "100%", padding: 10, marginTop: 6 }}
      />

      <label style={{ display: "block", marginTop: 10, fontWeight: 600 }}>Write something real…</label>
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={4}
        style={{ width: "100%", padding: 10, marginTop: 6, resize: "vertical" }}
      />

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        {presetAmounts.map((a) => (
          <button
            key={a.cents}
            type="button"
            onClick={() => setAmountCents(a.cents)}
            style={{
              padding: "8px 12px",
              border: "1px solid #ccc",
              background: amountCents === a.cents ? "#111" : "#fff",
              color: amountCents === a.cents ? "#fff" : "#111",
              borderRadius: 8,
              cursor: "pointer",
              fontWeight: 700,
            }}
          >
            {a.label}
          </button>
        ))}
      </div>

      <div style={{ marginTop: 14, fontWeight: 600 }}>Complete the CAPTCHA to create a gift.</div>

      <div style={{ marginTop: 10 }}>
        <div ref={widgetRef} />
        {!turnstileReady && !turnstileError && (
          <div style={{ marginTop: 8, fontSize: 13, opacity: 0.8 }}>Loading CAPTCHA…</div>
        )}
        {turnstileError && (
          <div style={{ marginTop: 8, fontSize: 13, color: "#b00020" }}>{turnstileError}</div>
        )}
        <div style={{ marginTop: 8, fontSize: 13, opacity: 0.8 }}>
          Protected by Cloudflare Turnstile. If it doesn’t load, disable aggressive ad blockers or refresh.
        </div>
      </div>

      <button
        type="submit"
        disabled={isSubmitting}
        style={{
          marginTop: 14,
          padding: "10px 14px",
          borderRadius: 10,
          border: "1px solid #111",
          background: isSubmitting ? "#444" : "#111",
          color: "#fff",
          fontWeight: 800,
          cursor: isSubmitting ? "not-allowed" : "pointer",
          width: "100%",
        }}
      >
        {isSubmitting ? "Creating…" : "Create Gift"}
      </button>

      {errorText && (
        <div style={{ marginTop: 12, color: "#b00020", fontWeight: 700 }}>
          {errorText}
        </div>
      )}

      {successPublicId && (
        <div style={{ marginTop: 12, color: "#0a7a2f", fontWeight: 800 }}>
          Sent. Public ID: {successPublicId}
        </div>
      )}
    </form>
  );
}
