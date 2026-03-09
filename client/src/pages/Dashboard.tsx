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

type GiftRow = {
  publicId?: string;
  recipientEmail?: string | null;
  recipientPhone?: string | null;
  deliveryMethod?: string | null;
  messageMode?: string | null;
  presetMessageId?: number | null;
  message?: string | null;
  amount?: number | null;
  paymentStatus?: string | null;
  isClaimed?: boolean | null;
  createdAt?: string | null;
  deliveredAt?: string | null;
  deliveredEmailAt?: string | null;
  deliveredSmsAt?: string | null;
  claimedAt?: string | null;
};

type GiftsResponse = {
  ok?: boolean;
  gifts?: GiftRow[];
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

function formatDate(value?: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function getRecipientLabel(g: GiftRow) {
  const email = String(g.recipientEmail || "").trim();
  const phone = String(g.recipientPhone || "").trim();
  if (email && phone) return `${email} / ${phone}`;
  if (email) return email;
  if (phone) return phone;
  return "—";
}

function getGiftStatus(g: GiftRow) {
  const claimed = Boolean(g.isClaimed || g.claimedAt);
  const paymentStatus = String(g.paymentStatus || "").trim().toLowerCase();
  const delivered = Boolean(g.deliveredAt || g.deliveredEmailAt || g.deliveredSmsAt);

  if (claimed) {
    return {
      label: "Claimed",
      className: "bg-green-100 text-green-800 border-green-200",
    };
  }

  if (paymentStatus === "requires_payment" || paymentStatus === "created") {
    return {
      label: "Awaiting payment",
      className: "bg-amber-100 text-amber-800 border-amber-200",
    };
  }

  if (paymentStatus === "paid" && delivered) {
    return {
      label: "Delivered",
      className: "bg-blue-100 text-blue-800 border-blue-200",
    };
  }

  if (paymentStatus === "paid") {
    return {
      label: "Paid",
      className: "bg-sky-100 text-sky-800 border-sky-200",
    };
  }

  if (delivered) {
    return {
      label: "Delivered",
      className: "bg-blue-100 text-blue-800 border-blue-200",
    };
  }

  return {
    label: "Pending",
    className: "bg-tm-cream text-tm-charcoal border-tm-charcoal/15",
  };
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
  const [gifts, setGifts] = useState<GiftRow[]>([]);

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

        const [meRes, statsRes, giftsRes] = await Promise.all([
          fetch(`${apiBase}/api/me`, { headers }),
          fetch(`${apiBase}/api/me/stats`, { headers }),
          fetch(`${apiBase}/api/me/gifts`, { headers }),
        ]);

        if (meRes.status === 401 || statsRes.status === 401 || giftsRes.status === 401) {
          safeRemoveLS("tm_session_token");
          if (!cancelled) {
            setUnauthorized(true);
            setLoading(false);
          }
          return;
        }

        const meJson = (await meRes.json().catch(() => ({}))) as MeResponse;
        const statsJson = (await statsRes.json().catch(() => ({}))) as StatsResponse;
        const giftsJson = (await giftsRes.json().catch(() => ({}))) as GiftsResponse;

        if (!meRes.ok) {
          throw new Error(String(meJson?.error || meJson?.code || "Failed to load account"));
        }

        if (!statsRes.ok) {
          throw new Error(String(statsJson?.error || statsJson?.code || "Failed to load stats"));
        }

        if (!giftsRes.ok) {
          throw new Error(String(giftsJson?.error || giftsJson?.code || "Failed to load gifts"));
        }

        try {
          localStorage.setItem("tm_api_version", String(statsJson.version || giftsJson.version || ""));
        } catch {}

        if (!cancelled) {
          setEmail(String(meJson?.user?.email || ""));
          setAuthProvider(String(meJson?.user?.authProvider || ""));
          setSentCount(Number(statsJson?.sentCount || 0));
          setClaimedCount(Number(statsJson?.claimedCount || 0));
          setPendingCount(Number(statsJson?.pendingCount || 0));
          setTotalValueSent(Number(statsJson?.totalValueSent || 0));
          setApiVersion(String(statsJson?.version || giftsJson?.version || ""));
          setGifts(Array.isArray(giftsJson?.gifts) ? giftsJson.gifts : []);
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

          <div className="mt-8 rounded-2xl border border-tm-charcoal/10 bg-white">
            <div className="border-b border-tm-charcoal/10 px-5 py-4">
              <div className="text-xl font-outfit font-semibold text-tm-charcoal">Recent ThankuMails</div>
              <div className="mt-1 text-sm text-tm-charcoal/70">
                Latest sent gifts and messages
              </div>
            </div>

            {gifts.length === 0 ? (
              <div className="px-5 py-8 text-sm text-tm-charcoal/70">
                No thankumails sent yet.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full">
                  <thead>
                    <tr className="border-b border-tm-charcoal/10 text-left">
                      <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-tm-charcoal/55">
                        Recipient
                      </th>
                      <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-tm-charcoal/55">
                        Status
                      </th>
                      <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-tm-charcoal/55">
                        Amount
                      </th>
                      <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-tm-charcoal/55">
                        Date
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {gifts.map((g) => {
                      const status = getGiftStatus(g);
                      return (
                        <tr key={String(g.publicId || Math.random())} className="border-b border-tm-charcoal/8 last:border-b-0">
                          <td className="px-5 py-4 text-sm text-tm-charcoal">
                            <div>{getRecipientLabel(g)}</div>
                            <div className="mt-1 text-xs text-tm-charcoal/55">
                              {String(g.deliveryMethod || "").trim() || "—"}
                            </div>
                          </td>
                          <td className="px-5 py-4 text-sm">
                            <span
                              className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${status.className}`}
                            >
                              {status.label}
                            </span>
                          </td>
                          <td className="px-5 py-4 text-sm text-tm-charcoal">
                            {g.amount != null ? formatMoney(Number(g.amount || 0)) : "—"}
                          </td>
                          <td className="px-5 py-4 text-sm text-tm-charcoal">
                            {formatDate(g.createdAt)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="mt-6 text-xs text-tm-charcoal/50">
            {apiVersion ? `API ${apiVersion}` : ""}
          </div>
        </div>
      </div>
    </div>
  );
}