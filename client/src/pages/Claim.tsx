import { useEffect, useState } from "react";
import { useRoute } from "wouter";

type Gift = {
  publicId: string;
  amount: number; // cents
  message?: string;
  senderEmail?: string;
  isClaimed: boolean;
};

export default function Claim() {
  const [, params] = useRoute<{ id: string }>("/claim/:id");
  const id = params?.id;

  const [gift, setGift] = useState<Gift | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) {
      setError("This link is invalid or expired.");
      setLoading(false);
      return;
    }

    async function loadGift() {
      try {
        const res = await fetch(`/api/gifts/${id}`, {
          headers: { Accept: "application/json" },
        });

        if (!res.ok) {
          // Avoid throwing noisy HTML into the UI; log it for debugging
          const text = await res.text().catch(() => "");
          console.error("Gift fetch failed:", res.status, text);
          throw new Error(`Fetch failed (${res.status})`);
        }

        const data = (await res.json()) as Gift;
        setGift(data);
      } catch (e) {
        setError("This link is invalid or expired.");
      } finally {
        setLoading(false);
      }
    }

    loadGift();
  }, [id]);

  if (loading) {
    return <div style={{ padding: 24 }}>Loading your gift…</div>;
  }

  if (error) {
    return (
      <div style={{ padding: 24 }}>
        <h2>We couldn’t open this gift.</h2>
        <p>{error}</p>
        <p>
          <a href="/">Go home</a>
        </p>
      </div>
    );
  }

  if (!gift) {
    return (
      <div style={{ padding: 24 }}>
        <h2>We couldn’t open this gift.</h2>
        <p>This link is invalid or expired.</p>
        <p>
          <a href="/">Go home</a>
        </p>
      </div>
    );
  }

  return (
    <div style={{ padding: 24 }}>
      <h2>You received a ThankuMail</h2>

      {gift.message ? (
        <p style={{ marginTop: 12, whiteSpace: "pre-wrap" }}>{gift.message}</p>
      ) : (
        <p style={{ marginTop: 12, opacity: 0.8 }}>A message first.</p>
      )}

      <p style={{ marginTop: 12 }}>
        <b>Amount:</b> ${(gift.amount / 100).toFixed(2)}
      </p>

      {gift.senderEmail && (
        <p>
          <b>From:</b> {gift.senderEmail}
        </p>
      )}

      {gift.isClaimed ? (
        <p style={{ marginTop: 18, color: "#b00" }}>This gift has already been claimed.</p>
      ) : (
        <button
          style={{
            marginTop: 18,
            padding: "10px 14px",
            borderRadius: 8,
            border: "none",
            background: "#111",
            color: "#fff",
            cursor: "pointer",
          }}
          onClick={async () => {
            try {
              const res = await fetch(`/api/gifts/${id}/claim`, {
                method: "POST",
                headers: { Accept: "application/json" },
              });

              if (!res.ok) {
                const text = await res.text().catch(() => "");
                console.error("Claim failed:", res.status, text);
                throw new Error(`Claim failed (${res.status})`);
              }

              await res.json().catch(() => null);
              setGift({ ...gift, isClaimed: true });
              alert("Gift claimed!");
            } catch (e) {
              alert("Failed to claim gift. Please try again.");
            }
          }}
        >
          Claim your gift
        </button>
      )}
    </div>
  );
}
