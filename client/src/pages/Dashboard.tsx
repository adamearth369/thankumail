import { Link } from "wouter";
import { useEffect, useMemo, useState } from "react";

type MeResponse = {
  ok?: boolean;
  user?: {
    id?: string;
    email?: string;
    authProvider?: string | null;
    createdAt?: string | null;
    lastLoginAt?: string | null;
  } | null;
  version?: string;
  error?: string;
  code?: string;
};

type StatsResponse = {
  ok?: boolean;
  sentCount?: number;
  claimedCount?: number;
  pendingCount?: number;
  totalValueSent?: number;
  version?: string;
  error?: string;
  code?: string;
};

function safeGetLS(key: string) {
  try {
    return String(localStorage.getItem(key) || "").trim();
  } catch {
    return "";
  }
}

function safeRemoveLS(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {}
}

function resolveApiBase(): string {
  try {
    const v = (import.meta as any)?.env?.VITE_API_BASE_URL;
    const envBase = typeof v === "string" ? v.trim() : "";
    if (envBase) return envBase.replace(/\/+$/, "");
  } catch {}
  return "https://api.thankumail.com";
}

function formatMoney(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format((Number(cents || 0) || 0) / 100);
}

export default function Dashboard() {
  const [loading, setLoading] = useState(true);
  const [unauthorized, setUnauthorized] = useState(false);
  const [error, setError] = useState("");
  const [apiVersion, setApiVersion] = useState("");
  const [email, setEmail] = useState("");
  const [authProvider, setAuthProvider] = useState("");
  const [sentCount, setSentCount] = useState(0);
  const [claimedCount, setClaimedCount] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [totalValueSent, setTotalValueSent] = useState(0);

  const apiBase = useMemo(() => resolveApiBase(), []);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      const token = safeGetLS("tm_session_token");
      if (!token) {
        if (!cancelled) {
          setUnauthorized(true);
          setLoading(false);
        }
        return;
      }

      try {
        setLoading(true);
        setUnauthorized(false);
        setError("");

        const headers = {
          Authorization: `Bearer ${token}`,
        };

        const [meRes, statsRes] = await Promise.all([
          fetch(`${apiBase}/api/me`, { headers }),
          fetch(`${apiBase}/api/me/stats`, { headers }),
        ]);

        if (meRes.status === 401 || statsRes.status === 401) {
          safeRemoveLS("tm_session_token");
          if (!cancelled) {
            setUnauthorized(true);
            setLoading(false);
          }
          return;
        }

        const meJson = (await meRes.json().catch(() => ({}))) as MeResponse;
        const statsJson = (await statsRes.json().catch(() => ({}))) as StatsResponse;

        if (!meRes.ok) {
          throw new Error(String(meJson?.error || meJson?.code || "Failed to load account"));
        }

        if (!statsRes.ok) {
          throw new Error(String(statsJson?.error || statsJson?.code || "Failed to load stats"));
        }

        try {
          localStorage.setItem("tm_api_version", String(statsJson.version || ""));
        } catch {}

        if (!cancelled) {
          setEmail(String(meJson?.user?.email || ""));
          setAuthProvider(String(meJson?.user?.authProvider || ""));
          setSentCount(Number(statsJson?.sentCount || 0));
          setClaimedCount(Number(statsJson?.claimedCount || 0));
          setPendingCount(Number(statsJson?.pendingCount || 0));
          setTotalValueSent(Number(statsJson?.totalValueSent || 0));
          setApiVersion(String(statsJson?.version || ""));
          setLoading(false);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(String(err?.message || err || "Failed to load dashboard"));
          setLoading(false);
        }
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  if (loading) {
    return (
      <div className="min-h-[70vh] bg-tm-cream px-4 py-10">
        <div className="mx-auto max-w-5xl">
          <div className="rounded-2xl border border-tm-charcoal/10 bg-white p-6 shadow-soft">
            <div className="text-lg font-outfit font-semibold text-tm-charcoal">Loading dashboard…</div>
          </div>
        </div>
      </div>
    );
  }

  if (unauthorized) {
    return (
      <div className="min-h-[70vh] bg-tm-cream px-4 py-10">
        <div className="mx-auto max-w-3xl rounded-2xl border border-tm-charcoal/10 bg-white p-6 shadow-soft">
          <div className="text-2xl font-outfit font-semibold text-tm-charcoal">Please sign in</div>
          <div className="mt-2 text-sm text-tm-charcoal/75">
            Your session is missing or expired.
          </div>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link
              href="/login"
              className="rounded-xl bg-tm-charcoal px-4 py-2 text-sm font-medium text-white"
            >
              Go to login
            </Link>
            <Link
              href="/"
              className="rounded-xl border border-tm-charcoal/20 bg-white px-4 py-2 text-sm font-medium text-tm-charcoal"
            >
              Home
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[70vh] bg-tm-cream px-4 py-10">
      <div className="mx-auto max-w-5xl">
        <div className="rounded-2xl border border-tm-charcoal/10 bg-white p-6 shadow-soft">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="text-3xl font-outfit font-semibold text-tm-charcoal">Dashboard</div>
              <div className="mt-2 text-sm text-tm-charcoal/75">
                {email || "Signed in"}
                {authProvider ? ` • ${authProvider}` : ""}
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/"
                className="rounded-xl border border-tm-charcoal/20 bg-white px-4 py-2 text-sm font-medium text-tm-charcoal"
              >
                Home
              </Link>
            </div>
          </div>

          {error ? (
            <div className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          ) : null}

          <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-2xl border border-tm-charcoal/10 bg-tm-cream/60 p-5">
              <div className="text-xs uppercase tracking-wide text-tm-charcoal/60">Sent</div>
              <div className="mt-2 text-3xl font-outfit font-semibold text-tm-charcoal">
                {sentCount}
              </div>
            </div>

            <div className="rounded-2xl border border-tm-charcoal/10 bg-tm-cream/60 p-5">
              <div className="text-xs uppercase tracking-wide text-tm-charcoal/60">Claimed</div>
              <div className="mt-2 text-3xl font-outfit font-semibold text-tm-charcoal">
                {claimedCount}
              </div>
            </div>

            <div className="rounded-2xl border border-tm-charcoal/10 bg-tm-cream/60 p-5">
              <div className="text-xs uppercase tracking-wide text-tm-charcoal/60">Pending</div>
              <div className="mt-2 text-3xl font-outfit font-semibold text-tm-charcoal">
                {pendingCount}
              </div>
            </div>

            <div className="rounded-2xl border border-tm-charcoal/10 bg-tm-cream/60 p-5">
              <div className="text-xs uppercase tracking-wide text-tm-charcoal/60">Total Sent</div>
              <div className="mt-2 text-3xl font-outfit font-semibold text-tm-charcoal">
                {formatMoney(totalValueSent)}
              </div>
            </div>
          </div>

          <div className="mt-6 text-xs text-tm-charcoal/50">
            {apiVersion ? `API ${apiVersion}` : ""}
          </div>
        </div>
      </div>
    </div>
  );
}