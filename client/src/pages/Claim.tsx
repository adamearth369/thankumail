// WHERE TO PASTE: client/src/pages/Claim.tsx
// ACTION: Full file replacement (paste exactly)

import React, { useEffect, useMemo, useRef, useState } from "react";
import confetti from "canvas-confetti";

const API_BASE = "https://api.thankumail.com";

const TURNSTILE_SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

// Fallback (Cloudflare test key)
const FALLBACK_TURNSTILE_SITE_KEY = "0x4AAAAAACXaTgda6akpnmmC";

const FONT_BODY =
  "'DM Sans', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, 'Apple Color Emoji', 'Segoe UI Emoji', sans-serif";
const FONT_TITLE =
  "'Outfit', 'DM Sans', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, 'Apple Color Emoji', 'Segoe UI Emoji', sans-serif";
const FONT_WORDMARK =
  "'Quicksand', 'DM Sans', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, 'Apple Color Emoji', 'Segoe UI Emoji', sans-serif";

const PRESET_MESSAGES: Record<number, string> = {
  1: "I just wanted you to know how much you are appreciated. Thank you for being you.",
  2: "Your support made a bigger difference than you realize. I’m truly grateful.",
  3: "You showed up when it mattered most. That means everything. Thank you.",
  4: "Your kindness hasn’t gone unnoticed — I’m sincerely thankful for you.",
  5: "You mattered more in that moment than you probably realized. Thank you.",
  6: "What you did made a positive difference for those around you. I’m grateful. Thank you.",
};

function getTurnstile(): any {
  return (window as any).turnstile;
}

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
  return "This thankümail link is invalid or expired.";
}

function friendlyError(msg: string) {
  const m = String(msg || "");
  if (!m) return "";

  if (
    /not found/i.test(m) ||
    /invalid or expired/i.test(m) ||
    (/invalid/i.test(m) && /token|link|id/i.test(m)) ||
    (/expired/i.test(m) && /link|token|link|id/i.test(m))
  ) {
    return invalidLinkMessage();
  }

  if (/already claimed/i.test(m)) return "This thankümail has already been claimed.";

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

function fireConfettiBurst() {
  try {
    const defaults = { origin: { y: 0.75 } };
    confetti({ ...defaults, particleCount: 110, spread: 70, startVelocity: 45 });
    confetti({ ...defaults, particleCount: 55, spread: 120, startVelocity: 35 });
    confetti({ ...defaults, particleCount: 30, spread: 160, startVelocity: 25 });
  } catch {
    // ignore
  }
}

function unwrapGiftPayload(j: any) {
  // API returns either gift object, or { ok:true, gift:{...}, version:"..." }
  return j?.gift && typeof j.gift === "object" ? j.gift : j;
}

export default function Claim() {
  const publicId = getPublicIdFromPath();

  const TURNSTILE_SITE_KEY = useMemo(() => {
    const envKey = (import.meta as any)?.env?.VITE_TURNSTILE_SITE_KEY
      ? String((import.meta as any).env.VITE_TURNSTILE_SITE_KEY)
      : "";
    return (envKey || FALLBACK_TURNSTILE_SITE_KEY || "").trim();
  }, []);

  const turnstileConfigured = TURNSTILE_SITE_KEY.length > 0;

  const [gift, setGift] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const [claiming, setClaiming] = useState(false);

  const [retryAfterSec, setRetryAfterSec] = useState<number | null>(null);
  const retryTimerRef = useRef<number | null>(null);

  const [error, setError] = useState("");
  const [ok, setOk] = useState(false);
  const [alreadyClaimed, setAlreadyClaimed] = useState(false);

  const invalidRef = useRef<boolean>(false);

  const [turnstileBooting, setTurnstileBooting] = useState<boolean>(false);
  const [captchaReady, setCaptchaReady] = useState<boolean>(false);

  const tokenRef = useRef<string>("");
  const widgetIdRef = useRef<any>(null);
  const renderedRef = useRef<boolean>(false);
  const [captchaRendered, setCaptchaRendered] = useState<boolean>(false);

  const [captchaBlocked, setCaptchaBlocked] = useState<boolean>(false);

  const confettiFiredRef = useRef<boolean>(false);

  const turnstileHostRef = useRef<HTMLDivElement | null>(null);

  const messageText = useMemo(() => {
    const m = String(gift?.message || "").trim();
    if (m) return m;
    const presetId = Number(gift?.presetMessageId || 0) || 0;
    return PRESET_MESSAGES[presetId] || "—";
  }, [gift]);

  const amountCents = useMemo(() => {
    const v = gift?.amount;
    if (v === null || v === undefined || v === "") return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }, [gift]);

  const hasAmount = useMemo(() => amountCents > 0, [amountCents]);

  const amountDollars = useMemo(() => {
    if (!hasAmount) return "";
    return (amountCents / 100).toFixed(2);
  }, [amountCents, hasAmount]);

  const waitingOnDelay = useMemo(() => {
    if (!hasAmount) return false;
    return retryAfterSec !== null && retryAfterSec > 0;
  }, [hasAmount, retryAfterSec]);

  const needsClaimFlow = !!gift && !alreadyClaimed && !ok && !invalidRef.current;

  // ✅ FIX: Only require Turnstile for amount claims (registered gift flow)
  const shouldShowCaptcha = turnstileConfigured && needsClaimFlow && hasAmount;

  const canAttemptClaim = !!gift && !alreadyClaimed && !ok && !invalidRef.current;

  function lockInvalidLink() {
    invalidRef.current = true;
    setGift(null);
    setAlreadyClaimed(false);
    setOk(false);
    setRetryAfterSec(null);
    setClaiming(false);
    setError(invalidLinkMessage());
  }

  useEffect(() => {
    if (!ok) return;
    if (confettiFiredRef.current) return;
    confettiFiredRef.current = true;
    fireConfettiBurst();
  }, [ok]);

  useEffect(() => {
    async function loadGift() {
      setLoading(true);
      invalidRef.current = false;
      confettiFiredRef.current = false;

      setOk(false);

      try {
        const r = await fetch(`${API_BASE}/api/gifts/${publicId}`, { method: "GET" });
        const j: any = await safeJson(r);

        if (j?.__notJson || j?.__badJson) {
          throw new Error("Claim page misrouted — API returned HTML instead of JSON.");
        }

        if (!r.ok) {
          const code = String(j?.code || "");
          const msg = String(j?.error || "Failed to load thankümail");
          if (isInvalidLinkSignal(r.status, code, msg)) {
            lockInvalidLink();
            return;
          }
          throw new Error(msg);
        }

        const g = unwrapGiftPayload(j);

        setGift(g);

        const claimed = Boolean(g?.isClaimed);
        setAlreadyClaimed(claimed);

        setError("");
      } catch (e: any) {
        const msg = String(e?.message || "Failed to load thankümail");
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

  useEffect(() => {
    if (!alreadyClaimed) return;
    setRetryAfterSec(null);
    setClaiming(false);
    tokenRef.current = "";
    setCaptchaReady(false);
    setCaptchaRendered(false);
    setCaptchaBlocked(false);
  }, [alreadyClaimed]);

  useEffect(() => {
    if (!hasAmount) return;
    if (retryAfterSec === null) return;
    if (retryAfterSec <= 0) return;

    if (retryTimerRef.current) {
      window.clearInterval(retryTimerRef.current);
      retryTimerRef.current = null;
    }

    const t = window.setInterval(() => {
      setRetryAfterSec((prev) => {
        if (prev === null) return null;
        if (prev <= 1) return 0;
        return prev - 1;
      });
    }, 1000);

    retryTimerRef.current = t as any;

    return () => {
      if (retryTimerRef.current) {
        window.clearInterval(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [hasAmount, retryAfterSec]);

  function hardResetTurnstile() {
    try {
      const ts = getTurnstile();
      if (ts && widgetIdRef.current !== null && ts.reset) {
        ts.reset(widgetIdRef.current);
      }
    } catch {}
    tokenRef.current = "";
    setCaptchaReady(false);
    setCaptchaBlocked(false);
  }

  useEffect(() => {
    // If captcha isn't needed, fully reset UI state.
    if (!shouldShowCaptcha) {
      renderedRef.current = false;
      widgetIdRef.current = null;
      tokenRef.current = "";
      setCaptchaReady(false);
      setTurnstileBooting(false);
      setCaptchaRendered(false);
      setCaptchaBlocked(false);
      return;
    }

    setTurnstileBooting(true);
    setCaptchaRendered(false);
    setCaptchaBlocked(false);
  }, [shouldShowCaptcha]);

  useEffect(() => {
    if (!shouldShowCaptcha) return;

    if (getTurnstile()) {
      setTurnstileBooting(false);
      return;
    }

    const existing = document.querySelector<HTMLScriptElement>('script[data-turnstile="1"]');
    if (existing) {
      setTurnstileBooting(false);
      return;
    }

    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.setAttribute("data-turnstile", "1");

    script.onload = () => setTurnstileBooting(false);
    script.onerror = () => {
      setTurnstileBooting(false);
      setCaptchaBlocked(true);
      if (!invalidRef.current) setError("");
    };

    document.body.appendChild(script);
  }, [shouldShowCaptcha]);

  useEffect(() => {
    if (!shouldShowCaptcha) return;

    let cancelled = false;
    let tokenPoll: number | null = null;

    const syncTokenFromHiddenInput = () => {
      if (cancelled) return;
      try {
        const host = turnstileHostRef.current;
        if (!host) return;
        const input = host.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]');
        if (!input) return;
        const token = String(input.value || "");
        if (token && token.length > 50) {
          tokenRef.current = token;
          setCaptchaReady(true);
          setCaptchaBlocked(false);
          setError("");
          try {
            (window as any).__tm_turnstile = {
              rendered: true,
              widgetId: widgetIdRef.current,
              tokenLen: token.length,
              source: "hidden_input",
            };
          } catch {}
        }
      } catch {
        // ignore
      }
    };

    const tryRender = () => {
      if (cancelled) return;
      if (renderedRef.current) return;

      const ts = getTurnstile();
      const host = turnstileHostRef.current;

      if (!ts || !host) return;

      try {
        setTurnstileBooting(false);
        host.innerHTML = "";

        const id = ts.render(host, {
          sitekey: TURNSTILE_SITE_KEY,
          appearance: "always",
          size: "normal",
          callback: (token: string) => {
            if (invalidRef.current) return;
            tokenRef.current = token || "";
            setCaptchaReady(!!token);
            setCaptchaBlocked(false);
            setError("");
            try {
              (window as any).__tm_turnstile = {
                rendered: true,
                widgetId: id,
                tokenLen: (token || "").length,
                source: "callback",
              };
            } catch {}
          },
          "expired-callback": () => {
            if (invalidRef.current) return;
            tokenRef.current = "";
            setCaptchaReady(false);
          },
          "error-callback": () => {
            if (invalidRef.current) return;
            tokenRef.current = "";
            setCaptchaReady(false);
            setCaptchaBlocked(true);
            setError("");
          },
        });

        widgetIdRef.current = id;
        renderedRef.current = true;
        setCaptchaRendered(true);

        window.setTimeout(() => {
          if (cancelled) return;
          try {
            const token = ts?.getResponse ? String(ts.getResponse(id) || "") : "";
            if (token && token.length > 50) {
              tokenRef.current = token;
              setCaptchaReady(true);
              setCaptchaBlocked(false);
              setError("");
              try {
                (window as any).__tm_turnstile = {
                  rendered: true,
                  widgetId: id,
                  tokenLen: token.length,
                  source: "getResponse",
                };
              } catch {}
            }
          } catch {}
        }, 300);

        if (tokenPoll) window.clearInterval(tokenPoll);
        tokenPoll = window.setInterval(syncTokenFromHiddenInput, 250) as any;

        window.setTimeout(() => {
          if (tokenPoll) {
            window.clearInterval(tokenPoll);
            tokenPoll = null;
          }
        }, 10000);

        window.setTimeout(syncTokenFromHiddenInput, 150);
        window.setTimeout(syncTokenFromHiddenInput, 600);
        window.setTimeout(syncTokenFromHiddenInput, 1200);
      } catch {
        // retry
      }
    };

    tryRender();
    const interval = window.setInterval(tryRender, 150);

    const timeout = window.setTimeout(() => {
      window.clearInterval(interval);
      if (!renderedRef.current) {
        setTurnstileBooting(false);
        setCaptchaBlocked(true);
        setError("");
      }
    }, 3500);

    return () => {
      cancelled = true;
      if (tokenPoll) {
        window.clearInterval(tokenPoll);
        tokenPoll = null;
      }
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [shouldShowCaptcha, TURNSTILE_SITE_KEY]);

  async function postClaim() {
    const body: any = {};
    // Only send turnstile token when captcha is actually required
    if (shouldShowCaptcha) body.turnstileToken = tokenRef.current || "";

    const r = await fetch(`${API_BASE}/api/gifts/${publicId}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const j: any = await safeJson(r);
    return { r, j };
  }

  async function refreshGiftSilently() {
    try {
      const rr = await fetch(`${API_BASE}/api/gifts/${publicId}`);
      const jj: any = await safeJson(rr);
      if (rr.ok && !(jj?.__notJson || jj?.__badJson)) {
        const g = unwrapGiftPayload(jj);
        setGift(g);
        setAlreadyClaimed(Boolean(g?.isClaimed));
      }
    } catch {}
  }

  useEffect(() => {
    if (!hasAmount) return;
    if (retryAfterSec === null) return;
    if (retryAfterSec !== 0) return;
    if (!canAttemptClaim) return;

    (async () => {
      setClaiming(true);
      setError("");
      try {
        const claimedBefore = Boolean(gift?.isClaimed) || alreadyClaimed;

        const { r, j } = await postClaim();

        if (j?.__notJson || j?.__badJson) {
          throw new Error("Claim page misrouted — API returned HTML instead of JSON.");
        }

        const payload = unwrapGiftPayload(j);

        if (!r.ok) {
          const code = String(j?.code || "");
          const msg = String(j?.error || "Claim failed");

          if (isInvalidLinkSignal(r.status, code, msg)) {
            lockInvalidLink();
            return;
          }

          if (r.status === 409 || code === "ALREADY_CLAIMED" || /already claimed/i.test(msg)) {
            setAlreadyClaimed(true);
            setOk(false);
            setError("");
            await refreshGiftSilently();
            return;
          }

          if (code === "TURNSTILE_FAILED") {
            hardResetTurnstile();
            if (!invalidRef.current) setError("Verification expired — please verify again.");
            return;
          }

          throw new Error(msg);
        }

        if (claimedBefore || Boolean(payload?.isClaimed && gift?.isClaimed)) {
          setAlreadyClaimed(true);
          setOk(false);
          setError("");
          await refreshGiftSilently();
          return;
        }

        setOk(true);
        setAlreadyClaimed(true);
        setError("");
        await refreshGiftSilently();
      } catch (e: any) {
        if (!invalidRef.current) setError(friendlyError(e?.message || "Claim failed"));
      } finally {
        setClaiming(false);
        setRetryAfterSec(null);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAmount, retryAfterSec, canAttemptClaim, needsClaimFlow, shouldShowCaptcha]);

  async function handleClaimClick() {
    if (!publicId) return;
    if (!canAttemptClaim) return;

    if (shouldShowCaptcha && !captchaReady) {
      setError("Please complete the quick verification below.");
      return;
    }

    setClaiming(true);
    setError("");

    try {
      const claimedBefore = Boolean(gift?.isClaimed) || alreadyClaimed;

      const { r, j } = await postClaim();

      if (j?.__notJson || j?.__badJson) {
        throw new Error("Claim page misrouted — API returned HTML instead of JSON.");
      }

      const payload = unwrapGiftPayload(j);

      if (hasAmount && r.status === 429 && j?.retryAfterSec) {
        const sec = Math.max(0, Number(j.retryAfterSec) || 0);
        setRetryAfterSec(sec);
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
          setOk(false);
          setError("");
          await refreshGiftSilently();
          return;
        }

        if (code === "TURNSTILE_FAILED") {
          hardResetTurnstile();
          if (!invalidRef.current) setError("Verification expired — please verify again.");
          return;
        }

        throw new Error(msg);
      }

      if (claimedBefore || Boolean(payload?.isClaimed && gift?.isClaimed)) {
        setAlreadyClaimed(true);
        setOk(false);
        setError("");
        await refreshGiftSilently();
        return;
      }

      setOk(true);
      setAlreadyClaimed(true);
      setError("");
      await refreshGiftSilently();
    } catch (e: any) {
      if (!invalidRef.current) setError(friendlyError(e?.message || "Claim failed"));
    } finally {
      setClaiming(false);
    }
  }

  const shellStyle: React.CSSProperties = {
    fontFamily: FONT_BODY,
    WebkitFontSmoothing: "antialiased",
    MozOsxFontSmoothing: "grayscale",
    textRendering: "optimizeLegibility",
  };

  if (loading) {
    return (
      <div
        className="min-h-screen text-white bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: "url('/images/hero-background.png')" }}
      >
        <div className="min-h-screen bg-black/40" style={shellStyle}>
          <div className="mx-auto max-w-5xl px-4 pt-10 pb-16">
            <div className="w-full max-w-md mx-auto rounded-2xl bg-white/95 backdrop-blur shadow-soft border border-white/20 p-6 text-slate-900">
              <div className="text-sm text-slate-500 mb-2" style={{ fontFamily: FONT_WORDMARK, fontWeight: 600 }}>
                thankümail
              </div>
              <div style={{ fontFamily: FONT_TITLE, fontWeight: 800 }} className="text-2xl text-slate-900">
                Loading…
              </div>
              <div className="mt-3 text-sm text-slate-600">Just a moment.</div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if ((error && !gift) || invalidRef.current) {
    return (
      <div
        className="min-h-screen text-white bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: "url('/images/hero-background.png')" }}
      >
        <div className="min-h-screen bg-black/40" style={shellStyle}>
          <div className="mx-auto max-w-5xl px-4 pt-10 pb-16">
            <div className="w-full max-w-md mx-auto rounded-2xl border border-red-200 bg-red-50 p-6 text-slate-900">
              <div className="text-sm text-red-800 font-medium mb-1">Couldn’t open this thankümail</div>
              <div className="text-sm text-red-700">{error || invalidLinkMessage()}</div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (ok) {
    if (!confettiFiredRef.current) {
      confettiFiredRef.current = true;
      fireConfettiBurst();
    }

    return (
      <div
        className="min-h-screen text-white bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: "url('/images/hero-background.png')" }}
      >
        <div className="min-h-screen bg-black/40" style={shellStyle}>
          <main className="mx-auto max-w-5xl px-4 pt-10 pb-16">
            <div className="w-full max-w-xl mx-auto rounded-2xl bg-white/95 backdrop-blur shadow-soft border border-white/20 p-6 text-slate-900">
              <div className="text-sm text-slate-500" style={{ fontFamily: FONT_WORDMARK, fontWeight: 600 }}>
                thankümail
              </div>

              <h1
                className="mt-2 text-3xl md:text-4xl text-slate-900 tracking-tight"
                style={{ fontFamily: FONT_TITLE, fontWeight: 800 }}
              >
                Received.
              </h1>

              <p className="mt-2 text-slate-700 text-[15px] leading-relaxed md:text-base">
                {hasAmount ? "The note was the heart of it. The gift will finalize shortly." : "The note was the heart of it."}
              </p>

              <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-5">
                <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">Message</div>
                <div className="text-[17px] md:text-lg leading-relaxed text-slate-900 whitespace-pre-wrap">
                  {messageText}
                </div>
              </div>

              {hasAmount ? (
                <div className="mt-5 flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="text-sm text-slate-700">Gift amount</div>
                  <div className="text-2xl text-slate-900" style={{ fontFamily: FONT_TITLE, fontWeight: 800 }}>
                    ${amountDollars}
                  </div>
                </div>
              ) : null}
            </div>
          </main>
        </div>
      </div>
    );
  }

  let buttonText = hasAmount ? "Claim gift" : "Accept thankümail";
  if (!canAttemptClaim && alreadyClaimed) buttonText = "Already claimed";
  else if (hasAmount && retryAfterSec !== null && retryAfterSec > 0) buttonText = `Finalizing… ${retryAfterSec}s`;
  else if (claiming) buttonText = "Checking…";
  else if (shouldShowCaptcha && !captchaReady) {
    buttonText = !captchaRendered || turnstileBooting ? "Loading verification…" : "Verify to continue";
  }

  const buttonDisabled =
    !canAttemptClaim ||
    claiming ||
    (shouldShowCaptcha ? !captchaReady : false) ||
    (waitingOnDelay ? true : false);

  return (
    <div
      className="min-h-screen text-white bg-cover bg-center bg-no-repeat"
      style={{ backgroundImage: "url('/images/hero-background.png')" }}
    >
      <div className="min-h-screen bg-black/40" style={shellStyle}>
        <main className="mx-auto max-w-5xl px-4 pt-10 pb-16">
          <div className="w-full max-w-xl mx-auto rounded-2xl bg-white/95 backdrop-blur shadow-soft border border-white/20 p-6 text-slate-900">
            <div className="text-sm text-slate-500" style={{ fontFamily: FONT_WORDMARK, fontWeight: 600 }}>
              thankümail
            </div>

            <h1
              className="mt-2 text-3xl md:text-4xl text-slate-900 tracking-tight"
              style={{ fontFamily: FONT_TITLE, fontWeight: 800 }}
            >
              A note for you.
            </h1>

            <p className="mt-2 text-slate-700 text-[15px] leading-relaxed md:text-base">
              Read the message first. {hasAmount ? "Claim when you’re ready." : "Accept when you’re ready."}
            </p>

            {alreadyClaimed ? (
              <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                This thankümail has already been claimed.
              </div>
            ) : error ? (
              <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                {error}
              </div>
            ) : null}

            <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-5">
              <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">Message</div>
              <div className="text-[17px] md:text-lg leading-relaxed text-slate-900 whitespace-pre-wrap">
                {messageText}
              </div>
            </div>

            <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-5">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-slate-900">{hasAmount ? "Gift" : "Accept"}</div>
                  <div className="mt-1 text-xs text-slate-600 leading-relaxed">
                    {hasAmount
                      ? "For safety, there’s a quick verification and a short pause before it finalizes."
                      : "Tap below to accept."}
                  </div>
                </div>

                {hasAmount ? (
                  <div className="text-right">
                    <div className="text-xs text-slate-500">Amount</div>
                    <div className="text-2xl text-slate-900" style={{ fontFamily: FONT_TITLE, fontWeight: 800 }}>
                      ${amountDollars}
                    </div>
                  </div>
                ) : null}
              </div>

              {shouldShowCaptcha ? (
                <div className="mt-4">
                  <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <div
                      id="tm-claim-turnstile"
                      ref={turnstileHostRef}
                      className="min-h-[76px] flex items-center justify-center"
                    />

                    {captchaBlocked ? (
                      <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                        Verification is blocked in this browser.
                        <div className="mt-1 text-amber-900/90">
                          Disable Shields/adblock for thankumail.com, or open this link in Chrome/Safari, then refresh.
                        </div>
                      </div>
                    ) : turnstileBooting ? (
                      <div className="mt-2 text-xs text-slate-500">Loading verification…</div>
                    ) : captchaReady ? (
                      <div className="mt-2 text-xs text-slate-600">Verified ✓</div>
                    ) : captchaRendered ? (
                      <div className="mt-2 text-xs text-slate-500">Complete verification above.</div>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {hasAmount && retryAfterSec !== null && retryAfterSec > 0 ? (
                <div className="mt-4 text-sm text-slate-700">Finalizing… about {retryAfterSec} seconds.</div>
              ) : null}

              <button
                onClick={handleClaimClick}
                disabled={buttonDisabled}
                className={cn(
                  "mt-4 w-full rounded-2xl px-5 py-4 transition text-lg tracking-tight border-2",
                  buttonDisabled
                    ? "bg-slate-200 text-slate-500 border-slate-300 cursor-not-allowed"
                    : "bg-tm-amber text-tm-charcoal border-tm-charcoal cursor-pointer shadow-soft hover:shadow-xl hover:opacity-95 hover:-translate-y-[1px] active:translate-y-0 active:opacity-90"
                )}
                style={{ fontFamily: FONT_TITLE, fontWeight: 800, letterSpacing: "-0.01em" }}
              >
                {buttonText}
              </button>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
