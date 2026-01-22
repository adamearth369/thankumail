import React, { useEffect, useMemo, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { Button } from "@/components/ui/button";

function getApiBase() {
  // Prefer env var if you set it in Render Static Site:
  // VITE_API_BASE_URL=https://thankumail-2.onrender.com
  const env = (import.meta as any)?.env?.VITE_API_BASE_URL as string | undefined;
  if (env && typeof env === "string") return env.replace(/\/+$/, "");

  // Preview fallback (keeps this working even if env var isn't set yet)
  return "https://thankumail-2.onrender.com";
}

type GiftGetResponse =
  | {
      ok: true;
      publicId: string;
      message: string;
      amount: number;
      isClaimed: boolean;
      createdAt?: string | null;
    }
  | { error: string; code?: string; retryAfterSec?: number };

type ClaimResponse =
  | { ok: true }
  | { error: string; code?: string; retryAfterSec?: number };

function formatMoney(cents: number) {
  const n = Number.isFinite(cents) ? cents : 0;
  return `$${(n / 100).toFixed(2)}`;
}

export default function Claim() {
  const [, setLocation] = useLocation();
  const [, params] = useRoute("/claim/:id");
  const id = String((params as any)?.id || "").trim();

  const apiBase = useMemo(() => getApiBase(), []);

  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState(false);
  const [claimedOk, setClaimedOk] = useState(false);

  const [gift, setGift] = useState<null | { message: string; amount: number; isClaimed: boolean }>(null);
  const [error, setError] = useState<string>("");
  const [errorCode, setErrorCode] = useState<string>("");
  const [retryAfterSec, setRetryAfterSec] = useState<number>(0);

  async function loadGift(signal?: AbortSignal) {
    if (!id) {
      setGift(null);
      setError("This link looks incomplete.");
      setErrorCode("BAD_LINK");
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError("");
      setErrorCode("");
      setRetryAfterSec(0);
      setClaimedOk(false);

      const url = `${apiBase}/api/gifts/${encodeURIComponent(id)}`;

      const res = await fetch(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal,
      });

      const data = (await res.json().catch(() => null)) as GiftGetResponse | null;

      if (!res.ok || !data) {
        if (res.status === 404) {
          setGift(null);
          setError("This link is invalid or expired.");
          setErrorCode("NOT_FOUND");
          return;
        }
        setGift(null);
        setError((data as any)?.error || `Unable to load gift (${res.status}).`);
        setErrorCode((data as any)?.code || "LOAD_FAILED");
        return;
      }

      if ("error" in data) {
        setGift(null);
        setError(data.error || "Unable to load gift.");
        setErrorCode(data.code || "LOAD_FAILED");
        setRetryAfterSec(Number(data.retryAfterSec || 0));
        return;
      }

      setGift({
        message: data.message || "",
        amount: Number(data.amount || 0),
        isClaimed: !!data.isClaimed,
      });
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      setGift(null);
      setError("Failed to fetch. Check your connection and try again.");
      setErrorCode("FETCH_FAILED");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const ac = new AbortController();
    loadGift(ac.signal);
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, apiBase]);

  async function claim() {
    if (!id) return;

    try {
      setClaiming(true);
      setError("");
      setErrorCode("");
      setRetryAfterSec(0);

      const res = await fetch(`${apiBase}/api/gifts/${encodeURIComponent(id)}/claim`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        // Preview bypass: if TURNSTILE_SECRET_KEY is set server-side, this needs a real token.
        // For preview, we keep "test" so it works when server Turnstile is disabled or bypassed.
        body: JSON.stringify({ turnstileToken: "test" }),
      });

      const data = (await res.json().catch(() => null)) as ClaimResponse | null;

      if (!res.ok || !data) {
        if (res.status === 404) {
          setError("This link is invalid or expired.");
          setErrorCode("NOT_FOUND");
          return;
        }
        setError((data as any)?.error || `Claim failed (${res.status}).`);
        setErrorCode((data as any)?.code || "CLAIM_FAILED");
        setRetryAfterSec(Number((data as any)?.retryAfterSec || 0));
        return;
      }

      if ("error" in data) {
        setError(data.error || "Claim failed.");
        setErrorCode(data.code || "CLAIM_FAILED");
        setRetryAfterSec(Number(data.retryAfterSec || 0));
        return;
      }

      // Success: show a clean confirmation state and refresh the gift state.
      setClaimedOk(true);
      await loadGift();
    } catch (e: any) {
      setError("Failed to claim. Check your connection and try again.");
      setErrorCode("FETCH_FAILED");
    } finally {
      setClaiming(false);
    }
  }

  function goHome() {
    // Keep this simple: send them to the root of the current site.
    setLocation("/");
  }

  const showAlreadyClaimed = !!gift?.isClaimed;

  return (
    <div className="mx-auto max-w-xl p-6">
      <div className="space-y-4">
        <div>
          <div className="text-2xl font-bold">You’ve got a ThankuMail</div>
          <div className="mt-1 text-sm opacity-80">
            Someone left you a note and a gift. Take a breath — it’s meant for you.
          </div>
        </div>

        <div className="rounded-2xl border p-4 space-y-3">
          {loading ? (
            <div className="text-sm opacity-80">Loading…</div>
          ) : error ? (
            <div className="space-y-3">
              <div className="text-lg font-semibold">Something went wrong</div>
              <div className="text-sm opacity-80">{error}</div>

              {errorCode === "TOO_SOON" && retryAfterSec > 0 ? (
                <div className="text-sm opacity-80">
                  Try again in about <span className="font-semibold">{retryAfterSec}s</span>.
                </div>
              ) : null}

              <div className="flex gap-2">
                <Button variant="outline" onClick={() => loadGift()} disabled={loading}>
                  Retry
                </Button>
                <Button variant="ghost" onClick={goHome}>
                  Go home
                </Button>
              </div>
            </div>
          ) : !gift ? (
            <div className="space-y-3">
              <div className="text-lg font-semibold">Gift not found</div>
              <div className="text-sm opacity-80">This link is invalid or expired.</div>
              <Button variant="ghost" onClick={goHome}>
                Go home
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <div className="text-sm opacity-70">Message</div>
                <div className="mt-1 whitespace-pre-wrap">{gift.message || "—"}</div>
              </div>

              <div className="pt-1">
                <div className="text-sm opacity-70">Amount</div>
                <div className="text-lg font-semibold">{formatMoney(gift.amount)}</div>
              </div>

              {claimedOk ? (
                <div className="rounded-xl border p-3 text-sm">
                  <div className="font-semibold">Claimed ✅</div>
                  <div className="mt-1 opacity-80">It’s yours. If you’d like, take a moment to sit with the message.</div>
                </div>
              ) : showAlreadyClaimed ? (
                <div className="rounded-xl border p-3 text-sm">
                  <div className="font-semibold">Already claimed ✅</div>
                  <div className="mt-1 opacity-80">This gift has already been claimed.</div>
                </div>
              ) : (
                <div className="pt-2">
                  <Button onClick={claim} disabled={claiming} className="w-full">
                    {claiming ? "Claiming…" : "Claim"}
                  </Button>
                  <div className="mt-2 text-xs opacity-70">
                    By claiming, you confirm this gift is intended for you.
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="text-xs opacity-60">
          Preview mode: Claim page is currently connected to <span className="font-mono">{apiBase}</span>
        </div>
      </div>
    </div>
  );
}
