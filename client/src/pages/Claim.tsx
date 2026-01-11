import React, { useEffect, useMemo, useState } from "react";
import { Link, useRoute } from "wouter";

type Gift = {
  publicId: string;
  message: string;
  amount: number; // cents
  isClaimed: boolean;
  createdAt?: string;
  claimedAt?: string | null;
};

type ApiError = { error?: string; message?: string };

function centsToDollars(cents: number) {
  const n = Number(cents || 0);
  return (n / 100).toFixed(2);
}

function safeText(v: any) {
  return typeof v === "string" ? v : "";
}

function formatWhen(iso?: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function Claim() {
  const [, params] = useRoute<{ publicId: string }>("/claim/:publicId");
  const publicId = params?.publicId || "";

  const [loading, setLoading] = useState(true);
  const [gift, setGift] = useState<Gift | null>(null);
  const [err, setErr] = useState<string>("");
  const [claiming, setClaiming] = useState(false);
  const [justClaimed, setJustClaimed] = useState(false);

  const amountLabel = useMemo(() => {
    if (!gift) return "$0.00";
    return `$${centsToDollars(gift.amount)}`;
  }, [gift]);

  async function load() {
    if (!publicId) {
      setErr("Invalid link.");
      setGift(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setErr("");

    try {
      const r = await fetch(`/api/gifts/${encodeURIComponent(publicId)}`, { method: "GET" });
      const data = (await r.json().catch(() => ({}))) as Gift & ApiError;

      if (!r.ok) {
        setErr(safeText((data as any)?.error) || "This link is invalid or expired.");
        setGift(null);
        setLoading(false);
        return;
      }

      setGift({
        publicId: safeText((data as any).publicId),
        message: safeText((data as any).message),
        amount: Number((data as any).amount || 0),
        isClaimed: Boolean((data as any).isClaimed),
        createdAt: safeText((data as any).createdAt),
        claimedAt: (data as any).claimedAt ?? null,
      });

      setLoading(false);
    } catch (e: any) {
      setErr(String(e?.message || e || "Network error"));
      setGift(null);
      setLoading(false);
    }
  }

  useEffect(() => {
    setJustClaimed(false);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicId]);

  async function claim() {
    if (!publicId) return;
    setClaiming(true);
    setErr("");

    try {
      const r = await fetch(`/api/gifts/${encodeURIComponent(publicId)}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });

      const data = (await r.json().catch(() => ({}))) as any;

      // If already claimed, treat as success + refresh state.
      if (r.status === 409) {
        setJustClaimed(true);
        await load();
        setClaiming(false);
        return;
      }

      if (!r.ok) {
        setErr(safeText(data?.error) || "Couldn’t claim right now. Please try again.");
        setClaiming(false);
        return;
      }

      // Warm success moment, then refresh the gift state.
      setJustClaimed(true);
      await load();

      // If API returned claimedAt, keep it (load() will also bring it in)
      const claimedAt = safeText(data?.claimedAt);
      if (claimedAt) {
        setGift((g) => (g ? { ...g, isClaimed: true, claimedAt } : g));
      }

      setClaiming(false);
    } catch (e: any) {
      setErr(String(e?.message || e || "Network error"));
      setClaiming(false);
    }
  }

  const claimedWhen = formatWhen(gift?.claimedAt ?? null);

  return (
    <div className="min-h-screen bg-gradient-to-b from-white via-white to-violet-50 text-slate-900">
      <header className="mx-auto flex max-w-4xl items-center justify-between px-6 py-6">
        <Link href="/" className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-2xl bg-violet-600 shadow-sm" />
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight">ThanküMail</div>
            <div className="text-xs text-slate-500">A message first.</div>
          </div>
        </Link>

        <Link
          href="/"
          className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200 hover:ring-violet-200"
        >
          Send one →
        </Link>
      </header>

      <main className="mx-auto max-w-4xl px-6 pb-20 pt-6">
        <div className="rounded-3xl border border-violet-100 bg-white p-6 shadow-sm sm:p-8">
          {loading ? (
            <div className="space-y-3">
              <div className="h-6 w-40 animate-pulse rounded bg-slate-100" />
              <div className="h-20 w-full animate-pulse rounded-2xl bg-slate-100" />
              <div className="h-10 w-40 animate-pulse rounded-2xl bg-slate-100" />
            </div>
          ) : err ? (
            <div className="space-y-4">
              <div className="inline-flex items-center gap-2 rounded-full border border-rose-200 bg-rose-50 px-3 py-1 text-xs text-rose-700">
                <span className="h-2 w-2 rounded-full bg-rose-500" />
                Link issue
              </div>
              <h1 className="text-2xl font-extrabold tracking-tight">We couldn’t open this gift.</h1>
              <p className="text-sm text-slate-600">{err}</p>
              <div className="flex flex-wrap gap-3">
                <button
                  onClick={load}
                  className="rounded-2xl bg-violet-600 px-5 py-3 text-sm font-semibold text-white hover:bg-violet-700"
                >
                  Try again
                </button>
                <Link
                  href="/"
                  className="rounded-2xl bg-white px-5 py-3 text-sm font-semibold text-slate-700 ring-1 ring-slate-200 hover:ring-violet-200"
                >
                  Go home
                </Link>
              </div>
            </div>
          ) : gift ? (
            <div className="space-y-6">
              {gift.isClaimed || justClaimed ? (
                <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-5">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 h-9 w-9 rounded-2xl bg-emerald-600 shadow-sm" />
                    <div>
                      <div className="text-sm font-semibold text-emerald-900">Gift claimed</div>
                      <div className="mt-1 text-sm text-emerald-800">
                        You’re all set. Let that message land.
                        {claimedWhen ? <span className="ml-2 text-emerald-700">({claimedWhen})</span> : null}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="inline-flex items-center gap-2 rounded-full border border-violet-100 bg-violet-50 px-3 py-1 text-xs text-slate-700">
                  <span className="h-2 w-2 rounded-full bg-violet-600" />
                  A ThanküMail for you
                </div>
              )}

              <div>
                <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">
                  {gift.isClaimed ? "This one was claimed." : "Take a breath."}
                  <span className="block text-violet-700">{gift.isClaimed ? "Message received." : "This one is yours."}</span>
                </h1>
                <p className="mt-3 text-sm leading-relaxed text-slate-600">
                  Your message is first. No rush.
                </p>
              </div>

              <div className="rounded-3xl border border-violet-100 bg-white p-5 shadow-sm">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="text-xs font-semibold text-slate-500">AMOUNT</div>
                    <div className="mt-1 text-2xl font-extrabold tracking-tight text-slate-900">
                      {amountLabel}
                    </div>
                  </div>

                  <div className="sm:text-right">
                    <div className="text-xs font-semibold text-slate-500">STATUS</div>
                    <div
                      className={[
                        "mt-1 inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold",
                        gift.isClaimed ? "bg-slate-100 text-slate-700" : "bg-violet-50 text-violet-700",
                      ].join(" ")}
                    >
                      <span className={["h-2 w-2 rounded-full", gift.isClaimed ? "bg-slate-500" : "bg-violet-600"].join(" ")} />
                      {gift.isClaimed ? "Claimed" : "Unclaimed"}
                    </div>
                  </div>
                </div>

                <div className="mt-5 rounded-3xl border border-slate-200 bg-slate-50 p-5">
                  <div className="text-xs font-semibold text-slate-500">MESSAGE</div>
                  <div className="mt-3 whitespace-pre-wrap text-lg leading-relaxed text-slate-900">
                    “{gift.message || "—"}”
                  </div>
                </div>

                {gift.isClaimed ? (
                  <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
                    <Link
                      href="/"
                      className="flex-1 rounded-2xl bg-violet-600 px-5 py-3 text-center text-sm font-semibold text-white shadow-sm hover:bg-violet-700"
                    >
                      Send a ThanküMail →
                    </Link>
                    <button
                      onClick={load}
                      className="rounded-2xl bg-white px-5 py-3 text-sm font-semibold text-slate-700 ring-1 ring-slate-200 hover:ring-violet-200"
                    >
                      Refresh
                    </button>
                  </div>
                ) : (
                  <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
                    <button
                      onClick={claim}
                      disabled={claiming}
                      className={[
                        "flex-1 rounded-2xl px-5 py-3 text-sm font-semibold text-white shadow-sm transition",
                        claiming ? "bg-slate-300" : "bg-violet-600 hover:bg-violet-700",
                      ].join(" ")}
                    >
                      {claiming ? "Claiming…" : "Claim gift"}
                    </button>

                    <Link
                      href="/"
                      className="rounded-2xl bg-white px-5 py-3 text-center text-sm font-semibold text-slate-700 ring-1 ring-slate-200 hover:ring-violet-200"
                    >
                      Send a ThanküMail →
                    </Link>
                  </div>
                )}

                <div className="mt-4 text-xs text-slate-500">
                  If you weren’t expecting this, you can simply close this page.
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <div className="mt-6 rounded-3xl border border-violet-100 bg-white p-5 text-sm text-slate-600 shadow-sm">
          <div className="font-semibold text-slate-800">Private. Simple. Human.</div>
          <div className="mt-1">ThanküMail is built to deliver the feeling first — the gift second.</div>
        </div>
      </main>

      <footer className="border-t border-violet-100 bg-white">
        <div className="mx-auto flex max-w-4xl flex-col gap-2 px-6 py-10 text-sm text-slate-600 sm:flex-row sm:items-center sm:justify-between">
          <div>© {new Date().getFullYear()} ThanküMail</div>
          <div className="flex gap-4">
            <a className="hover:text-slate-900" href="/health">
              Status
            </a>
            <a className="hover:text-slate-900" href="/api/health">
              API
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
