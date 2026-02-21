// WHERE TO PASTE: client/src/pages/Home.tsx
// ACTION: Full file replacement (paste exactly)

import React, { useEffect, useMemo, useState } from "react";
import CreateGiftForm from "../components/CreateGiftForm";

type VersionInfo = {
  commit: string;
  builtAt: string;
};

export default function Home() {
  const [mounted, setMounted] = useState(false);
  const [version, setVersion] = useState<VersionInfo | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 30);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    fetch("/version.json")
      .then((r) => r.json())
      .then(setVersion)
      .catch(() => {});
  }, []);

  const wordmark = useMemo(() => "thankümail", []);

  return (
    <div
      className="min-h-screen bg-cover bg-center bg-no-repeat text-tm-charcoal"
      style={{ backgroundImage: "url('/images/hero-background.png')" }}
    >
      <div className="min-h-screen bg-black/30">
        <main className="mx-auto max-w-5xl px-4 pt-10 pb-16">
          <div
            className={[
              "flex flex-col items-center text-center transition-all duration-700 ease-out",
              mounted ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3",
            ].join(" ")}
          >
            <h1 className="font-quicksand text-5xl sm:text-6xl md:text-7xl font-semibold tracking-tight text-white drop-shadow-lg">
              {wordmark}
            </h1>

            <div className="mt-3 text-white/95 text-base sm:text-lg font-medium tracking-wide">
              Anonymous Appreciation
            </div>

            <div className="mt-2 text-sm sm:text-base text-white/85">No Strings Attached</div>

            <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-[12px] text-white/90">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-300" />
              Guest mode: preset note + email delivery
            </div>

            {/* Standardized sign-in entrypoint */}
            <div className="mt-4">
              <a
                href="/login"
                className="inline-flex items-center justify-center rounded-full border border-white/25 bg-white/10 px-4 py-2 text-sm text-white/90 hover:bg-white/15 hover:text-white transition"
              >
                Registered sign in
              </a>
            </div>
          </div>

          <div className="mt-8">
            <CreateGiftForm />
          </div>

          <footer className="mt-10 text-center text-sm text-white/80">
            Designed to feel calm, honest, and human.
            {version && (
              <div className="mt-2 text-[10px] opacity-60">build {version.commit.slice(0, 7)}</div>
            )}
          </footer>
        </main>
      </div>
    </div>
  );
}