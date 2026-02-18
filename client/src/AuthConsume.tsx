import React, { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";

type ApiError = {
  error: string;
  field?: string;
  code?: string;
  codes?: string[];
  issues?: any[];
  retryAfterSec?: number;
  version?: string;
};

type ConsumeOk = {
  ok: true;
  sessionToken: string;
  expiresAt: string;
  version?: string;
};

type ConsumeResponse = ConsumeOk | ApiError;

const API_BASE = "https://api.thankumail.com";

function parseApiError(e: any): ApiError {
  if (!e) return { error: "Unknown error" };
  if (typeof e === "string") return { error: e };
  if (typeof e?.error === "string") return e as ApiError;
  return { error: "Request failed" };
}

function getTokenFromUrl() {
  try {
    const u = new URL(window.location.href);
    return String(u.searchParams.get("token") || "").trim();
  } catch {
    return "";
  }
}

export default function AuthConsume() {
  const [, setLocation] = useLocation();

  const token = useMemo(() => getTokenFromUrl(), []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [ok, setOk] = useState<ConsumeOk | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setLoading(true);
      setError("");
      setOk(null);

      const t = String(token || "").trim();
      if (!t) {
        setLoading(false);
        setError("Missing token.");
        return;
      }

      try {
        const resp = await fetch(`${API_BASE}/api/auth/consume`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: t }),
        });

        let data: any = null;
        try {
          data = await resp.json();
        } catch {}

        if (!resp.ok || !data?.ok) {
          const err = parseApiError(data || { error: "Request failed" });
          if (cancelled) return;
          setError(err.error || "Request failed");
          setLoading(false);
          return;
        }

        const r = data as ConsumeOk;

        try {
          localStorage.setItem("tm_session_token", String(r.sessionToken || ""));
        } catch {}

        if (cancelled) return;
        setOk(r);
        setLoading(false);

        // Redirect home after success (small pause so user sees confirmation)
        setTimeout(() => {
          try {
            setLocation("/");
          } catch {}
        }, 800);
      } catch (e: any) {
        if (cancelled) return;
        setError(e?.message || "Network error");
        setLoading(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [token, setLocation]);

  const box = "rounded-2xl border border-tm-charcoal/20 bg-white p-5 shadow-soft text-tm-charcoal";

  return (
    <div className="w-full max-w-xl mx-auto">
      <div className={box}>
        <div className="flex items-center justify-between">
          <div className="text-lg font-outfit font-semibold tracking-tight">Finishing sign-in</div>
          <Link href="/" className="text-sm underline text-tm-charcoal/70 hover:text-tm-charcoal">
            Home
          </Link>
        </div>

        <div className="mt-4">
          {loading ? <div className="text-sm text-tm-charcoal/70">Working…</div> : null}

          {error ? (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          ) : null}

          {ok?.ok ? (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm text-emerald-800">
              <div className="font-medium">Signed in.</div>
              <div className="mt-2 text-xs text-emerald-900/70">Redirecting…</div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
