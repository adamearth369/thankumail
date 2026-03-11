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
  senderUserId?: string | null;
  senderEmail?: string | null;
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
  reminderCount?: number | null;
  lastReminderSentAt?: string | null;
  returnedToSenderAt?: string | null;
};

type GiftsResponse = {
  ok?: boolean;
  gifts?: GiftRow[];
  version?: string;
  error?: string;
  code?: string;
};

type GiftDetailResponse = {
  ok?: boolean;
  gift?: GiftRow;
  version?: string;
  error?: string;
  code?: string;
};

type RemindResponse = {
  ok?: boolean;
  publicId?: string;
  reminderCount?: number;
  lastReminderSentAt?: string;
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

function formatDateTime(value?: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
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

function getOverallStatus(g: GiftRow) {
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

function getDeliveryStatus(g: GiftRow) {
  const paymentStatus = String(g.paymentStatus || "").trim().toLowerCase();
  const deliveredAt = g.deliveredAt || g.deliveredEmailAt || g.deliveredSmsAt;
  const method = String(g.deliveryMethod || "").trim().toLowerCase();

  if (paymentStatus === "requires_payment" || paymentStatus === "created") {
    return {
      label: "Waiting for payment",
      date: null as string | null,
      className: "bg-amber-100 text-amber-800 border-amber-200",
    };
  }

  if (deliveredAt) {
    return {
      label: method === "sms" ? "SMS delivered" : method === "email" ? "Email delivered" : "Delivered",
      date: String(deliveredAt),
      className: "bg-blue-100 text-blue-800 border-blue-200",
    };
  }

  if (paymentStatus === "paid") {
    return {
      label: "Ready to deliver",
      date: null as string | null,
      className: "bg-sky-100 text-sky-800 border-sky-200",
    };
  }

  return {
    label: "Not delivered",
    date: null as string | null,
    className: "bg-tm-cream text-tm-charcoal border-tm-charcoal/15",
  };
}

function getClaimStatus(g: GiftRow) {
  const claimed = Boolean(g.isClaimed || g.claimedAt);

  if (claimed) {
    return {
      label: "Claimed",
      date: String(g.claimedAt || ""),
      className: "bg-green-100 text-green-800 border-green-200",
    };
  }

  return {
    label: "Unclaimed",
    date: null as string | null,
    className: "bg-tm-cream text-tm-charcoal border-tm-charcoal/15",
  };
}

function getMessagePreview(g: GiftRow) {
  const text = String(g.message || "").trim();
  if (!text) {
    if (g.messageMode === "preset" && g.presetMessageId != null) {
      return `Preset message #${g.presetMessageId}`;
    }
    return "—";
  }
  if (text.length <= 80) return text;
  return `${text.slice(0, 80)}…`;
}

function canSendReminder(g: GiftRow) {
  const claimed = Boolean(g.isClaimed || g.claimedAt);
  const hasRecipientEmail = Boolean(String(g.recipientEmail || "").trim());
  const returnedToSender = Boolean(g.returnedToSenderAt);
  return !claimed && !returnedToSender && hasRecipientEmail;
}

function buildClaimLink(publicId?: string | null) {
  const pid = String(publicId || "").trim();
  if (!pid) return "";
  return `https://thankumail.com/claim/${pid}`;
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
  const [selectedPublicId, setSelectedPublicId] = useState("");
  const [selectedGift, setSelectedGift] = useState<GiftRow | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [remindLoading, setRemindLoading] = useState(false);
  const [remindMessage, setRemindMessage] = useState("");
  const [remindError, setRemindError] = useState("");
  const [copyMessage, setCopyMessage] = useState("");
  const [copyError, setCopyError] = useState("");

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
          const nextGifts = Array.isArray(giftsJson?.gifts) ? giftsJson.gifts : [];
          const firstPublicId = String(nextGifts?.[0]?.publicId || "").trim();

          setEmail(String(meJson?.user?.email || ""));
          setAuthProvider(String(meJson?.user?.authProvider || ""));
          setSentCount(Number(statsJson?.sentCount || 0));
          setClaimedCount(Number(statsJson?.claimedCount || 0));
          setPendingCount(Number(statsJson?.pendingCount || 0));
          setTotalValueSent(Number(statsJson?.totalValueSent || 0));
          setApiVersion(String(statsJson?.version || giftsJson?.version || ""));
          setGifts(nextGifts);

          setSelectedPublicId((prev) => {
            if (prev && nextGifts.some((g) => String(g.publicId || "") === prev)) return prev;
            return firstPublicId;
          });

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

  useEffect(() => {
    let cancelled = false;

    async function loadDetail() {
      const token = safeGetLS("tm_session_token");
      const publicId = String(selectedPublicId || "").trim();

      if (!token || !publicId) {
        setSelectedGift(null);
        setDetailError("");
        setDetailLoading(false);
        setRemindMessage("");
        setRemindError("");
        setCopyMessage("");
        setCopyError("");
        return;
      }

      try {
        setDetailLoading(true);
        setDetailError("");
        setRemindMessage("");
        setRemindError("");
        setCopyMessage("");
        setCopyError("");

        const res = await fetch(`${apiBase}/api/me/gifts/${encodeURIComponent(publicId)}`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (res.status === 401) {
          safeRemoveLS("tm_session_token");
          if (!cancelled) {
            setUnauthorized(true);
            setDetailLoading(false);
          }
          return;
        }

        const json = (await res.json().catch(() => ({}))) as GiftDetailResponse;

        if (!res.ok) {
          throw new Error(String(json?.error || json?.code || "Failed to load gift detail"));
        }

        if (!cancelled) {
          setSelectedGift(json?.gift || null);
          setDetailLoading(false);
        }
      } catch (err: any) {
        if (!cancelled) {
          setSelectedGift(null);
          setDetailError(String(err?.message || err || "Failed to load gift detail"));
          setDetailLoading(false);
        }
      }
    }

    loadDetail();
    return () => {
      cancelled = true;
    };
  }, [apiBase, selectedPublicId]);

  function updateGiftInList(updatedGift: GiftRow) {
    const pid = String(updatedGift.publicId || "").trim();
    if (!pid) return;
    setGifts((prev) =>
      prev.map((g) => (String(g.publicId || "").trim() === pid ? { ...g, ...updatedGift } : g)),
    );
  }

  async function handleSendReminder() {
    const token = safeGetLS("tm_session_token");
    const publicId = String(selectedPublicId || "").trim();

    if (!token || !publicId) return;

    try {
      setRemindLoading(true);
      setRemindError("");
      setRemindMessage("");

      const res = await fetch(`${apiBase}/api/me/gifts/${encodeURIComponent(publicId)}/remind`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (res.status === 401) {
        safeRemoveLS("tm_session_token");
        setUnauthorized(true);
        setRemindLoading(false);
        return;
      }

      const json = (await res.json().catch(() => ({}))) as RemindResponse;

      if (!res.ok) {
        throw new Error(String(json?.error || json?.code || "Failed to send reminder"));
      }

      const updatedGift: GiftRow = {
        ...(selectedGift || {}),
        publicId,
        reminderCount: Number(json?.reminderCount || 0),
        lastReminderSentAt: String(json?.lastReminderSentAt || ""),
      };

      setSelectedGift(updatedGift);
      updateGiftInList(updatedGift);
      setRemindMessage("Reminder sent.");
      setRemindLoading(false);
    } catch (err: any) {
      setRemindError(String(err?.message || err || "Failed to send reminder"));
      setRemindLoading(false);
    }
  }

  async function handleCopyClaimLink() {
    const claimLink = buildClaimLink(selectedGift?.publicId);

    if (!claimLink) {
      setCopyError("Claim link unavailable.");
      setCopyMessage("");
      return;
    }

    try {
      setCopyError("");
      setCopyMessage("");

      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(claimLink);
      } else {
        const input = document.createElement("input");
        input.value = claimLink;
        document.body.appendChild(input);
        input.select();
        document.execCommand("copy");
        document.body.removeChild(input);
      }

      setCopyMessage("Claim link copied.");
    } catch (err: any) {
      setCopyError(String(err?.message || err || "Failed to copy claim link"));
    }
  }

  if (loading) {
    return (
      <div className="min-h-[70vh] bg-tm-cream px-4 py-10">
        <div className="mx-auto max-w-6xl">
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
          <div className="mt-2 text-sm text-tm-charcoal/75">Your session is missing or expired.</div>
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

  const detailOverall = selectedGift ? getOverallStatus(selectedGift) : null;
  const detailDelivery = selectedGift ? getDeliveryStatus(selectedGift) : null;
  const detailClaim = selectedGift ? getClaimStatus(selectedGift) : null;
  const claimLink = buildClaimLink(selectedGift?.publicId);

  return (
    <div className="min-h-[70vh] bg-tm-cream px-4 py-10">
      <div className="mx-auto max-w-6xl">
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
              <div className="mt-2 text-3xl font-outfit font-semibold text-tm-charcoal">{sentCount}</div>
            </div>

            <div className="rounded-2xl border border-tm-charcoal/10 bg-tm-cream/60 p-5">
              <div className="text-xs uppercase tracking-wide text-tm-charcoal/60">Claimed</div>
              <div className="mt-2 text-3xl font-outfit font-semibold text-tm-charcoal">{claimedCount}</div>
            </div>

            <div className="rounded-2xl border border-tm-charcoal/10 bg-tm-cream/60 p-5">
              <div className="text-xs uppercase tracking-wide text-tm-charcoal/60">Pending</div>
              <div className="mt-2 text-3xl font-outfit font-semibold text-tm-charcoal">{pendingCount}</div>
            </div>

            <div className="rounded-2xl border border-tm-charcoal/10 bg-tm-cream/60 p-5">
              <div className="text-xs uppercase tracking-wide text-tm-charcoal/60">Total Sent</div>
              <div className="mt-2 text-3xl font-outfit font-semibold text-tm-charcoal">
                {formatMoney(totalValueSent)}
              </div>
            </div>
          </div>

          <div className="mt-8 grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_minmax(340px,0.95fr)]">
            <div className="rounded-2xl border border-tm-charcoal/10 bg-white">
              <div className="border-b border-tm-charcoal/10 px-5 py-4">
                <div className="text-xl font-outfit font-semibold text-tm-charcoal">Recent ThankuMails</div>
                <div className="mt-1 text-sm text-tm-charcoal/70">
                  Select a row to view detail, copy claim link, and send a reminder
                </div>
              </div>

              {gifts.length === 0 ? (
                <div className="px-5 py-8 text-sm text-tm-charcoal/70">No thankumails sent yet.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full">
                    <thead>
                      <tr className="border-b border-tm-charcoal/10 text-left">
                        <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-tm-charcoal/55">
                          Recipient
                        </th>
                        <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-tm-charcoal/55">
                          Message
                        </th>
                        <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-tm-charcoal/55">
                          Overall
                        </th>
                        <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-tm-charcoal/55">
                          Delivery
                        </th>
                        <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-tm-charcoal/55">
                          Claim
                        </th>
                        <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-tm-charcoal/55">
                          Amount
                        </th>
                        <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-tm-charcoal/55">
                          Sent
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {gifts.map((g, index) => {
                        const overall = getOverallStatus(g);
                        const delivery = getDeliveryStatus(g);
                        const claim = getClaimStatus(g);
                        const rowKey = String(g.publicId || `gift-${index}`);
                        const isSelected = String(g.publicId || "") === selectedPublicId;

                        return (
                          <tr
                            key={rowKey}
                            onClick={() => setSelectedPublicId(String(g.publicId || ""))}
                            className={[
                              "cursor-pointer border-b border-tm-charcoal/8 align-top transition last:border-b-0",
                              isSelected ? "bg-tm-cream/60" : "hover:bg-tm-cream/35",
                            ].join(" ")}
                          >
                            <td className="px-5 py-4 text-sm text-tm-charcoal">
                              <div>{getRecipientLabel(g)}</div>
                              <div className="mt-1 text-xs text-tm-charcoal/55">
                                {String(g.deliveryMethod || "").trim() || "—"}
                              </div>
                            </td>

                            <td className="px-5 py-4 text-sm text-tm-charcoal">
                              <div className="max-w-[240px]">{getMessagePreview(g)}</div>
                            </td>

                            <td className="px-5 py-4 text-sm">
                              <span
                                className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${overall.className}`}
                              >
                                {overall.label}
                              </span>
                            </td>

                            <td className="px-5 py-4 text-sm text-tm-charcoal">
                              <span
                                className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${delivery.className}`}
                              >
                                {delivery.label}
                              </span>
                              <div className="mt-1 text-xs text-tm-charcoal/55">
                                {delivery.date ? formatDate(delivery.date) : "—"}
                              </div>
                            </td>

                            <td className="px-5 py-4 text-sm text-tm-charcoal">
                              <span
                                className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${claim.className}`}
                              >
                                {claim.label}
                              </span>
                              <div className="mt-1 text-xs text-tm-charcoal/55">
                                {claim.date ? formatDate(claim.date) : "—"}
                              </div>
                            </td>

                            <td className="px-5 py-4 text-sm text-tm-charcoal">
                              {g.amount != null ? formatMoney(Number(g.amount || 0)) : "—"}
                            </td>

                            <td className="px-5 py-4 text-sm text-tm-charcoal">{formatDate(g.createdAt)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-tm-charcoal/10 bg-white p-5 shadow-soft">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-xl font-outfit font-semibold text-tm-charcoal">Gift Detail</div>
                  <div className="mt-1 text-sm text-tm-charcoal/70">
                    Review status, copy claim link, and send a reminder
                  </div>
                </div>

                {selectedGift?.publicId ? (
                  <div className="rounded-full border border-tm-charcoal/10 bg-tm-cream/60 px-3 py-1 text-[11px] text-tm-charcoal/70">
                    {selectedGift.publicId}
                  </div>
                ) : null}
              </div>

              {detailLoading ? (
                <div className="mt-5 rounded-xl border border-tm-charcoal/10 bg-tm-cream/40 px-4 py-4 text-sm text-tm-charcoal/75">
                  Loading gift detail…
                </div>
              ) : null}

              {!detailLoading && detailError ? (
                <div className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {detailError}
                </div>
              ) : null}

              {!detailLoading && !detailError && !selectedGift ? (
                <div className="mt-5 rounded-xl border border-tm-charcoal/10 bg-tm-cream/40 px-4 py-4 text-sm text-tm-charcoal/75">
                  Select a thankumail to view detail.
                </div>
              ) : null}

              {!detailLoading && !detailError && selectedGift ? (
                <>
                  <div className="mt-5 grid gap-3 sm:grid-cols-3">
                    <div className="rounded-2xl border border-tm-charcoal/10 bg-tm-cream/45 p-4">
                      <div className="text-xs uppercase tracking-wide text-tm-charcoal/60">Overall</div>
                      <div className="mt-2">
                        <span
                          className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${detailOverall?.className || ""}`}
                        >
                          {detailOverall?.label || "—"}
                        </span>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-tm-charcoal/10 bg-tm-cream/45 p-4">
                      <div className="text-xs uppercase tracking-wide text-tm-charcoal/60">Delivery</div>
                      <div className="mt-2">
                        <span
                          className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${detailDelivery?.className || ""}`}
                        >
                          {detailDelivery?.label || "—"}
                        </span>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-tm-charcoal/10 bg-tm-cream/45 p-4">
                      <div className="text-xs uppercase tracking-wide text-tm-charcoal/60">Claim</div>
                      <div className="mt-2">
                        <span
                          className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${detailClaim?.className || ""}`}
                        >
                          {detailClaim?.label || "—"}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="mt-5 grid gap-4 sm:grid-cols-2">
                    <div className="rounded-2xl border border-tm-charcoal/10 bg-white p-4">
                      <div className="text-xs uppercase tracking-wide text-tm-charcoal/55">Recipient</div>
                      <div className="mt-2 text-sm text-tm-charcoal">{getRecipientLabel(selectedGift)}</div>
                    </div>

                    <div className="rounded-2xl border border-tm-charcoal/10 bg-white p-4">
                      <div className="text-xs uppercase tracking-wide text-tm-charcoal/55">Delivery Method</div>
                      <div className="mt-2 text-sm text-tm-charcoal">
                        {String(selectedGift.deliveryMethod || "").trim() || "—"}
                      </div>
                    </div>

                    <div className="rounded-2xl border border-tm-charcoal/10 bg-white p-4">
                      <div className="text-xs uppercase tracking-wide text-tm-charcoal/55">Amount</div>
                      <div className="mt-2 text-sm text-tm-charcoal">
                        {selectedGift.amount != null ? formatMoney(Number(selectedGift.amount || 0)) : "—"}
                      </div>
                    </div>

                    <div className="rounded-2xl border border-tm-charcoal/10 bg-white p-4">
                      <div className="text-xs uppercase tracking-wide text-tm-charcoal/55">Payment Status</div>
                      <div className="mt-2 text-sm text-tm-charcoal">
                        {String(selectedGift.paymentStatus || "").trim() || "—"}
                      </div>
                    </div>

                    <div className="rounded-2xl border border-tm-charcoal/10 bg-white p-4">
                      <div className="text-xs uppercase tracking-wide text-tm-charcoal/55">Created</div>
                      <div className="mt-2 text-sm text-tm-charcoal">{formatDateTime(selectedGift.createdAt)}</div>
                    </div>

                    <div className="rounded-2xl border border-tm-charcoal/10 bg-white p-4">
                      <div className="text-xs uppercase tracking-wide text-tm-charcoal/55">Last Reminder</div>
                      <div className="mt-2 text-sm text-tm-charcoal">
                        {formatDateTime(selectedGift.lastReminderSentAt)}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 rounded-2xl border border-tm-charcoal/10 bg-white p-4">
                    <div className="text-xs uppercase tracking-wide text-tm-charcoal/55">Message</div>
                    <div className="mt-2 text-sm leading-6 text-tm-charcoal">
                      {selectedGift.messageMode === "preset" && selectedGift.presetMessageId != null ? (
                        <span>Preset message #{selectedGift.presetMessageId}</span>
                      ) : String(selectedGift.message || "").trim() ? (
                        <span>{String(selectedGift.message || "").trim()}</span>
                      ) : (
                        <span>—</span>
                      )}
                    </div>
                  </div>

                  <div className="mt-4 rounded-2xl border border-tm-charcoal/10 bg-white p-4">
                    <div className="text-xs uppercase tracking-wide text-tm-charcoal/55">Claim Link</div>
                    <div className="mt-2 break-all text-sm text-tm-charcoal">{claimLink || "—"}</div>

                    <div className="mt-4 flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        onClick={handleCopyClaimLink}
                        disabled={!claimLink}
                        className="rounded-xl border border-tm-charcoal/20 bg-white px-4 py-2 text-sm font-medium text-tm-charcoal disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Copy Claim Link
                      </button>
                    </div>

                    {copyMessage ? (
                      <div className="mt-3 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
                        {copyMessage}
                      </div>
                    ) : null}

                    {copyError ? (
                      <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                        {copyError}
                      </div>
                    ) : null}
                  </div>

                  <div className="mt-5 rounded-2xl border border-tm-charcoal/10 bg-tm-cream/45 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-tm-charcoal">Reminder</div>
                        <div className="mt-1 text-sm text-tm-charcoal/70">
                          Reminder count: {Number(selectedGift.reminderCount || 0)}
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={handleSendReminder}
                        disabled={remindLoading || !canSendReminder(selectedGift)}
                        className="rounded-xl bg-tm-charcoal px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {remindLoading ? "Sending…" : "Send Reminder"}
                      </button>
                    </div>

                    {!canSendReminder(selectedGift) ? (
                      <div className="mt-3 text-xs text-tm-charcoal/60">
                        Reminder is only available for unclaimed gifts with recipient email.
                      </div>
                    ) : null}

                    {remindMessage ? (
                      <div className="mt-3 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
                        {remindMessage}
                      </div>
                    ) : null}

                    {remindError ? (
                      <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                        {remindError}
                      </div>
                    ) : null}
                  </div>
                </>
              ) : null}
            </div>
          </div>

          <div className="mt-6 text-xs text-tm-charcoal/50">{apiVersion ? `API ${apiVersion}` : ""}</div>
        </div>
      </div>
    </div>
  );
}