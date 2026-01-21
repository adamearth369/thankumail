// WHERE TO PASTE: client/src/pages/Claim.tsx
import React, { useEffect, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { Button } from "@/components/ui/button";

function apiBase() {
  // TEMP SIMPLE FIX: hard-wire backend host for preview.
  // Later we can switch to: import.meta.env.VITE_API_BASE_URL
  return "https://thankumail-2.onrender.com";
}

type GiftGetResponse =
  | { ok: true; publicId: string; message: string; amount: number; isClaimed: boolean; createdAt?: string | null }
  | { error: string; code?: string; retryAfterSec?: number };

type ClaimResponse = { ok: true } | { error: string; code?: string; retryAfterSec?: number };

export default function Claim() {
  const [, setLocation] = useLocation();
  const [, params] = useRoute("/claim/:id");
  const id = (params as any)?.id || "";

  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState(false);
  const [gift, setGift] = useState<null | { message: string; amount: number; isClaimed: boolean }>(null);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        setLoading(true);
        setError("");

        const res = await fetch(`${apiBase()}/api/gifts/${encodeURIComponent(id)}`, {
          method: "GET",
          headers: { accept: "application/json" },
        });

        const data = (await res.json().catch(() => null)) as GiftGetResponse | null;

        if (!alive) return;

        if (!res.ok || !data) {
          setGift(null);
          setError((data as any)?.error || `Unable to load gift (${res.status})`);
          return;
        }

        if ("error" in data) {
          setGift(null);
          setError(data.error || "Unable to load gift");
          return;
        }

        setGift({ message: data.message || "", amount: data.amount || 0, isClaimed: !!data.isClaimed });
      } catch (e: any) {
        if (!alive) return;
        setGift(null);
        setError(e?.message || "Unable to load gift");
      } finally {
        if (!alive) return;
        setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [id]);

  async function claim() {
    try {
      setClaiming(true);
      setError("");

      const res = await fetch(`${apiBase()}/api/gifts/${encodeURIComponent(id)}/claim`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ turnstileToken: "test" }),
      });

      const data = (await res.json().catch(() => null)) as ClaimResponse | null;

      if (!res.ok || !data) {
        setError((data as any)?.error || `Claim failed (${res.status})`);
        return;
      }

      if ("error" in data) {
        setError(data.error || "Claim failed");
        return;
      }

      setLocation(`/claim/${id}?claimed=1`);
      window.location.reload();
    } catch (e: any) {
      setError(e?.message || "Claim failed");
    } finally {
      setClaiming(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-xl p-6">
        <div className="text-lg font-semibold">Loading…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-xl p-6">
        <div className="text-lg font-semibold">Something went wrong</div>
        <div className="mt-2 text-sm opacity-80">{error}</div>
      </div>
    );
  }

  if (!gift) {
    return (
      <div className="mx-auto max-w-xl p-6">
        <div className="text-lg font-semibold">Gift not found</div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl p-6 space-y-4">
      <div className="text-2xl font-bold">You’ve got a ThankuMail</div>

      <div className="rounded-2xl border p-4 space-y-3">
        <div className="text-sm opacity-70">Message</div>
        <div className="whitespace-pre-wrap">{gift.message || "—"}</div>

        <div className="pt-2 text-sm opacity-70">Amount</div>
        <div className="text-lg font-semibold">${(gift.amount / 100).toFixed(2)}</div>

        {gift.isClaimed ? (
          <div className="pt-3 text-sm font-semibold">Already claimed ✅</div>
        ) : (
          <Button onClick={claim} disabled={claiming} className="w-full mt-3">
            {claiming ? "Claiming…" : "Claim"}
          </Button>
        )}
      </div>
    </div>
  );
}
