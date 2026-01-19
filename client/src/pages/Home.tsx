// client/src/pages/Home.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: any) => string;
      reset: (widgetId?: string) => void;
    };
  }
}

function absoluteLink(pathOrUrl: string) {
  if (!pathOrUrl) return pathOrUrl;
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const path = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
  return `${origin}${path}`;
}

function safeText(v: any) {
  return typeof v === "string" ? v : "";
}

function isEmail(v: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

function centsFromDollarsInput(v: string) {
  const n = Number(String(v).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

async function safeJson(res: Response) {
  const txt = await res.text().catch(() => "");
  try {
    return { ok: true, json: JSON.parse(txt), raw: txt };
  } catch {
    return { ok: false, json: null, raw: txt };
  }
}

export default function Home() {
  // --- last link banner ---
  const [copied, setCopied] = useState(false);
  const [lastPublicId, setLastPublicId] = useState(() => {
    try {
      return safeText(localStorage.getItem("tm_last_publicId") || "");
    } catch {
      return "";
    }
  });

  const claimUrl = useMemo(() => {
    if (!lastPublicId) return "";
    return absoluteLink(`/claim/${encodeURIComponent(lastPublicId)}`);
  }, [lastPublicId]);

  async function copyLink() {
    if (!claimUrl) return;
    try {
      await navigator.clipboard.writeText(claimUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  }

  // --- form state ---
  const [senderEmail, setSenderEmail] = useState("sender@example.com");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [message, setMessage] = useState("");
  const [amountDollars, setAmountDollars] = useState("10");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string>("");

  // --- turnstile state ---
  const siteKey =
    (import.meta as any)?.env?.VITE_TURNSTILE_SITE_KEY ||
    (import.meta as any)?.env?.TURNSTILE_SITE_KEY ||
    "";

  const [turnstileToken, setTurnstileToken] = useState<string>("");
  const turnstileElRef = useRef<HTMLDivElement | null>(null);
  const turnstileWidgetIdRef = useRef<string>("");

  // Inject Turnstile script once (if we have a site key)
  useEffect(() => {
    if (!siteKey) return;

    const existing = document.querySelector('script[data-turnstile="1"]') as HTMLScriptElement | null;
    if (existing) return;

    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.defer = true;
    s.setAttribute("data-turnstile", "1");
    document.head.appendChild(s);
  }, [siteKey]);

  // Render Turnstile widget once script is ready
  useEffect(() => {
    if (!siteKey) return;
    const el = turnstileElRef.current;
    if (!el) return;

    let cancelled = false;

    const tryRender = () => {
      if (cancelled) return;
      if (!window.turnstile || typeof window.turnstile.render !== "function") {
        setTimeout(tryRender, 150);
        return;
      }

      // Clear any prior widget
      el.innerHTML = "";
      setTurnstileToken("");
      turnstileWidgetIdRef.current = "";

      const widgetId = window.turnstile.render(el, {
        sitekey: siteKey,
        theme: "light",
        callback: (token: string) => {
          setTurnstileToken(String(token || ""));
          setFormError("");
        },
        "error-callback": () => {
          setTurnstileToken("");
        },
        "expired-callback": () => {
          setTurnstileToken("");
        },
      });

      turnstileWidgetIdRef.current = widgetId;
    };

    tryRender();

    return () => {
      cancelled = true;
    };
  }, [siteKey]);

  function resetTurnstile() {
    try {
      if (window.turnstile && typeof window.turnstile.reset === "function") {
        // reset current widget if possible
        if (turnstileWidgetIdRef.current) window.turnstile.reset(turnstileWidgetIdRef.current);
        else window.turnstile.reset();
      }
    } catch {
      // ignore
    }
    setTurnstileToken("");
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setFormError("");

    const sEmail = senderEmail.trim();
    const rEmail = recipientEmail.trim();
    const amt = centsFromDollarsInput(amountDollars);

    if (!isEmail(sEmail)) return setFormError("Please enter a valid sender email.");
    if (!isEmail(rEmail)) return setFormError("Please enter a valid recipient email.");
    if (amt < 1000) return setFormError("Minimum amount is $10.00.");

    // If captcha is configured, require token before calling server
    if (siteKey && !turnstileToken) {
      return setFormError("Please complete the CAPTCHA.");
    }

    setSubmitting(true);
    try {
      const payload: any = {
        senderEmail: sEmail,
        recipientEmail: rEmail,
        message: message || "",
        amount: amt,
      };
      if (turnstileToken) payload.turnstileToken = turnstileToken;

      const res = await fetch("/gifts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

      const parsed = await safeJson(res);

      if (!res.ok) {
        // server provided JSON error
        const errMsg =
          (parsed.ok && parsed.json && (parsed.json.error || parsed.json.message)) ||
          (parsed.raw ? parsed.raw : `Request failed (${res.status})`);

        setFormError(String(errMsg));

        // If captcha failed, reset it so user can retry
        if (parsed.ok && parsed.json && parsed.json.field === "turnstileToken") {
          resetTurnstile();
        }
        return;
      }

      // success
      const publicId = parsed.ok && parsed.json ? String(parsed.json.publicId || "") : "";
      if (publicId) {
        try {
          localStorage.setItem("tm_last_publicId", publicId);
        } catch {
          // ignore
        }
        setLastPublicId(publicId);
      }

      // clear form (keep sender email)
      setRecipientEmail("");
      setMessage("");
      setAmountDollars("10");
      setFormError("");
      resetTurnstile();
    } catch (err: any) {
      setFormError(err?.message || "Network error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-white via-white to-violet-50 text-slate-900">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-2xl bg-violet-600 shadow-sm" />
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight">ThanküMail</div>
            <div className="text-xs text-slate-500">Send a gift with a real message.</div>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl grid-cols-1 gap-10 px-6 pb-20 pt-6 lg:grid-cols-2">
        <section>
          <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">
            A small gift.
            <span className="block text-violet-700">A message they’ll remember.</span>
          </h1>
          <p className="mt-4 max-w-xl text-base leading-relaxed text-slate-600">
            Your words arrive first. The gift follows when they’re ready.
          </p>

          {claimUrl ? (
            <div className="mt-6 rounded-3xl border border-violet-100 bg-white p-5 text-sm text-slate-700 shadow-sm">
              <div className="font-semibold text-slate-900">Last ThanküMail link</div>
              <div className="mt-2 break-all rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 font-mono text-xs text-slate-800">
                {claimUrl}
              </div>

              <div className="mt-3 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={copyLink}
                  className="rounded-2xl bg-violet-600 px-5 py-3 text-sm font-semibold text-white hover:bg-violet-700"
                >
                  {copied ? "Copied" : "Copy link"}
                </button>

                <a
                  href={claimUrl}
                  className="rounded-2xl bg-white px-5 py-3 text-sm font-semibold text-slate-700 ring-1 ring-slate-200 hover:ring-violet-200"
                >
                  Open claim page →
                </a>
              </div>

              <div className="mt-2 text-xs text-slate-500">
                Tip: This saves your latest link in your browser so you can grab it again easily.
              </div>
            </div>
          ) : null}
        </section>

        <section>
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="text-lg font-bold text-slate-900">Create a ThanküMail</div>
            <p className="mt-1 text-sm text-slate-600">Write the message first. The gift unlocks on claim.</p>

            {formError ? (
              <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {formError}
              </div>
            ) : null}

            <form onSubmit={onSubmit} className="mt-5 space-y-4">
              <div>
                <label className="text-sm font-semibold text-slate-800">Sender email</label>
                <input
                  value={senderEmail}
                  onChange={(e) => setSenderEmail(e.target.value)}
                  className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-violet-300"
                  placeholder="you@example.com"
                  autoComplete="email"
                />
              </div>

              <div>
                <label className="text-sm font-semibold text-slate-800">Recipient email</label>
                <input
                  value={recipientEmail}
                  onChange={(e) => setRecipientEmail(e.target.value)}
                  className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-violet-300"
                  placeholder="friend@example.com"
                  autoComplete="email"
                />
              </div>

              <div>
                <label className="text-sm font-semibold text-slate-800">Message</label>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  className="mt-2 min-h-[120px] w-full resize-y rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-violet-300"
                  placeholder="Say something real…"
                  maxLength={2000}
                />
                <div className="mt-1 text-xs text-slate-500">{message.length}/2000</div>
              </div>

              <div>
                <label className="text-sm font-semibold text-slate-800">Gift amount (USD)</label>
                <input
                  value={amountDollars}
                  onChange={(e) => setAmountDollars(e.target.value)}
                  className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-violet-300"
                  placeholder="10"
                  inputMode="decimal"
                />
                <div className="mt-1 text-xs text-slate-500">Minimum $10.00</div>
              </div>

              {siteKey ? (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="text-xs font-semibold text-slate-600">CAPTCHA</div>
                  <div className="mt-2" ref={turnstileElRef} />
                  <div className="mt-2 text-xs text-slate-500">
                    {turnstileToken ? "Verified." : "Complete the CAPTCHA to send."}
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  CAPTCHA site key not configured for the client. Set <span className="font-mono">VITE_TURNSTILE_SITE_KEY</span>{" "}
                  in Render and redeploy.
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="w-full rounded-2xl bg-violet-600 px-5 py-3 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-60"
              >
                {submitting ? "Sending…" : "Send ThanküMail"}
              </button>
            </form>
          </div>
        </section>
      </main>
    </div>
  );
}
