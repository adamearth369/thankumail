import React, { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    turnstile?: any;
  }
}

function getPublicIdFromPath() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

export default function Claim() {
  const publicId = getPublicIdFromPath();

  const [gift, setGift] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState(false);

  const turnstileTokenRef = useRef<string>("");

  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY || "";

  useEffect(() => {
    async function loadGift() {
      try {
        const r = await fetch(`/api/gifts/${publicId}`);
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error || "Failed to load gift");
        setGift(j);
      } catch (e: any) {
        setError(e.message || "Failed to load gift");
      } finally {
        setLoading(false);
      }
    }
    loadGift();
  }, [publicId]);

  useEffect(() => {
    if (!siteKey) return;

    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    script.async = true;
    script.defer = true;
    document.body.appendChild(script);

    return () => {
      document.body.removeChild(script);
    };
  }, [siteKey]);

  useEffect(() => {
    if (!siteKey) return;
    if (!window.turnstile) return;

    window.turnstile.render("#turnstile-container", {
      sitekey: siteKey,
      callback: (token: string) => {
        turnstileTokenRef.current = token;
        setError("");
      },
      "expired-callback": () => {
        turnstileTokenRef.current = "";
      },
      "error-callback": () => {
        turnstileTokenRef.current = "";
      },
    });
  }, [siteKey]);

  async function handleClaim() {
    if (!publicId) return;

    const token = turnstileTokenRef.current || "";

    setClaiming(true);
    setError("");

    try {
      const r = await fetch(`/api/gifts/${publicId}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turnstileToken: token }),
      });

      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Claim failed");

      setOk(true);
    } catch (e: any) {
      setError(e.message || "Claim failed");
    } finally {
      setClaiming(false);
    }
  }

  if (loading) {
    return <div style={{ padding: 32 }}>Loading…</div>;
  }

  if (error && !gift) {
    return <div style={{ padding: 32, color: "red" }}>{error}</div>;
  }

  if (ok) {
    return (
      <div style={{ padding: 32 }}>
        <h2>🎉 Gift claimed</h2>
        <p>Your ThankuMail has been successfully claimed.</p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 480, margin: "40px auto", padding: 24 }}>
      <h1>You’ve got a ThankuMail</h1>
      <p>Someone left you a note and a gift. Take a breath — it’s meant for you.</p>

      {error && <div style={{ color: "red", marginBottom: 12 }}>{error}</div>}

      <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 16 }}>
        <div style={{ marginBottom: 12 }}>
          <strong>Message</strong>
          <div>{gift.message || "—"}</div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <strong>Amount</strong>
          <div>${(Number(gift.amount) / 100).toFixed(2)}</div>
        </div>

        {siteKey && <div id="turnstile-container" style={{ marginBottom: 12 }} />}

        <button
          onClick={handleClaim}
          disabled={claiming}
          style={{
            width: "100%",
            padding: "10px 14px",
            borderRadius: 10,
            border: "none",
            background: "#111",
            color: "#fff",
            fontWeight: 700,
            cursor: "pointer",
            opacity: claiming ? 0.6 : 1,
          }}
        >
          {claiming ? "Claiming…" : "Claim gift"}
        </button>
      </div>
    </div>
  );
}
