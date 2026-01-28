// WHERE TO PASTE: client/src/pages/Claim.tsx
// ACTION: Full file replacement (paste exactly)

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
  const m = String(msg || "");
  if (!m) return "";
  if (/TURNSTILE_FAILED/i.test(m) || /captcha/i.test(m) || /verification/i.test(m)) {
    return "Verification expired or failed — please verify again.";
  }
  if (/MIN_DELAY/i.test(m) || /wait/i.test(m)) return "One moment — we’re finalizing your gift.";
  if (/already claimed/i.test(m)) return "This ThankuMail has already been claimed.";
  return m;
}

export default function Claim() {
  const publicId = getPublicIdFromPath();

  const [gift, setGift] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // Claim flow
  const [claiming, setClaiming] = useState(false);
  const [armed, setArmed] = useState(false); // when true: countdown -> auto-claim
  const [retryAfterSec, setRetryAfterSec] = useState<number | null>(null);

  // UI state
  const [error, setError] = useState("");
  const [ok, setOk] = useState(false);
  const [alreadyClaimed, setAlreadyClaimed] = useState(false);

  // Turnstile
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY || "";
  const [turnstileBooting, setTurnstileBooting] = useState<boolean>(!!siteKey);
  const [captchaReady, setCaptchaReady] = useState<boolean>(!siteKey);
  const tokenRef = useRef<string>("");
  const widgetIdRef = useRef<any>(null);
  const renderedRef = useRef<boolean>(false);

  const shouldShowCaptcha = Boolean(siteKey) && !alreadyClaimed && !ok;
  const canAttemptClaim = !alreadyClaimed && !ok;

  const waitingOnDelay = useMemo(() => retryAfterSec !== null && retryAfterSec > 0, [retryAfterSec]);

  const amountDollars = useMemo(() => {
    const cents = Number(gift?.amount || 0);
    return Number.isFinite(cents) ? (cents / 100).toFixed(2) : "0.00";
  }, [gift]);

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
        setError(e?.message || "Failed to load gift");
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

  // Auto-claim when armed and countdown completes
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

          if (code === "TURNSTILE_FAILED") {
            hardResetTurnstile();
            setArmed(false);
            setError("Verification expired — please verify again.");
            return;
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
        setError(friendlyError(e?.message || "Claim failed"));
      } finally {
        setClaiming(false);
        setArmed(false);
      }
    })();
  }, [armed, canAttemptClaim, waitingOnDelay, retryAfterSec, publicId]);

  async function handleClaimClick() {
    if (!publicId) return;
    if (!canAttemptClaim) return;

    if (waitingOnDelay) {
      setError("One moment — we’re finalizing your gift.");
      return;
    }

    if (shouldShowCaptcha && !captchaReady) {
      setError("Please complete the quick verification below.");
      return;
    }

    setClaiming(true);
    setError("");

    try {
      const { r, j } = await postClaim();

      if (r.status === 429 && j?.retryAfterSec) {
        setArmed(true);
        setRetryAfterSec(Number(j.retryAfterSec) || 0);
        setClaiming(false);
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

        if (code === "TURNSTILE_FAILED") {
          hardResetTurnstile();
          setArmed(false);
          setError("Verification expired — please verify again.");
          return;
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
      setError(friendlyError(e?.message || "Claim failed"));
    } finally {
      setClaiming(false);
    }
  }

  if (loading) return <div style={{ padding: 32 }}>Loading…</div>;
  if (error && !gift) return <div style={{ padding: 32, color: "#b00020" }}>{error}</div>;

  // SUCCESS: keep it warm + simple + clear
  if (ok) {
    return (
      <div style={{ maxWidth: 520, margin: "40px auto", padding: 24 }}>
        <div style={{ marginBottom: 14, color: "#666" }}>ThankuMail</div>

        <h1 style={{ margin: "0 0 10px 0" }}>It’s yours.</h1>
        <div style={{ color: "#666", marginBottom: 18 }}>
          The note was the heart of it. The gift is the follow-through.
        </div>

        <div style={{ border: "1px solid #eee", borderRadius: 14, padding: 16, background: "#fafafa" }}>
          <div style={{ fontSize: 13, color: "#666", marginBottom: 8 }}>Message</div>
          <div style={{ fontSize: 18, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>{gift?.message || "—"}</div>
        </div>

        <div style={{ marginTop: 14, color: "#666" }}>
          Gift amount: <strong style={{ color: "#111" }}>${amountDollars}</strong>
        </div>

        <div style={{ marginTop: 18, fontSize: 13, color: "#777" }}>
          If you weren’t expecting this, you can ignore it — nothing else is required.
        </div>
      </div>
    );
  }

  const buttonDisabled =
    !canAttemptClaim ||
    claiming ||
    (shouldShowCaptcha ? !captchaReady : false) ||
    (waitingOnDelay ? true : false) ||
    (armed ? true : false);

  let buttonText = "Claim gift";
  if (!canAttemptClaim && alreadyClaimed) buttonText = "Already claimed";
  else if (waitingOnDelay) buttonText = `Finalizing… ${retryAfterSec}s`;
  else if (armed) buttonText = "Finalizing…";
  else if (claiming) buttonText = "Checking…";
  else if (shouldShowCaptcha && !captchaReady) buttonText = turnstileBooting ? "Loading verification…" : "Verify to claim";

  const statusLine = alreadyClaimed
    ? "This ThankuMail has already been claimed."
    : waitingOnDelay || armed
      ? "You’re verified. We’re securing the gift — it will complete automatically."
      : "";

  return (
    <div style={{ maxWidth: 520, margin: "40px auto", padding: 24 }}>
      <div style={{ marginBottom: 14, color: "#666" }}>ThankuMail</div>

      <h1 style={{ margin: "0 0 10px 0" }}>A note for you.</h1>
      <div style={{ color: "#666", marginBottom: 18 }}>
        Read the message first. Claim when you’re ready.
      </div>

      {alreadyClaimed ? (
        <div style={{ color: "#b00020", marginBottom: 12 }}>{statusLine}</div>
      ) : error ? (
        <div style={{ color: "#b00020", marginBottom: 12 }}>{error}</div>
      ) : statusLine ? (
        <div style={{ color: "#111", marginBottom: 12 }}>{statusLine}</div>
      ) : null}

      <div style={{ border: "1px solid #eee", borderRadius: 14, padding: 16, background: "#fafafa", marginBottom: 14 }}>
        <div style={{ fontSize: 13, color: "#666", marginBottom: 8 }}>Message</div>
        <div style={{ fontSize: 18, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>{gift?.message || "—"}</div>
      </div>

      <div style={{ border: "1px solid #ddd", borderRadius: 14, padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
          <div style={{ fontWeight: 800, color: "#111" }}>Gift</div>
          <div style={{ color: "#666", fontSize: 13 }}>
            Amount: <strong style={{ color: "#111" }}>${amountDollars}</strong>
          </div>
        </div>

        <div style={{ color: "#666", fontSize: 13, marginBottom: 12 }}>
          For safety, there’s a quick verification and a short pause before it finalizes.
        </div>

        {shouldShowCaptcha ? (
          <div style={{ marginBottom: 12 }}>
            <div id="turnstile-container" />
            {turnstileBooting ? (
              <div style={{ color: "#666", marginTop: 8 }}>Loading verification…</div>
            ) : captchaReady ? (
              <div style={{ color: "#666", marginTop: 8 }}>Verified ✓</div>
            ) : null}
          </div>
        ) : null}

        {!alreadyClaimed && retryAfterSec !== null && retryAfterSec > 0 && (
          <div style={{ color: "#666", marginBottom: 12 }}>
            Finalizing your gift… about {retryAfterSec} seconds.
          </div>
        )}

        <button
          onClick={handleClaimClick}
          disabled={buttonDisabled}
          style={{
            width: "100%",
            padding: "12px 14px",
            borderRadius: 12,
            border: "none",
            background: "#111",
            color: "#fff",
            fontWeight: 800,
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

        {waitingOnDelay || armed ? (
          <div style={{ marginTop: 10, color: "#666", fontSize: 13 }}>
            No second click needed — this completes automatically.
          </div>
        ) : (
          <div style={{ marginTop: 10, color: "#777", fontSize: 12 }}>
            If you weren’t expecting this, you can ignore it — nothing else is required.
          </div>
        )}
      </div>
    </div>
  );
}
