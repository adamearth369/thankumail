// WHERE TO PASTE: client/src/pages/AuthConsume.tsx
// ACTION: Full file replacement (paste exactly)

import React, { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { apiJson } from "@/lib/api";

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

type MeOk = {
  ok?: boolean;
  user?: {
    id?: string | number;
    email?: string;
    createdAt?: string;
    [k: string]: any;
  };
  [k: string]: any;
};

const SESSION_KEY = "tm_session_token";

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

function setSessionToken(token: string) {
  try {
    localStorage.setItem(SESSION_KEY, String(token || "").trim());
  } catch {
    // ignore
  }
}

function clearSessionToken() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
}

export default function AuthConsume() {
  const [, setLocation] = useLocation();

  const token = useMemo(() => getTokenFromUrl(), []);
  const [loading, setLoading] = useState(true);
  const [phase, setPhase] = useState<"consuming" | "verifying" | "done">("consuming");
  const [error, setError] = useState("");
  const [ok, setOk] = useState<ConsumeOk | null>(null);
  const [meEmail, setMeEmail] = useState<string>("");

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setLoading(true);
      setError("");
      setOk(null);
      setMeEmail("");
      setPhase("consuming");

      const t = String(token || "").trim();
      if (!t) {
        setLoading(false);
        setError("Missing token.");
        return;
      }

      try {
        const data = await apiJson<ConsumeResponse>("/api/auth/consume", {
          method: "POST",
          body: JSON.stringify({ token: t }),
          auth: false,
        });

        if (!data || !(data as any).ok) {
          const err = parseApiError(data || { error: "Request failed" });
          if (cancelled) return;
          setError(err.error || "Request failed");
          setLoading(false);
          return;
        }

        const r = data as ConsumeOk;
        setSessionToken(r.sessionToken);

        if (cancelled) return;
        setOk(r);

        // Verify immediately with /api/auth/me (uses bearer token in api.ts)
        setPhase("verifying");

        const me = await apiJson<MeOk>("/api/auth/me", { method: "GET", auth: true });

        if (cancelled) return;

        if (me && (me as any).user) {
          const email = String((me as any).user?.email || "").trim();
          setMeEmail(email);
          setPhase("done");
          setLoading(false);

          setTimeout(() => {
            try {
              setLocation("/");
            } catch {}
          }, 600);

          return;
        }

        // If verification didn't return a user, treat as failure and clear token
        clearSessionToken();
        setOk(null);
        setError("Sign-in verification failed. Please request a new magic link.");
        setLoading(false);
      } catch (e: any) {
        if (cancelled) return;

        // On any consume/verify failure, clear token to avoid stuck "registered" UI
        clearSessionToken();

        const err = parseApiError(e);
        setError(err.error || e?.message || "Network error");
        setLoading(false);
      }
    }

    run();

    return () => {
      cancelled = true;
    };
  }, [token, setLocation]);

  const box = "rounded-2xl border border-tm-charcoal/20 bg-white p-5 shadow-soft text-tm-charcoal";

  const status =
    phase === "consuming"
      ? "Signing you in…"
      : phase === "verifying"
        ? "Verifying session…"
        : "Signed in.";

  return (
    <div className="w-full max-w-xl mx-auto">
      <div className={box}>
        <div className="flex items-center justify-between">
          <div className="text-lg font-outfit font-semibold tracking-tight">Finishing sign-in</div>
          <Link href="/" className="text-sm underline text-tm-charcoal/70 hover:text-tm-charcoal">
            Home
          </Link>
        </div>

        <div className="mt-4 space-y-3">
          {loading ? <div className="text-sm text-tm-charcoal/70">{status}</div> : null}

          {error ? (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          ) : null}

          {ok?.ok && !error ? (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm text-emerald-800">
              <div className="font-medium">{phase === "done" ? "Signed in." : "Almost done…"}</div>
              {meEmail ? <div className="mt-2 text-xs text-emerald-900/75">{meEmail}</div> : null}
              <div className="mt-2 text-xs text-emerald-900/70">Redirecting…</div>
            </div>
          ) : null}

          {!loading && error ? (
            <div className="text-xs text-tm-charcoal/60">
              Try again from{" "}
              <Link href="/login" className="underline text-tm-charcoal/70 hover:text-tm-charcoal">
                /login
              </Link>
              .
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type ConsumeResponse = ConsumeOk | ApiError;
