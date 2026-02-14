// WHERE TO PASTE: client/src/pages/Claim.tsx
// ACTION: Full file replacement (paste exactly)

import React, { useEffect, useMemo, useRef, useState } from "react";
import confetti from "canvas-confetti";

const API_BASE = "https://api.thankumail.com";
const CLAIM_UI_MARKER = "claim_ui_v2026-02-14_007";

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
    (/expired/i.test(m) && /link|token|id/i.test(m))
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

export default function Claim() {
  const publicId = getPublicIdFromPath();

  const [gift, setGift] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const [claiming, setClaiming] = useState(false);

  // For gift-amount flows only (shows countdown)
  const [retryAfterSec, setRetryAfterSec] = useState<number | null>(null);
  const retryTimerRef = useRef<number | null>(null);

  const [error, setError] = useState("");
  const [ok, setOk] = useState(false);
  const [alreadyClaimed, setAlreadyClaimed] = useState(false);

  const invalidRef = useRef<boolean>(false);

  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY || "";
  const [turnstileBooting, setTurnstileBooting] = useState<boolean>(false);
  const [captchaReady, setCaptchaReady] = useState<boolean>(!siteKey);
  const tokenRef = useRef<string>("");
  const widgetIdRef = useRef<any>(null);
  const renderedRef = useRef<boolean>(false);

  const confettiFiredRef = useRef<boolean>(false);

  const shouldShowCaptcha = Boolean(siteKey) && !!gift && !alreadyClaimed && !ok && !invalidRef.current;
  const canAttemptClaim = !!gift && !alreadyClaimed && !ok && !invalidRef.current;

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

        setGift(j);
        setAlreadyClaimed(Boolean(j?.isClaimed));
        if (Boolean(j?.isClaimed)) setOk(true);
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
    setCaptchaReady(!siteKey ? true : false);
  }, [alreadyClaimed, siteKey]);

  // Countdown ticker (gift-amount only)
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

  // Auto attempt after countdown hits 0 (gift-amount only)
  useEffect(() => {
    if (!hasAmount) return;
    if (retryAfterSec === null) return;
    if (retryAfterSec !== 0) return;
    if (!canAttemptClaim) return;

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
            setOk(true);
            setError("");
            return;
          }

          if (code === "TURNSTILE_FAILED") {
            hardResetTurnstile();
            if (!invalidRef.current) setError("Verification expired — please verify again.");
            return;
          }

          throw new Error(msg);
        }

        setOk(true);
        setAlreadyClaimed(true);
        setError("");

        try {
          const rr = await fetch(`${API_BASE}/api/gifts/${publicId}`);
          const jj: any = await safeJson(rr);
          if (rr.ok && !(jj?.__notJson || jj?.__badJson)) setGift(jj);
        } catch {}
      } catch (e: any) {
        if (!invalidRef.current) setError(friendlyError(e?.message || "Claim failed"));
      } finally {
        setClaiming(false);
        setRetryAfterSec(null);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAmount, retryAfterSec, canAttemptClaim]);

  function hardResetTurnstile() {
    try {
      const ts = getTurnstile();
      if (ts && widgetIdRef.current !== null && ts.reset) {
        ts.reset(widgetIdRef.current);
      }
    } catch {}
    tokenRef.current = "";
    setCaptchaReady(false);
  }

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

  useEffect(() => {
    if (!siteKey) return;
    if (!shouldShowCaptcha) return;
    if (renderedRef.current) return;

    let cancelled = false;

    const tryRender = () => {
      if (cancelled) return;

      const ts = getTurnstile();
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
          },
          "error-callback": () => {
            if (invalidRef.current) return;
            tokenRef.current = "";
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

  async function handleClaimClick() {
    if (!publicId) return;
    if (!canAttemptClaim) return;

    // Guest/no-amount: instant success UI (seamless)
    if (!hasAmount) {
      setOk(true);
      setAlreadyClaimed(true);
      setError("");
    }

    if (shouldShowCaptcha && !captchaReady) {
      if (hasAmount) setError("Please complete the quick verification below.");
      return;
    }

    setClaiming(true);
    setError("");

    try {
      const { r, j } = await postClaim();

      if (j?.__notJson || j?.__badJson) {
        throw new Error("Claim page misrouted — API returned HTML instead of JSON.");
      }

      // Gift-amount: if delay, start visible countdown + auto retry
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
          setOk(true);
          setError("");
          return;
        }

        if (code === "TURNSTILE_FAILED") {
          hardResetTurnstile();
          if (!invalidRef.current) setError("Verification expired — please verify again.");
          return;
        }

        // Guest/no-amount: keep seamless success; don’t block them
        if (!hasAmount) {
          setError("");
          return;
        }

        throw new Error(msg);
      }

      setOk(true);
      setAlreadyClaimed(true);
      setError("");

      try {
        const rr = await fetch(`${API_BASE}/api/gifts/${publicId}`);
        const jj: any = await safeJson(rr);
        if (rr.ok && !(jj?.__notJson || jj?.__badJson)) setGift(jj);
      } catch {}
    } catch (e: any) {
      if (!invalidRef.current) {
        if (hasAmount) setError(friendlyError(e?.message || "Claim failed"));
        else setError("");
      }
    } finally {
      setClaiming(false);
    }
  }

  // Background + overlay matches Home
  if (loading) {
    return (
      <div
        className="min-h-screen text-white bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: "url('/images/hero-background.png')" }}
        data-claim-marker={CLAIM_UI_MARKER}
      >
        <div className="min-h-screen bg-black/40">
          <div className="mx-auto max-w-5xl px-4 pt-10 pb-16">
            <div className="w-full max-w-md mx-auto rounded-2xl bg-white/95 backdrop-blur shadow-soft border border-white/20 p-6 text-slate-900">
              <div className="text-sm text-slate-500 mb-2">
                <span className="font-quicksand font-semibold">thankümail</span>
              </div>
              <div className="font-outfit text-2xl text-slate-900">Loading…</div>
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
        data-claim-marker={CLAIM_UI_MARKER}
      >
        <div className="min-h-screen bg-black/40">
          <div className="mx-auto max-w-5xl px-4 pt-10 pb-16">
            <div className="w-full max-w-md mx-auto rounded-2xl border border-red-200 bg-red-50 p-6 text-slate-900">
              <div className="text-sm text-red-800 font-medium mb-1">
                Couldn’t open this{" "}
                <span className="font-quicksand font-semibold">thankümail</span>
              </div>
              <div className="text-sm text-red-700">{error || invalidLinkMessage()}</div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (ok) {
    // fire confetti once on ok screen entry
    if (!confettiFiredRef.current) {
      confettiFiredRef.current = true;
      fireConfettiBurst();
    }

    return (
      <div
        className="min-h-screen text-white bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: "url('/images/hero-background.png')" }}
        data-claim-marker={CLAIM_UI_MARKER}
      >
        <div className="min-h-screen bg-black/40">
          <main className="mx-auto max-w-5xl px-4 pt-10 pb-16">
            <div className="w-full max-w-xl mx-auto rounded-2xl bg-white/95 backdrop-blur shadow-soft border border-white/20 p-6 text-slate-900">
              <div className="text-sm text-slate-500">
                <span className="font-quicksand font-semibold">thankümail</span>
              </div>

              <h1 className="mt-2 font-outfit text-3xl text-slate-900">Received.</h1>
              <p className="mt-2 text-slate-700">
                {hasAmount ? "The note was the heart of it. The gift will finalize shortly." : "The note was the heart of it."}
              </p>

              <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-5">
                <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">Message</div>
                <div className="text-lg leading-relaxed text-slate-900 whitespace-pre-wrap">
                  {gift?.message || "—"}
                </div>
              </div>

              {hasAmount ? (
                <div className="mt-5 flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="text-sm text-slate-700">Gift amount</div>
                  <div className="font-outfit text-2xl text-slate-900">${amountDollars}</div>
                </div>
              ) : null}

              <div className="mt-5 text-xs text-slate-600">
                If you weren’t expecting this, you can ignore it — nothing else is required.
              </div>
            </div>

            <div className="mt-4 text-center text-xs text-white/60">{CLAIM_UI_MARKER}</div>
          </main>
        </div>
      </div>
    );
  }

  let buttonText = hasAmount ? "Claim gift" : "Accept this thankümail";
  if (!canAttemptClaim && alreadyClaimed) buttonText = "Already claimed";
  else if (hasAmount && retryAfterSec !== null && retryAfterSec > 0) buttonText = `Finalizing… ${retryAfterSec}s`;
  else if (claiming) buttonText = "Checking…";
  else if (shouldShowCaptcha && !captchaReady) buttonText = turnstileBooting ? "Loading verification…" : "Verify to claim";

  const buttonDisabled =
    !canAttemptClaim ||
    claiming ||
    (shouldShowCaptcha ? !captchaReady : false) ||
    (waitingOnDelay ? true : false);

  return (
    <div
      className="min-h-screen text-white bg-cover bg-center bg-no-repeat"
      style={{ backgroundImage: "url('/images/hero-background.png')" }}
      data-claim-marker={CLAIM_UI_MARKER}
    >
      <div className="min-h-screen bg-black/40">
        <main className="mx-auto max-w-5xl px-4 pt-10 pb-16">
          <div className="w-full max-w-xl mx-auto rounded-2xl bg-white/95 backdrop-blur shadow-soft border border-white/20 p-6 text-slate-900">
            <div className="text-sm text-slate-500">
              <span className="font-quicksand font-semibold">thankümail</span>
            </div>

            <h1 className="mt-2 font-outfit text-3xl text-slate-900">A note for you.</h1>
            <p className="mt-2 text-slate-700">
              Read the message first. {hasAmount ? "Claim when you’re ready." : "Accept when you’re ready."}
            </p>

            {alreadyClaimed ? (
              <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                This <span className="font-quicksand font-semibold">thankümail</span> has already been claimed.
              </div>
            ) : error ? (
              <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                {error}
              </div>
            ) : null}

            <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-5">
              <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">Message</div>
              <div className="text-lg leading-relaxed text-slate-900 whitespace-pre-wrap">{gift?.message || "—"}</div>
            </div>

            <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-5">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-slate-900">{hasAmount ? "Gift" : "Confirmation"}</div>
                  <div className="mt-1 text-xs text-slate-600">
                    {hasAmount
                      ? "For safety, there’s a quick verification and a short pause before it finalizes."
                      : "For safety, there’s a quick verification."}
                  </div>
                </div>

                {hasAmount ? (
                  <div className="text-right">
                    <div className="text-xs text-slate-500">Amount</div>
                    <div className="font-outfit text-2xl text-slate-900">${amountDollars}</div>
                  </div>
                ) : null}
              </div>

              {shouldShowCaptcha ? (
                <div className="mt-4">
                  <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <div id="turnstile-container" />
                    {turnstileBooting ? (
                      <div className="mt-2 text-xs text-slate-500">Loading verification…</div>
                    ) : captchaReady ? (
                      <div className="mt-2 text-xs text-slate-600">Verified ✓</div>
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
                  "mt-4 w-full rounded-2xl px-5 py-4 transition font-outfit text-lg tracking-tight border-2",
                  buttonDisabled
                    ? "bg-slate-200 text-slate-500 border-slate-300 cursor-not-allowed"
                    : "bg-tm-amber text-tm-charcoal border-tm-charcoal cursor-pointer shadow-soft hover:shadow-xl hover:opacity-95 hover:-translate-y-[1px] active:translate-y-0 active:opacity-90"
                )}
              >
                {buttonText}
              </button>

              <div className="mt-3 text-xs text-slate-600">
                If you weren’t expecting this, you can ignore it — nothing else is required.
              </div>
            </div>
          </div>

          <div className="mt-4 text-center text-xs text-white/60">{CLAIM_UI_MARKER}</div>
        </main>
      </div>
    </div>
  );
}
