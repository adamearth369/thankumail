import { useEffect, useState } from "react";

type Supporter = {
  name: string | null;
  anonymous: boolean;
};

const API_BASE = "https://api.thankumail.com";

export default function Supporters() {
  const [supporters, setSupporters] = useState<Supporter[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_BASE}/api/supporters`)
      .then((r) => r.json())
      .then((data) => {
        setSupporters(Array.isArray(data?.supporters) ? data.supporters : []);
        setLoading(false);
      })
      .catch(() => {
        setSupporters([]);
        setLoading(false);
      });
  }, []);

  return (
    <div className="min-h-screen bg-tm-charcoal text-tm-cream px-6 py-24">
      <div className="mx-auto max-w-4xl">
        <div className="text-center">
          <h1 className="font-outfit text-3xl md:text-5xl font-semibold text-tm-cream">
            Thank You to Our Supporters
          </h1>

          <p className="mx-auto mt-4 max-w-2xl text-sm md:text-base text-tm-cream/75 leading-relaxed">
            These are the people who believed in thankumail early.
            <br />
            Some chose to be named.
            <br />
            Others chose to remain anonymous.
          </p>
        </div>

        <div className="mt-12 rounded-2xl border border-white/10 bg-white/5 p-6 md:p-8 shadow-soft">
          {loading ? (
            <div className="text-center text-sm text-tm-cream/70">Loading supporters...</div>
          ) : supporters.length === 0 ? (
            <div className="text-center text-sm text-tm-cream/70">No supporters listed yet.</div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
              {supporters.map((supporter, index) => (
                <div
                  key={`${supporter.name || "anonymous"}-${index}`}
                  className="rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-center text-sm text-tm-cream"
                >
                  {supporter.anonymous ? "Anonymous" : supporter.name || "Anonymous"}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}