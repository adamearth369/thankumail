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
    <div
      className="min-h-screen text-white bg-cover bg-center bg-no-repeat"
      style={{ backgroundImage: "url('/images/hero-background.png')" }}
    >
      <div className="min-h-screen bg-black/40">
        <main className="mx-auto max-w-5xl px-4 pt-10 pb-16">
          <div
            className={[
              "flex flex-col items-center text-center transition-all duration-700 ease-out",
              mounted ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3",
            ].join(" ")}
          >
            <h1 className="font-quicksand text-5xl sm:text-6xl md:text-7xl font-semibold tracking-tight drop-shadow-lg">
              {wordmark}
            </h1>

            <div className="mt-3 text-white/95 text-base sm:text-lg font-medium tracking-wide">
              Anonymous appreciation by email.
            </div>

            <div className="mt-2 text-sm sm:text-base text-white/85">
              One message. One moment. No account required.
            </div>

            <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-[12px] text-white/90">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-300" />
              Guest mode: preset note + email delivery
            </div>

            <div className="mt-4 max-w-xl text-white/85 text-sm leading-relaxed">
              Choose a short thank-you message and send it instantly.
              <br />
              The recipient verifies and receives it on a private claim page.
            </div>
          </div>

          <div className="mt-8 rounded-2xl bg-white/95 backdrop-blur shadow-soft border border-white/20 p-6 text-slate-900">
            <CreateGiftForm />
          </div>

          <footer className="mt-10 text-center text-sm text-white/80">
            Designed to feel calm, honest, and human.
          </footer>
        </main>
      </div>
    </div>
  );
}
