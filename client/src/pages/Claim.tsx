import React, { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    turnstile?: any;
  }
}

function getPublicIdFromPath() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

function friendlyError(msg: string) {
  if (!msg) return "";
  if (/captcha/i.test(msg)) return "Please verify you’re not a bot.";
  if (/MIN_DELAY/i.test(msg) || /wait/i.test(msg)) return "Just a moment — we’re securing this gift.";
  if (/already claimed/i.test(msg)) return "This ThankuMail has already been claimed.";
  return msg;
}

export default function Claim() {
  const publicId = getPublicIdFromPath();

  const [gift, setGift] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState(false);

  const [retryAfterSec, setRetryAfterSec] = useState<number | null>(null);
  const retryTimerRef = useRef<number | null>(null);

  const [captchaReady, setCaptchaReady] = useState(false);
  const turnstileTokenRef = useRef<string>("");

  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY || "";

  useEffect(() => {
    async function loadGift() {
      try {
        const r = await fetch(`/api/gifts/${publicId}`);
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error || "Failed to load gift");
        setGift(j);
      } catch (e: any) {
        setError(e.message || "Failed to load gift");
      } finally {
        setLoading(false);
      }
    }
    loadGift();
  }, [publicId]);

  useEffect(() => {
    // If no site key is configured, don't block claiming in dev/test.
    if (!siteKey) {
      setCaptchaReady(true);
      return;
    }

    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    script.async = true;
    script.defer = true;
    document.body.appendChild(script);

    return () => {
      document.body.removeChild(script);
    };
  }, [siteKey]);

  useEffect(() => {
    if (!siteKey) return;
    if (!window.turnstile) return;

    window.turnstile.render("#turnstile-container", {
      sitekey: siteKey,
      callback: (token: string) => {
        turnstileTokenRef.current = token;
        setCaptchaReady(true);
        setError("");
      },
      "expired-callback": () => {
        turnstileTokenRef.current = "";
        setCaptchaReady(false);
      },
      "error-callback": () => {
        turnstileTokenRef.current = "";
        setCaptchaReady(false);
      },
    });
  }, [siteKey]);

  useEffect(() => {
    if (retryTimerRef.current) {
      window.clearInterval(retryTimerRef.current);
      retryTimerRef.current = null;
    }

    if (retryAfterSec === null) return;

    retryTimerRef.current = window.setInterval(() => {
      setRetryAfterSec((prev) => {
        if (prev === null) return null;
        if (prev <= 1) {
          if (retryTimerRef.current) {
            window.clearInterval(retryTimerRef.current);
            retryTimerRef.current = null;
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (retryTimerRef.current) {
        window.clearInterval(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [retryAfterSec]);

  async function handleClaim() {
    if (!publicId) return;

    // If we are still counting down, block clicks without throwing errors.
    if (retryAfterSec !== null && retryAfterSec > 0) {
      setError("Just a moment — we’re securing this gift.");
      return;
    }

    if (!captchaReady) {
      setError("Please complete the quick verification below.");
      return;
    }

    const token = turnstileTokenRef.current || "";

    setClaiming(true);
    setError("");

    try {
      const r = await fetch(`/api/gifts/${publicId}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turnstileToken: token }),
      });

      const j = await r.json();

      if (r.status === 429 && j?.retryAfterSec) {
        setRetryAfterSec(Number(j.retryAfterSec) || 0);
        throw new Error("MIN_DELAY");
      }

      if (!r.ok) throw new Error(j?.error || "Claim failed");

      setOk(true);
    } catch (e: any) {
      setError(friendlyError(e.message || "Claim failed"));
    } finally {
      setClaiming(false);
    }
  }

  if (loading) return <div style={{ padding: 32 }}>Loading…</div>;
  if (error && !gift) return <div style={{ padding: 32, color: "#b00020" }}>{error}</div>;

  if (ok) {
    return (
      <div style={{ maxWidth: 480, margin: "40px auto", padding: 24 }}>
        <h2>🎉 You’ve received a ThankuMail</h2>
        <p>
          This moment was meant just for you. Someone took the time to send you a gift and a message.
        </p>
        <p style={{ color: "#666" }}>We hope it brought a little light to your day.</p>
      </div>
    );
  }

  const waitingOnDelay = retryAfterSec !== null && retryAfterSec > 0;
  const buttonDisabled = claiming || waitingOnDelay || !captchaReady;

  let buttonText = "Claim gift";
  if (claiming) buttonText = "Finalizing…";
  else if (!captchaReady) buttonText = "Verify to claim";
  else if (waitingOnDelay) buttonText = `Securing… ${retryAfterSec}s`;

  return (
    <div style={{ maxWidth: 480, margin: "40px auto", padding: 24 }}>
      <h1>You’ve got a ThankuMail</h1>
      <p>Someone left you a note and a gift. Take a breath — it’s meant for you.</p>

      {/* Gentle pre-framing (prevents abandonment) */}
      <div style={{ color: "#666", marginBottom: 12 }}>
        For security, there’s a brief verification and short pause before claiming.
      </div>

      {error && <div style={{ color: "#b00020", marginBottom: 12 }}>{error}</div>}

      {retryAfterSec !== null && retryAfterSec > 0 && (
        <div style={{ color: "#666", marginBottom: 12 }}>
          Finalizing your gift… about {retryAfterSec} seconds.
        </div>
      )}

      <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 16 }}>
        <div style={{ marginBottom: 12 }}>
          <strong>Message</strong>
          <div>{gift?.message || "—"}</div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <strong>Amount</strong>
          <div>${(Number(gift?.amount || 0) / 100).toFixed(2)}</div>
        </div>

        {siteKey && <div id="turnstile-container" style={{ marginBottom: 12 }} />}

        <button
          onClick={handleClaim}
          disabled={buttonDisabled}
          style={{
            width: "100%",
            padding: "10px 14px",
            borderRadius: 10,
            border: "none",
            background: "#111",
            color: "#fff",
            fontWeight: 700,
            cursor: buttonDisabled ? "not-allowed" : "pointer",
            opacity: buttonDisabled ? 0.5 : 1,
          }}
        >
          {buttonText}
        </button>
      </div>
    </div>
  );
}
