import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

type Gift = {
  publicId: string;
  amount: number;
  message?: string;
  senderEmail?: string;
  isClaimed: boolean;
};

export default function Claim() {
  const { id } = useParams();
  const [gift, setGift] = useState<Gift | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) {
      setError("Missing gift ID.");
      setLoading(false);
      return;
    }

    async function loadGift() {
      try {
        const res = await fetch(`/api/gifts/${id}`, {
          headers: { Accept: "application/json" },
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Fetch failed (${res.status}): ${text}`);
        }

        const data = await res.json();
        setGift(data);
      } catch (e: any) {
        console.error("Claim load error:", e);
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

      {gift.message && (
        <p style={{ marginTop: 12, whiteSpace: "pre-wrap" }}>
          {gift.message}
        </p>
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
        <p style={{ marginTop: 18, color: "#b00" }}>
          This gift has already been claimed.
        </p>
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
                const text = await res.text();
                throw new Error(`Claim failed (${res.status}): ${text}`);
              }

              const data = await res.json();
              setGift({ ...gift, isClaimed: true });
              alert("Gift claimed!");
            } catch (e: any) {
              console.error("Claim error:", e);
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
