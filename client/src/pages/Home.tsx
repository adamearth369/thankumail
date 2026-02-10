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
    <div className="relative min-h-screen text-white overflow-hidden">
      {/* Background Image */}
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{
          backgroundImage: "url('/images/hero-background.png')",
        }}
      />

      {/* Soft dark overlay for readability */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" />

      {/* Content */}
      <main className="relative z-10 mx-auto max-w-5xl px-4 pt-14 pb-20">
        <div
          className={[
            "flex flex-col items-center text-center transition-all duration-700 ease-out",
            mounted ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3",
          ].join(" ")}
        >
          <h1 className="font-quicksand text-5xl sm:text-6xl md:text-7xl font-semibold tracking-tight drop-shadow-2xl">
            {wordmark}
          </h1>

          <div className="mt-3 text-white/95 text-sm sm:text-base font-medium tracking-wide">
            Anonymous Appreciation
          </div>

          <div className="mt-2 text-sm sm:text-base text-white/85">
            No strings attached.
          </div>
        </div>

        <div className="mt-10 rounded-2xl bg-white/95 backdrop-blur shadow-soft border border-white/30 p-6 text-tm-charcoal">
          <CreateGiftForm />
        </div>

        <footer className="mt-12 text-center text-sm text-white/80 drop-shadow">
          {wordmark} is designed to be calm, honest, and human.
        </footer>
      </main>
    </div>
  );
}
