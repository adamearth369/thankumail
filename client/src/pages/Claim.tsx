import React, { useEffect, useMemo, useRef, useState } from "react";

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
  if (/captcha/i.test(msg)) return "Please complete the quick verification below.";
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

  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY || "";

  // Turnstile state
  const [turnstileBooting, setTurnstileBooting] = useState<boolean>(!!siteKey);
  const [captchaReady, setCaptchaReady] = useState<boolean>(!siteKey); // if no siteKey, don't block
  const tokenRef = useRef<string>("");
  const tokenAtRef = useRef<number>(0);
  const widgetIdRef = useRef<any>(null);
  const renderedRef = useRef<boolean>(false);

  const waitingOnDelay = useMemo(() => retryAfterSec !== null && retryAfterSec > 0, [retryAfterSec]);

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

  // countdown
  useEffect(() => {
    if (retryAfterSec === null) return;
    if (retryAfterSec <= 0) return;

    const t = window.setInterval(() => {
      setRetryAfterSec((prev) => {
        if (prev === null) return null;
        if (prev <= 1) return 0;
        return prev - 1;
      });
    }, 1000);

    return () => window.clearInterval(t);
  }, [retryAfterSec]);

  function resetTurnstile() {
    try {
      if (window.turnstile && widgetIdRef.current !== null) {
        window.turnstile.reset(widgetIdRef.current);
      }
    } catch {}
    tokenRef.current = "";
    tokenAtRef.current = 0;
    setCaptchaReady(false);
  }

  // Load Turnstile script (once)
  useEffect(() => {
    if (!siteKey) {
      setTurnstileBooting(false);
      setCaptchaReady(true);
      return;
    }

    // if script already present, just mark booting and let render loop pick it up
    const existing = document.querySelector<HTMLScriptElement>('script[data-turnstile="1"]');
    if (existing) return;

    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.setAttribute("data-turnstile", "1");

    script.onload = () => {
      // render loop will handle actual render
      setTurnstileBooting(false);
    };

    script.onerror = () => {
      setTurnstileBooting(false);
      setError("Verification failed to load. Please refresh the page.");
    };

    document.body.appendChild(script);

    return () => {
      // keep script in DOM; no cleanup to avoid reloading on route changes
    };
  }, [siteKey]);

  // Render Turnstile when ready (retry loop)
  useEffect(() => {
    if (!siteKey) return;
    if (renderedRef.current) return;

    let cancelled = false;

    const tryRender = () => {
      if (cancelled) return;

      const ts = window.turnstile;
      const el = document.getElementById("turnstile-container");
      if (!ts || !el) return;

      // Avoid double-render
      if (renderedRef.current) return;

      try {
        setTurnstileBooting(false);

        const id = ts.render("#turnstile-container", {
          sitekey: siteKey,
          callback: (token: string) => {
            tokenRef.current = token || "";
            tokenAtRef.current = Date.now();
            setCaptchaReady(!!token);
            setError("");
          },
          "expired-callback": () => {
            tokenRef.current = "";
            tokenAtRef.current = 0;
            setCaptchaReady(false);
          },
          "error-callback": () => {
            tokenRef.current = "";
            tokenAtRef.current = 0;
            setCaptchaReady(false);
            setError("Verification failed. Please try again.");
          },
        });

        widgetIdRef.current = id;
        renderedRef.current = true;
      } catch {
        // keep retrying
      }
    };

    // Try immediately + retry for ~3 seconds
    tryRender();
    const interval = window.setInterval(tryRender, 150);
    const timeout = window.setTimeout(() => {
      window.clearInterval(interval);
      if (!renderedRef.current) {
        setTurnstileBooting(false);
        setError("Verification didn’t load. Please refresh the page.");
      }
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [siteKey]);

  async function handleClaim() {
    if (!publicId) return;

    if (waitingOnDelay) {
      setError("Just a moment — we’re securing this gift.");
      return;
    }

    if (siteKey) {
      // If token is stale, re-verify (Turnstile tokens can expire quickly)
      const ageMs = Date.now() - (tokenAtRef.current || 0);
      if (!tokenRef.current || ageMs > 45_000) {
        setError("Please complete the quick verification below.");
        resetTurnstile();
        return;
      }
    }

    if (!captchaReady) {
      setError("Please complete the quick verification below.");
      return;
    }

    setClaiming(true);
    setError("");

    try {
      const r = await fetch(`/api/gifts/${publicId}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turnstileToken: tokenRef.current || "" }),
      });

      const j = await r.json();

      if (r.status === 429 && j?.retryAfterSec) {
        setRetryAfterSec(Number(j.retryAfterSec) || 0);
        throw new Error("MIN_DELAY");
      }

      if (!r.ok) throw new Error(j?.error || "Claim failed");

      setOk(true);
    } catch (e: any) {
      const msg = friendlyError(e.message || "Claim failed");
      setError(msg);

      // If captcha-related error, force refresh of widget
      if (/captcha/i.test(String(e?.message || ""))) resetTurnstile();
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
        <p>This moment was meant just for you.</p>
        <p style={{ color: "#666" }}>We hope it brought a little light to your day.</p>
      </div>
    );
  }

  const buttonDisabled = claiming || waitingOnDelay || !captchaReady;

  let buttonText = "Claim gift";
  if (claiming) buttonText = "Finalizing…";
  else if (waitingOnDelay) buttonText = `Securing… ${retryAfterSec}s`;
  else if (!captchaReady) buttonText = turnstileBooting ? "Loading verification…" : "Verify to claim";

  return (
    <div style={{ maxWidth: 480, margin: "40px auto", padding: 24 }}>
      <h1>You’ve got a ThankuMail</h1>
      <p>Someone left you a note and a gift. Take a breath — it’s meant for you.</p>

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

        {siteKey && (
          <div style={{ marginBottom: 12 }}>
            <div id="turnstile-container" />
            {turnstileBooting && (
              <div style={{ color: "#666", marginTop: 8 }}>Loading verification…</div>
            )}
          </div>
        )}

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
