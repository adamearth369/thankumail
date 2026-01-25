// client/src/pages/Claim.tsx
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
  if (/captcha|turnstile/i.test(m)) return "Please complete the quick verification below.";
  if (/MIN_DELAY/i.test(m) || /wait/i.test(m)) return "Just a moment — we’re securing this gift.";
  if (/already claimed/i.test(m)) return "This ThankuMail has already been claimed.";
  return m;
}

function clampInt(n: any, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.trunc(v) : fallback;
}

export default function Claim() {
  const publicId = getPublicIdFromPath();

  const [gift, setGift] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const [ok, setOk] = useState(false);
  const [alreadyClaimed, setAlreadyClaimed] = useState(false);

  // waiting state (we start countdown BEFORE captcha so user only solves once)
  const [retryAfterSec, setRetryAfterSec] = useState<number>(0);

  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState("");

  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY || "";

  const shouldShowCaptcha = Boolean(siteKey) && !alreadyClaimed && !ok && retryAfterSec <= 0;
  const waitingOnDelay = useMemo(() => retryAfterSec > 0, [retryAfterSec]);

  // Turnstile
  const [turnstileBooting, setTurnstileBooting] = useState<boolean>(!!siteKey);
  const [captchaReady, setCaptchaReady] = useState<boolean>(!siteKey);
  const tokenRef = useRef<string>("");
  const tokenAtRef = useRef<number>(0);
  const widgetIdRef = useRef<any>(null);
  const renderedRef = useRef<boolean>(false);

  function clearTurnstileUi() {
    renderedRef.current = false;
    widgetIdRef.current = null;
    tokenRef.current = "";
    tokenAtRef.current = 0;
    setCaptchaReady(!siteKey); // if no siteKey, it's always "ready"
    const el = document.getElementById("turnstile-container");
    if (el) el.innerHTML = "";
  }

  function hardResetTurnstile() {
    try {
      if (window.turnstile && widgetIdRef.current != null) {
        window.turnstile.reset(widgetIdRef.current);
      }
    } catch {}
    tokenRef.current = "";
    tokenAtRef.current = 0;
    setCaptchaReady(false);
  }

  // Load gift + determine remaining delay from /api/version + gift.createdAt
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError("");

      try {
        const [giftResp, verResp] = await Promise.all([
          fetch(`/api/gifts/${publicId}`),
          fetch(`/api/version`).catch(() => null as any),
        ]);

        const giftJson = await giftResp.json().catch(() => ({} as any));
        if (!giftResp.ok) throw new Error(giftJson?.error || "Failed to load gift");

        if (cancelled) return;

        setGift(giftJson);
        const claimed = Boolean(giftJson?.isClaimed);
        setAlreadyClaimed(claimed);

        // If claimed, lock state and never show captcha
        if (claimed) {
          setRetryAfterSec(0);
          clearTurnstileUi();
          setTurnstileBooting(false);
          setLoading(false);
          return;
        }

        // Compute remaining delay using server-configured minClaimDelaySec
        let minDelaySec = 0;
        try {
          if (verResp) {
            const verJson = await verResp.json().catch(() => ({} as any));
            minDelaySec = clampInt(verJson?.minClaimDelaySec, 0);
          }
        } catch {
          minDelaySec = 0;
        }

        const createdAt = giftJson?.createdAt ? new Date(giftJson.createdAt).getTime() : 0;
        const ageMs = createdAt ? Date.now() - createdAt : 0;
        const remaining = createdAt && minDelaySec > 0 ? Math.max(0, Math.ceil((minDelaySec * 1000 - ageMs) / 1000)) : 0;

        setRetryAfterSec(remaining);

        // IMPORTANT: during countdown we do not render captcha (prevents double solve)
        if (remaining > 0) {
          clearTurnstileUi();
          setTurnstileBooting(false);
        } else {
          // ready for captcha if enabled
          setTurnstileBooting(!!siteKey);
          setCaptchaReady(!siteKey);
        }

        setLoading(false);
      } catch (e: any) {
        if (cancelled) return;
        setError(String(e?.message || "Failed to load gift"));
        setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicId]);

  // Countdown tick
  useEffect(() => {
    if (retryAfterSec <= 0) return;

    const t = window.setInterval(() => {
      setRetryAfterSec((prev) => {
        if (prev <= 1) return 0;
        return prev - 1;
      });
    }, 1000);

    return () => window.clearInterval(t);
  }, [retryAfterSec]);

  // When countdown ends, allow captcha (single solve)
  useEffect(() => {
    if (!siteKey) {
      setCaptchaReady(true);
      setTurnstileBooting(false);
      return;
    }

    if (alreadyClaimed || ok) {
      clearTurnstileUi();
      setTurnstileBooting(false);
      return;
    }

    if (retryAfterSec > 0) {
      // waiting: keep captcha hidden + cleared
      clearTurnstileUi();
      setTurnstileBooting(false);
      return;
    }

    // ready: boot captcha
    setTurnstileBooting(true);
    setCaptchaReady(false);
  }, [siteKey, retryAfterSec, alreadyClaimed, ok]);

  // Load Turnstile script (only when we actually need to show captcha)
  useEffect(() => {
    if (!siteKey) return;
    if (!shouldShowCaptcha) return;

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

  async function handleClaim() {
    if (!publicId) return;
    if (alreadyClaimed || ok) return;

    // During countdown: don't ask for captcha; just wait
    if (waitingOnDelay) {
      setError("Just a moment — we’re securing this gift.");
      return;
    }

    // If captcha is enabled, require a token now (only once, after countdown)
    if (siteKey) {
      if (!captchaReady || !tokenRef.current) {
        setError("Please complete the quick verification below.");
        return;
      }

      // Avoid stale tokens
      const ageMs = Date.now() - (tokenAtRef.current || 0);
      if (ageMs > 60_000) {
        setError("Please complete the quick verification below.");
        hardResetTurnstile();
        return;
      }
    }

    setClaiming(true);
    setError("");

    try {
      const r = await fetch(`/api/gifts/${publicId}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turnstileToken: tokenRef.current || "" }),
      });

      const j = await r.json().catch(() => ({} as any));

      // If server still says wait (clock skew), go back to countdown and hide captcha
      if (r.status === 429 && j?.retryAfterSec) {
        const secs = clampInt(j.retryAfterSec, 0);
        setRetryAfterSec(secs);

        // Hide captcha while waiting so user doesn't solve twice
        clearTurnstileUi();
        setTurnstileBooting(false);
        return;
      }

      if (!r.ok) {
        const code = String(j?.code || "");
        const msg = String(j?.error || "Claim failed");

        if (r.status === 409 || code === "ALREADY_CLAIMED" || /already claimed/i.test(msg)) {
          setAlreadyClaimed(true);
          setError("This ThankuMail has already been claimed.");
          clearTurnstileUi();
          return;
        }

        // Only reset captcha if server explicitly says captcha failed
        if (code === "TURNSTILE_FAILED" || /captcha|turnstile/i.test(msg)) {
          hardResetTurnstile();
        }

        throw new Error(msg);
      }

      setOk(true);
      setAlreadyClaimed(true);
      clearTurnstileUi();

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
    alreadyClaimed ||
    claiming ||
    waitingOnDelay ||
    (siteKey ? !captchaReady : false);

  let buttonText = "Claim gift";
  if (alreadyClaimed) buttonText = "Already claimed";
  else if (claiming) buttonText = "Finalizing…";
  else if (waitingOnDelay) buttonText = `Securing… ${retryAfterSec}s`;
  else if (siteKey && !captchaReady) buttonText = turnstileBooting ? "Loading verification…" : "Verify to claim";

  return (
    <div style={{ maxWidth: 480, margin: "40px auto", padding: 24 }}>
      <h1>You’ve got a ThankuMail</h1>
      <p>Someone left you a note and a gift. Take a breath — it’s meant for you.</p>

      <div style={{ color: "#666", marginBottom: 12 }}>
        For security, there’s a short pause before claiming.
      </div>

      {alreadyClaimed ? (
        <div style={{ color: "#b00020", marginBottom: 12 }}>This ThankuMail has already been claimed.</div>
      ) : error ? (
        <div style={{ color: "#b00020", marginBottom: 12 }}>{error}</div>
      ) : null}

      {!alreadyClaimed && retryAfterSec > 0 ? (
        <div style={{ color: "#666", marginBottom: 12 }}>
          Securing your gift… about {retryAfterSec} seconds.
        </div>
      ) : null}

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

        {alreadyClaimed ? (
          <div style={{ marginTop: 10, color: "#666", fontSize: 13 }}>
            If you believe this is a mistake, ask the sender to create a new ThankuMail.
          </div>
        ) : null}
      </div>
    </div>
  );
}
