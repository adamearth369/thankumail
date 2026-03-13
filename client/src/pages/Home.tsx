import React, { useEffect, useMemo, useState } from "react";
import CreateGiftForm from "../components/CreateGiftForm";

const API_BASE = "https://api.thankumail.com";

async function fetchAuthState(): Promise<boolean> {
  try {
    const r = await fetch(`${API_BASE}/api/auth/me`, {
      method: "GET",
      credentials: "include",
    });

    const j: any = await r.json().catch(() => ({}));
    return Boolean(r.ok && j?.ok);
  } catch {
    return false;
  }
}

export default function Home() {
  const [mounted, setMounted] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 30);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    let alive = true;

    const sync = async () => {
      const authed = await fetchAuthState();
      if (alive) setLoggedIn(authed);
    };

    sync();

    const onFocus = () => {
      void sync();
    };

    window.addEventListener("focus", onFocus);

    return () => {
      alive = false;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  const wordmark = useMemo(() => "thankümail", []);

  async function handleSignOut() {
    try {
      await fetch(`${API_BASE}/api/auth/logout`, {
        method: "POST",
        credentials: "include",
      });
    } catch {}

    window.location.href = "/";
  }

  return (
    <div
      className="min-h-screen bg-cover bg-center bg-no-repeat text-tm-charcoal"
      style={{ backgroundImage: "url('/images/hero-background.png')" }}
    >
      <div className="min-h-screen bg-black/35">
        <main className="mx-auto max-w-5xl px-4 pt-24 pb-16">
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

            <div className="mt-2 text-sm sm:text-base text-white/85">
              No Strings Attached
            </div>

            <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-[12px] text-white/90">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-300" />
              Guest mode: preset note + email delivery
            </div>

            {!loggedIn && (
              <div className="mt-4">
                <a
                  href="/login"
                  className="inline-flex items-center justify-center rounded-full border border-white/25 bg-white/10 px-4 py-2 text-sm text-white/90 hover:bg-white/15 hover:text-white transition"
                >
                  Registered sign in
                </a>
              </div>
            )}

            {loggedIn && (
              <div className="mt-4 flex items-center gap-3">
                <div className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-4 py-2 text-sm text-white/90">
                  Signed in
                </div>

                <button
                  onClick={handleSignOut}
                  className="inline-flex items-center justify-center rounded-full border border-white/25 bg-white/10 px-4 py-2 text-sm text-white/90 hover:bg-white/15 hover:text-white transition"
                >
                  Sign out
                </button>
              </div>
            )}
          </div>

          <div className="mt-8">
            <CreateGiftForm />
          </div>

          <footer className="mt-12 text-center text-xs sm:text-sm text-white/80">
            <div className="flex flex-wrap justify-center gap-4">
              <a href="/terms" className="hover:text-white underline underline-offset-4">
                Terms of Service
              </a>
              <span className="opacity-60">•</span>
              <a href="/privacy" className="hover:text-white underline underline-offset-4">
                Privacy Policy
              </a>
            </div>

            <div className="mt-2 text-white/60 text-[11px]">
              © {new Date().getFullYear()} thankümail
            </div>
          </footer>
        </main>
      </div>
    </div>
  );
}