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
      className="min-h-screen text-white"
      style={{
        backgroundImage: "url(/images/hero-background.png)",
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
      }}
    >
      {/* soft dark overlay for readability */}
      <div className="min-h-screen bg-black/40">
        <main id="send" className="mx-auto max-w-5xl px-4 pt-10 pb-16">
          <div
            className={[
              "flex flex-col items-center text-center transition-all duration-700 ease-out",
              mounted ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3",
            ].join(" ")}
          >
            <h1 className="font-quicksand text-5xl sm:text-6xl md:text-7xl font-semibold tracking-tight drop-shadow-lg">
              {wordmark}
            </h1>

            <div className="mt-2 text-white/95 text-sm sm:text-base font-medium tracking-wide">
              Anonymous Appreciation
            </div>

            <div className="mt-2 text-sm sm:text-base text-white/85">
              No strings attached.
            </div>
          </div>

          <div className="mt-8 rounded-2xl bg-white/95 backdrop-blur shadow-soft border border-white/20 p-6 text-tm-charcoal">
            <CreateGiftForm />
          </div>

          <footer className="mt-10 text-center text-sm text-white/80">
            {wordmark} is designed to be calm, honest, and human.
          </footer>
        </main>
      </div>
    </div>
  );
}
