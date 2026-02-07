// WHERE TO PASTE: client/src/pages/Claim.tsx
// ACTION: Full file replacement (paste exactly)

import React, { useEffect, useMemo, useRef, useState } from "react";

declare global {
  interface Window {
    turnstile?: any;
  }
}

const API_BASE = "https://api.thankumail.com";

function getPublicIdFromPath() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

function isInvalidLinkSignal(status: number, code: string, msg: string) {
  const c = String(code || "").toUpperCase();
  const m = String(msg || "");
  if (status === 404) return true;
  if (
    c === "NOT_FOUND" ||
    c === "GIFT_NOT_FOUND" ||
    c === "INVALID_TOKEN" ||
    c === "INVALID_OR_EXPIRED" ||
    c === "EXPIRED"
  )
    return true;
  if (/not found/i.test(m)) return true;
  if (/invalid/i.test(m) && /token|link|id/i.test(m)) return true;
  if (/expired/i.test(m) && /link|token|id/i.test(m)) return true;
  if (/invalid or expired/i.test(m)) return true;
  return false;
}

function invalidLinkMessage() {
  return "This ThankuMail link is invalid or expired.";
}

function friendlyError(msg: string) {
  const m = String(msg || "");
  if (!m) return "";

  // IMPORTANT: invalid/expired must always win over verification/captcha wording
  if (
    /not found/i.test(m) ||
    /invalid or expired/i.test(m) ||
    (/invalid/i.test(m) && /token|link|id/i.test(m)) ||
    (/expired/i.test(m) && /link|token|id/i.test(m))
  ) {
    return invalidLinkMessage();
  }

  if (/already claimed/i.test(m)) return "This ThankuMail has already been claimed.";
  if (/MIN_DELAY/i.test(m) || /wait/i.test(m)) return "One moment — we’re finalizing your gift.";

  if (/TURNSTILE_FAILED/i.test(m) || /captcha/i.test(m) || /verification/i.test(m)) {
    return "Verification expired or failed — please verify again.";
  }

  return m;
}

async function safeJson(res: Response) {
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const text = await res.text().catch(() => "");
  if (!ct.includes("application/json")) {
    return { __notJson: true, __status: res.status, __contentType: ct, __text: text };
  }
  try {
    return JSON.parse(text || "{}");
  } catch {
    return { __badJson: true, __status: res.status, __contentType: ct, __text: text };
  }
}

function cn(...xs: Array<string | false | undefined | null>) {
  return xs.filter(Boolean).join(" ");
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

  // Invalid-link latch (prevents Turnstile from ever overriding invalid/expired)
  const invalidRef = useRef<boolean>(false);

  // Turnstile
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY || "";
  const [turnstileBooting, setTurnstileBooting] = useState<boolean>(false);
  const [captchaReady, setCaptchaReady] = useState<boolean>(!siteKey);
  const tokenRef = useRef<string>("");
  const widgetIdRef = useRef<any>(null);
  const renderedRef = useRef<boolean>(false);

  // IMPORTANT: don't boot Turnstile until the gift exists (prevents invalid-token showing captcha errors)
  const shouldShowCaptcha = Boolean(siteKey) && !!gift && !alreadyClaimed && !ok && !invalidRef.current;
  const canAttemptClaim = !!gift && !alreadyClaimed && !ok && !invalidRef.current;

  const waitingOnDelay = useMemo(() => retryAfterSec !== null && retryAfterSec > 0, [retryAfterSec]);

  const amountDollars = useMemo(() => {
    const cents = Number(gift?.amount || 0);
    return Number.isFinite(cents) ? (cents / 100).toFixed(2) : "0.00";
  }, [gift]);

  function lockInvalidLink() {
    invalidRef.current = true;
    setGift(null);
    setAlreadyClaimed(false);
    setOk(false);
    setArmed(false);
    setRetryAfterSec(null);
    setClaiming(false);
    setError(invalidLinkMessage());
  }

  // Load gift (ALWAYS from production API)
  useEffect(() => {
    async function loadGift() {
      setLoading(true);
      invalidRef.current = false;

      try {
        const r = await fetch(`${API_BASE}/api/gifts/${publicId}`, { method: "GET" });
        const j: any = await safeJson(r);

        if (j?.__notJson || j?.__badJson) {
          throw new Error("Claim page misrouted — API returned HTML instead of JSON.");
        }

        if (!r.ok) {
          const code = String(j?.code || "");
          const msg = String(j?.error || "Failed to load gift");
          if (isInvalidLinkSignal(r.status, code, msg)) {
            lockInvalidLink();
            return;
          }
          throw new Error(msg);
        }

        setGift(j);
        setAlreadyClaimed(Boolean(j?.isClaimed));
        setError("");
      } catch (e: any) {
        const msg = String(e?.message || "Failed to load gift");
        if (
          /not found/i.test(msg) ||
          /invalid or expired/i.test(msg) ||
          (/invalid/i.test(msg) && /token|link|id/i.test(msg)) ||
          (/expired/i.test(msg) && /link|token|id/i.test(msg))
        ) {
          lockInvalidLink();
          return;
        }
        setError(friendlyError(msg));
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
      if (!invalidRef.current) setError("Verification failed to load. Please refresh the page.");
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
            if (invalidRef.current) return;
            tokenRef.current = token || "";
            setCaptchaReady(!!token);
            setError("");
          },
          "expired-callback": () => {
            if (invalidRef.current) return;
            tokenRef.current = "";
            setCaptchaReady(false);
            setArmed(false);
          },
          "error-callback": () => {
            if (invalidRef.current) return;
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
        if (!invalidRef.current) setError("Verification didn’t load. Please refresh the page.");
      }
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [siteKey, shouldShowCaptcha]);

  async function postClaim() {
    const r = await fetch(`${API_BASE}/api/gifts/${publicId}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turnstileToken: tokenRef.current || "" }),
    });

    const j: any = await safeJson(r);
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

        if (j?.__notJson || j?.__badJson) {
          throw new Error("Claim page misrouted — API returned HTML instead of JSON.");
        }

        if (!r.ok) {
          const code = String(j?.code || "");
          const msg = String(j?.error || "Claim failed");

          if (isInvalidLinkSignal(r.status, code, msg)) {
            lockInvalidLink();
            return;
          }

          if (r.status === 409 || code === "ALREADY_CLAIMED" || /already claimed/i.test(msg)) {
            setAlreadyClaimed(true);
            setError("This ThankuMail has already been claimed.");
            return;
          }

          if (code === "TURNSTILE_FAILED") {
            hardResetTurnstile();
            setArmed(false);
            if (!invalidRef.current) setError("Verification expired — please verify again.");
            return;
          }

          throw new Error(msg);
        }

        setOk(true);
        setAlreadyClaimed(true);

        try {
          const rr = await fetch(`${API_BASE}/api/gifts/${publicId}`);
          const jj: any = await safeJson(rr);
          if (rr.ok && !(jj?.__notJson || jj?.__badJson)) setGift(jj);
        } catch {}
      } catch (e: any) {
        if (!invalidRef.current) setError(friendlyError(e?.message || "Claim failed"));
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

      if (j?.__notJson || j?.__badJson) {
        throw new Error("Claim page misrouted — API returned HTML instead of JSON.");
      }

      if (r.status === 429 && j?.retryAfterSec) {
        setArmed(true);
        setRetryAfterSec(Number(j.retryAfterSec) || 0);
        setClaiming(false);
        return;
      }

      if (!r.ok) {
        const code = String(j?.code || "");
        const msg = String(j?.error || "Claim failed");

        if (isInvalidLinkSignal(r.status, code, msg)) {
          lockInvalidLink();
          return;
        }

        if (r.status === 409 || code === "ALREADY_CLAIMED" || /already claimed/i.test(msg)) {
          setAlreadyClaimed(true);
          setError("This ThankuMail has already been claimed.");
          return;
        }

        if (code === "TURNSTILE_FAILED") {
          hardResetTurnstile();
          setArmed(false);
          if (!invalidRef.current) setError("Verification expired — please verify again.");
          return;
        }

        throw new Error(msg);
      }

      setOk(true);
      setAlreadyClaimed(true);

      try {
        const rr = await fetch(`${API_BASE}/api/gifts/${publicId}`);
        const jj: any = await safeJson(rr);
        if (rr.ok && !(jj?.__notJson || jj?.__badJson)) setGift(jj);
      } catch {}
    } catch (e: any) {
      if (!invalidRef.current) setError(friendlyError(e?.message || "Claim failed"));
    } finally {
      setClaiming(false);
    }
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

  if (loading) {
    return (
      <div className="min-h-[70vh] flex items-center justify-center px-6">
        <div className="w-full max-w-md rounded-2xl border border-tm-cream/30 bg-white/70 backdrop-blur p-6 shadow-soft">
          <div className="text-sm text-tm-charcoal/60 mb-2">ThankuMail</div>
          <div className="font-outfit text-2xl text-tm-charcoal">Loading…</div>
          <div className="mt-3 text-sm text-tm-charcoal/70">Just a moment.</div>
        </div>
      </div>
    );
  }

  if ((error && !gift) || invalidRef.current) {
    return (
      <div className="min-h-[70vh] flex items-center justify-center px-6">
        <div className="w-full max-w-md rounded-2xl border border-red-200 bg-red-50 p-6">
          <div className="text-sm text-red-800 font-medium mb-1">Couldn’t open this ThankuMail</div>
          <div className="text-sm text-red-700">{error || invalidLinkMessage()}</div>
        </div>
      </div>
    );
  }

  // SUCCESS
  if (ok) {
    return (
      <div className="min-h-[70vh] flex items-start justify-center px-6 py-10">
        <div className="w-full max-w-xl">
          <div className="rounded-2xl border border-tm-cream/30 bg-white/70 backdrop-blur p-6 shadow-soft">
            <div className="text-sm text-tm-charcoal/60">ThankuMail</div>

            <h1 className="mt-2 font-outfit text-3xl text-tm-charcoal">It’s yours.</h1>
            <p className="mt-2 text-tm-charcoal/70">The note was the heart of it. The gift is the follow-through.</p>

            <div className="mt-5 rounded-2xl border border-tm-cream/40 bg-white p-5">
              <div className="text-xs uppercase tracking-wide text-tm-charcoal/60 mb-2">Message</div>
              <div className="text-lg leading-relaxed text-tm-charcoal whitespace-pre-wrap">{gift?.message || "—"}</div>
            </div>

            <div className="mt-5 flex items-center justify-between gap-3 rounded-2xl border border-tm-cream/40 bg-tm-cream/20 p-4">
              <div className="text-sm text-tm-charcoal/70">Gift amount</div>
              <div className="font-outfit text-2xl text-tm-charcoal">${amountDollars}</div>
            </div>

            <div className="mt-5 text-xs text-tm-charcoal/60">
              If you weren’t expecting this, you can ignore it — nothing else is required.
            </div>
          </div>
        </div>
      </div>
    );
  }

  // CLAIM PAGE
  return (
    <div className="min-h-[70vh] flex items-start justify-center px-6 py-10">
      <div className="w-full max-w-xl">
        <div className="rounded-2xl border border-tm-cream/30 bg-white/70 backdrop-blur p-6 shadow-soft">
          <div className="text-sm text-tm-charcoal/60">ThankuMail</div>

          <h1 className="mt-2 font-outfit text-3xl text-tm-charcoal">A note for you.</h1>
          <p className="mt-2 text-tm-charcoal/70">Read the message first. Claim when you’re ready.</p>

          {alreadyClaimed ? (
            <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              {statusLine || "This ThankuMail has already been claimed."}
            </div>
          ) : error ? (
            <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
          ) : statusLine ? (
            <div className="mt-4 rounded-2xl border border-tm-cream/40 bg-tm-cream/20 px-4 py-3 text-sm text-tm-charcoal">
              {statusLine}
            </div>
          ) : null}

          <div className="mt-5 rounded-2xl border border-tm-cream/40 bg-white p-5">
            <div className="text-xs uppercase tracking-wide text-tm-charcoal/60 mb-2">Message</div>
            <div className="text-lg leading-relaxed text-tm-charcoal whitespace-pre-wrap">{gift?.message || "—"}</div>
          </div>

          <div className="mt-5 rounded-2xl border border-tm-cream/40 bg-white p-5">
            <div className="flex items-end justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-tm-charcoal">Gift</div>
                <div className="mt-1 text-xs text-tm-charcoal/60">
                  For safety, there’s a quick verification and a short pause before it finalizes.
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs text-tm-charcoal/60">Amount</div>
                <div className="font-outfit text-2xl text-tm-charcoal">${amountDollars}</div>
              </div>
            </div>

            {shouldShowCaptcha ? (
              <div className="mt-4">
                <div className="rounded-2xl border border-tm-cream/40 bg-white p-4">
                  <div id="turnstile-container" />
                  {turnstileBooting ? (
                    <div className="mt-2 text-xs text-tm-charcoal/60">Loading verification…</div>
                  ) : captchaReady ? (
                    <div className="mt-2 text-xs text-tm-charcoal/60">Verified ✓</div>
                  ) : null}
                </div>
              </div>
            ) : null}

            {!alreadyClaimed && retryAfterSec !== null && retryAfterSec > 0 ? (
              <div className="mt-4 text-sm text-tm-charcoal/70">Finalizing your gift… about {retryAfterSec} seconds.</div>
            ) : null}

            <button
              onClick={handleClaimClick}
              disabled={buttonDisabled}
              className={cn(
                "mt-4 w-full rounded-2xl px-4 py-3 font-medium transition shadow-soft",
                buttonDisabled ? "bg-tm-cream/60 text-tm-charcoal/50 cursor-not-allowed" : "bg-tm-amber text-tm-charcoal hover:opacity-95"
              )}
            >
              {buttonText}
            </button>

            {alreadyClaimed ? (
              <div className="mt-3 text-xs text-tm-charcoal/60">If you believe this is a mistake, ask the sender to create a new ThankuMail.</div>
            ) : waitingOnDelay || armed ? (
              <div className="mt-3 text-xs text-tm-charcoal/60">No second click needed — this completes automatically.</div>
            ) : (
              <div className="mt-3 text-xs text-tm-charcoal/60">If you weren’t expecting this, you can ignore it — nothing else is required.</div>
            )}
          </div>
        </div>

        <div className="mt-4 text-center text-xs text-tm-charcoal/50">
          ThankuMail is about the message first — the gift is just the follow-through.
        </div>
      </div>
    </div>
  );
}
