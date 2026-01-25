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
  const [alreadyClaimed, setAlreadyClaimed] = useState(false);

  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY || "";

  // Turnstile state
  const [turnstileBooting, setTurnstileBooting] = useState<boolean>(!!siteKey);
  const [captchaReady, setCaptchaReady] = useState<boolean>(!siteKey);
  const tokenRef = useRef<string>("");
  const widgetIdRef = useRef<any>(null);
  const renderedRef = useRef<boolean>(false);

  // NEW: once the user clicks, we "arm" the claim and let countdown -> auto-claim.
  const [armed, setArmed] = useState(false);

  const waitingOnDelay = useMemo(() => retryAfterSec !== null && retryAfterSec > 0, [retryAfterSec]);

  const shouldShowCaptcha = Boolean(siteKey) && !alreadyClaimed && !ok;
  const canAttemptClaim = !alreadyClaimed && !ok;

  // Load gift
  useEffect(() => {
    async function loadGift() {
      try {
        const r = await fetch(`/api/gifts/${publicId}`);
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error || "Failed to load gift");

        setGift(j);
        setAlreadyClaimed(Boolean(j?.isClaimed));
      } catch (e: any) {
        setError(e.message || "Failed to load gift");
      } finally {
        setLoading(false);
      }
    }
    loadGift();
  }, [publicId]);

  // If already claimed, make UI deterministic
  useEffect(() => {
    if (!alreadyClaimed) return;
    setRetryAfterSec(null);
    setClaiming(false);
    setArmed(false);
    tokenRef.current = "";
    setCaptchaReady(!siteKey ? true : false);
  }, [alreadyClaimed, siteKey]);

  // Countdown tick
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

  function hardResetTurnstile() {
    try {
      if (window.turnstile && widgetIdRef.current !== null) {
        window.turnstile.reset(widgetIdRef.current);
      }
    } catch {}
    tokenRef.current = "";
    setCaptchaReady(false);
  }

  // When captcha is hidden/shown, keep deterministic render state
  useEffect(() => {
    if (!siteKey) return;

    if (!shouldShowCaptcha) {
      renderedRef.current = false;
      widgetIdRef.current = null;
      tokenRef.current = "";
      setCaptchaReady(false);
      setTurnstileBooting(false);

      const el = document.getElementById("turnstile-container");
      if (el) el.innerHTML = "";
      return;
    }

    setTurnstileBooting(true);
  }, [siteKey, shouldShowCaptcha]);

  // Load Turnstile script (once)
  useEffect(() => {
    if (!siteKey) {
      setTurnstileBooting(false);
      setCaptchaReady(true);
      return;
    }

    if (!shouldShowCaptcha) {
      setTurnstileBooting(false);
      return;
    }

    if (window.turnstile) {
      setTurnstileBooting(false);
      return;
    }

    const existing = document.querySelector<HTMLScriptElement>('script[data-turnstile="1"]');
    if (existing) {
      setTurnstileBooting(false);
      return;
    }

    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.setAttribute("data-turnstile", "1");

    script.onload = () => setTurnstileBooting(false);
    script.onerror = () => {
      setTurnstileBooting(false);
      setError("Verification failed to load. Please refresh the page.");
    };

    document.body.appendChild(script);
  }, [siteKey, shouldShowCaptcha]);

  // Render Turnstile when ready (retry loop)
  useEffect(() => {
    if (!siteKey) return;
    if (!shouldShowCaptcha) return;
    if (renderedRef.current) return;

    let cancelled = false;

    const tryRender = () => {
      if (cancelled) return;

      const ts = window.turnstile;
      const el = document.getElementById("turnstile-container");
      if (!ts || !el) return;
      if (renderedRef.current) return;

      try {
        setTurnstileBooting(false);

        const id = ts.render("#turnstile-container", {
          sitekey: siteKey,
          callback: (token: string) => {
            tokenRef.current = token || "";
            setCaptchaReady(!!token);
            setError("");
          },
          "expired-callback": () => {
            tokenRef.current = "";
            setCaptchaReady(false);
            setArmed(false);
          },
          "error-callback": () => {
            tokenRef.current = "";
            setCaptchaReady(false);
            setArmed(false);
            setError("Verification failed. Please try again.");
          },
        });

        widgetIdRef.current = id;
        renderedRef.current = true;
      } catch {
        // keep retrying
      }
    };

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
  }, [siteKey, shouldShowCaptcha]);

  async function postClaim() {
    const r = await fetch(`/api/gifts/${publicId}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turnstileToken: tokenRef.current || "" }),
    });

    const j = await r.json().catch(() => ({} as any));
    return { r, j };
  }

  // NEW: if armed and countdown hits 0, auto-claim once.
  useEffect(() => {
    if (!armed) return;
    if (!canAttemptClaim) return;
    if (waitingOnDelay) return;
    if (retryAfterSec !== 0) return;

    (async () => {
      setClaiming(true);
      setError("");

      try {
        const { r, j } = await postClaim();

        if (!r.ok) {
          const code = String(j?.code || "");
          const msg = String(j?.error || "Claim failed");

          if (r.status === 409 || code === "ALREADY_CLAIMED" || /already claimed/i.test(msg)) {
            setAlreadyClaimed(true);
            setError("This ThankuMail has already been claimed.");
            return;
          }

          if (code === "TURNSTILE_FAILED" || /captcha/i.test(msg)) {
            hardResetTurnstile();
            setArmed(false);
          }

          throw new Error(msg);
        }

        setOk(true);
        setAlreadyClaimed(true);

        try {
          const rr = await fetch(`/api/gifts/${publicId}`);
          const jj = await rr.json();
          if (rr.ok) setGift(jj);
        } catch {}
      } catch (e: any) {
        setError(friendlyError(e.message || "Claim failed"));
      } finally {
        setClaiming(false);
        setArmed(false);
      }
    })();
  }, [armed, canAttemptClaim, waitingOnDelay, retryAfterSec, publicId]);

  async function handleClaimClick() {
    if (!publicId) return;
    if (!canAttemptClaim) return;

    if (shouldShowCaptcha && !captchaReady) {
      setError("Please complete the quick verification below.");
      return;
    }

    // If we are already waiting, do nothing (auto-claim will happen).
    if (waitingOnDelay) {
      setError("Just a moment — we’re securing this gift.");
      return;
    }

    setClaiming(true);
    setError("");

    try {
      const { r, j } = await postClaim();

      if (r.status === 429 && j?.retryAfterSec) {
        // ARM + start countdown; DO NOT require another click/captcha.
        setArmed(true);
        setRetryAfterSec(Number(j.retryAfterSec) || 0);
        return;
      }

      if (!r.ok) {
        const code = String(j?.code || "");
        const msg = String(j?.error || "Claim failed");

        if (r.status === 409 || code === "ALREADY_CLAIMED" || /already claimed/i.test(msg)) {
          setAlreadyClaimed(true);
          setError("This ThankuMail has already been claimed.");
          return;
        }

        if (code === "TURNSTILE_FAILED" || /captcha/i.test(msg)) {
          hardResetTurnstile();
        }

        throw new Error(msg);
      }

      setOk(true);
      setAlreadyClaimed(true);

      try {
        const rr = await fetch(`/api/gifts/${publicId}`);
        const jj = await rr.json();
        if (rr.ok) setGift(jj);
      } catch {}
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
        <p>This moment was meant just for you.</p>
        <p style={{ color: "#666" }}>We hope it brought a little light to your day.</p>
      </div>
    );
  }

  const buttonDisabled =
    !canAttemptClaim ||
    claiming ||
    (shouldShowCaptcha ? !captchaReady : false) ||
    (waitingOnDelay ? true : false);

  let buttonText = "Claim gift";
  if (!canAttemptClaim && alreadyClaimed) buttonText = "Already claimed";
  else if (claiming) buttonText = "Finalizing…";
  else if (waitingOnDelay) buttonText = `Securing… ${retryAfterSec}s`;
  else if (shouldShowCaptcha && !captchaReady) buttonText = turnstileBooting ? "Loading verification…" : "Verify to claim";

  return (
    <div style={{ maxWidth: 480, margin: "40px auto", padding: 24 }}>
      <h1>You’ve got a ThankuMail</h1>
      <p>Someone left you a note and a gift. Take a breath — it’s meant for you.</p>

      <div style={{ color: "#666", marginBottom: 12 }}>
        For security, there’s a brief verification and short pause before claiming.
      </div>

      {alreadyClaimed ? (
        <div style={{ color: "#b00020", marginBottom: 12 }}>This ThankuMail has already been claimed.</div>
      ) : error ? (
        <div style={{ color: "#b00020", marginBottom: 12 }}>{error}</div>
      ) : null}

      {!alreadyClaimed && retryAfterSec !== null && retryAfterSec > 0 && (
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

        {shouldShowCaptcha ? (
          <div style={{ marginBottom: 12 }}>
            <div id="turnstile-container" />
            {turnstileBooting ? <div style={{ color: "#666", marginTop: 8 }}>Loading verification…</div> : null}
          </div>
        ) : null}

        <button
          onClick={handleClaimClick}
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

        {alreadyClaimed ? (
          <div style={{ marginTop: 10, color: "#666", fontSize: 13 }}>
            If you believe this is a mistake, ask the sender to create a new ThankuMail.
          </div>
        ) : null}
      </div>
    </div>
  );
}
