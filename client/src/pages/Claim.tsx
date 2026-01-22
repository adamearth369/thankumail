// client/src/pages/Claim.tsx
import React, { useEffect, useMemo, useState } from "react";
import { useRoute } from "wouter";

type GiftGetOk = {
  ok: true;
  publicId: string;
  message: string;
  amount: number; // cents
  isClaimed: boolean;
  createdAt?: string;
};

type ApiErr = {
  error: string;
  code?: string;
  field?: string;
};

type GiftGetResponse = GiftGetOk | ApiErr;

function money(cents: number) {
  const n = Number(cents || 0) / 100;
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function getApiBase() {
  const v = (import.meta as any).env?.VITE_API_BASE_URL || "";
  return String(v || "").replace(/\/+$/, "");
}

function isDebugMode() {
  try {
    const u = new URL(window.location.href);
    return u.searchParams.get("debug") === "1";
  } catch {
    return false;
  }
}

async function readJson(res: Response) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text || `HTTP ${res.status}` };
  }
}

export default function Claim() {
  const [match, params] = useRoute<{ publicId: string }>("/claim/:publicId");
  const publicId = match ? params.publicId : "";

  const [loading, setLoading] = useState(true);
  const [gift, setGift] = useState<GiftGetOk | null>(null);
  const [err, setErr] = useState("");
  const [claiming, setClaiming] = useState(false);
  const [claimMsg, setClaimMsg] = useState("");

  const apiBase = useMemo(() => getApiBase(), []);
  const debug = useMemo(() => (typeof window !== "undefined" ? isDebugMode() : false), []);

  const getUrl = useMemo(() => {
    const path = `/api/gifts/${encodeURIComponent(publicId)}`;
    return apiBase ? `${apiBase}${path}` : path;
  }, [apiBase, publicId]);

  const claimUrl = useMemo(() => {
    const path = `/api/gifts/${encodeURIComponent(publicId)}/claim`;
    return apiBase ? `${apiBase}${path}` : path;
  }, [apiBase, publicId]);

  async function loadGift() {
    if (!publicId) {
      setErr("Invalid link.");
      setGift(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setErr("");
    setClaimMsg("");

    try {
      const res = await fetch(getUrl, { method: "GET" });
      const data = (await readJson(res)) as GiftGetResponse;

      if (!res.ok || (data && typeof data === "object" && "error" in data)) {
        setErr((data as any)?.error || `Request failed (HTTP ${res.status})`);
        setGift(null);
        return;
      }

      setGift(data as GiftGetOk);
    } catch (e: any) {
      setErr(e?.message || "Network error.");
      setGift(null);
    } finally {
      setLoading(false);
    }
  }

  async function doClaim() {
    if (!publicId) return;

    setClaiming(true);
    setErr("");
    setClaimMsg("");

    try {
      const res = await fetch(claimUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      const data = await readJson(res);

      if (!res.ok || (data && typeof data === "object" && "error" in data)) {
        setErr((data as any)?.error || `Claim failed (HTTP ${res.status})`);
        return;
      }

      setClaimMsg("Claimed.");
      await loadGift();
    } catch (e: any) {
      setErr(e?.message || "Network error.");
    } finally {
      setClaiming(false);
    }
  }

  useEffect(() => {
    loadGift();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicId]);

  return (
    <div style={{ maxWidth: 760, padding: "18px 14px" }}>
      <h1 style={{ margin: 0, fontSize: 30, fontWeight: 800 }}>You’ve got a ThanküMail</h1>
      <div style={{ marginTop: 6, fontSize: 18 }}>Someone left you a note and a gift. Take a breath — it’s meant for you.</div>

      {debug ? (
        <div style={{ marginTop: 14, padding: 10, border: "1px solid #ddd", borderRadius: 8, fontSize: 14 }}>
          <div style={{ fontWeight: 800 }}>Debug</div>
          <div style={{ marginTop: 6 }}>
            API base: <span style={{ fontFamily: "monospace" }}>{apiBase || "same origin"}</span>
          </div>
          <div style={{ marginTop: 6 }}>
            GET: <span style={{ fontFamily: "monospace" }}>{getUrl}</span>
          </div>
          <div style={{ marginTop: 6 }}>
            CLAIM: <span style={{ fontFamily: "monospace" }}>{claimUrl}</span>
          </div>
        </div>
      ) : null}

      <div style={{ marginTop: 18 }}>
        {loading ? <div>Loading…</div> : null}

        {!loading && err ? (
          <div style={{ color: "crimson", fontWeight: 800 }}>
            {err}
            <div style={{ marginTop: 10 }}>
              <button type="button" onClick={loadGift}>
                Retry
              </button>
            </div>
          </div>
        ) : null}

        {!loading && gift ? (
          <div style={{ marginTop: 10 }}>
            <div style={{ padding: 14, border: "1px solid #e5e5e5", borderRadius: 12 }}>
              <div style={{ fontSize: 14, opacity: 0.85 }}>Message</div>
              <div style={{ marginTop: 8, fontSize: 18, fontWeight: 700, lineHeight: 1.35 }}>{gift.message}</div>

              <div style={{ marginTop: 16, fontSize: 14, opacity: 0.85 }}>Amount</div>
              <div style={{ marginTop: 6, fontSize: 22, fontWeight: 900 }}>{money(gift.amount)}</div>

              {gift.isClaimed ? (
                <div style={{ marginTop: 14 }}>
                  <div style={{ fontWeight: 900 }}>
                    Already claimed <span aria-hidden="true">✅</span>
                  </div>
                  <div style={{ marginTop: 6, opacity: 0.85 }}>This gift has already been claimed.</div>
                </div>
              ) : (
                <div style={{ marginTop: 14 }}>
                  <div style={{ fontWeight: 900 }}>Claim</div>
                  <div style={{ marginTop: 6, opacity: 0.85 }}>By claiming, you confirm this gift is intended for you.</div>
                  <div style={{ marginTop: 12 }}>
                    <button type="button" onClick={doClaim} disabled={claiming} style={{ padding: "10px 12px" }}>
                      {claiming ? "Claiming…" : "Claim gift"}
                    </button>
                  </div>
                </div>
              )}

              {claimMsg ? <div style={{ marginTop: 12, color: "green", fontWeight: 800 }}>{claimMsg}</div> : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
