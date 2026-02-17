// WHERE TO PASTE: client/src/pages/Home.tsx
// ACTION: Full file replacement (paste exactly)

import React, { useEffect, useMemo, useState } from "react";
import CreateGiftForm from "../components/CreateGiftForm";

export default function Home() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 30);
    return () => clearTimeout(t);
  }, []);

  const wordmark = useMemo(() => "thankümail", []);

  return (
    <div className="min-h-screen bg-tm-cream text-tm-charcoal">
      <main className="mx-auto max-w-5xl px-4 pt-10 pb-16">
        <div
          className={[
            "flex flex-col items-center text-center transition-all duration-700 ease-out",
            mounted ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3",
          ].join(" ")}
        >
          <h1 className="font-quicksand text-5xl sm:text-6xl md:text-7xl font-semibold tracking-tight text-tm-charcoal">
            {wordmark}
          </h1>

          <div className="mt-3 text-tm-charcoal/85 text-base sm:text-lg font-medium tracking-wide">
            Anonymous appreciation by email.
          </div>

          <div className="mt-2 text-sm sm:text-base text-tm-charcoal/70">
            One message. One moment. No account required.
          </div>

          <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-tm-charcoal/15 bg-white/70 px-3 py-1 text-[12px] text-tm-charcoal/80">
            <span className="inline-block h-2 w-2 rounded-full bg-tm-forest" />
            Guest mode: preset note + email delivery
          </div>

          <div className="mt-4 max-w-xl text-tm-charcoal/70 text-sm leading-relaxed">
            Choose a short thank-you message and send it instantly.
            <br />
            The recipient opens it on a private claim page.
          </div>
        </div>

        <div className="mt-8">
          <CreateGiftForm />
        </div>

        <footer className="mt-10 text-center text-sm text-tm-charcoal/60">
          Designed to feel calm, honest, and human.
        </footer>
      </main>
    </div>
  );
}
