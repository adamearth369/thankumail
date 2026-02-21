import React, { useEffect } from "react";
import { useLocation } from "wouter";

const API_BASE = "https://api.thankumail.com";
const STORAGE_KEY = "tm_session_token";

function getTokenFromHash(): string {
  const raw = String(window.location.hash || "");
  const hash = raw.startsWith("#") ? raw.slice(1) : raw;
  const params = new URLSearchParams(hash);
  return String(params.get("token") || "").trim();
}

export default function AuthGoogle() {
  const [, setLocation] = useLocation();

  useEffect(() => {
    // If we landed here WITHOUT a token, start OAuth.
    // Backend will redirect to Google, then back to /auth/google#token=...
    if (!window.location.hash) {
      window.location.href = `${API_BASE}/api/auth/google`;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      const token = getTokenFromHash();
      if (!token) return;

      try {
        // Persist session token for future requests
        localStorage.setItem(STORAGE_KEY, token);

        // Validate session
        const r = await fetch(`${API_BASE}/api/auth/me`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        });

        const j: any = await r.json().catch(() => ({}));
        if (cancelled) return;

        if (!r.ok || !j?.ok) {
          localStorage.removeItem(STORAGE_KEY);
          // Clean hash then return home (Home will show guest mode)
          window.history.replaceState({}, document.title, "/auth/google");
          setLocation("/");
          return;
        }

        // Clean the URL and return home
        window.history.replaceState({}, document.title, "/auth/google");
        setLocation("/");
      } catch {
        if (cancelled) return;
        localStorage.removeItem(STORAGE_KEY);
        window.history.replaceState({}, document.title, "/auth/google");
        setLocation("/");
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [setLocation]);

  const hasToken = Boolean(getTokenFromHash());

  return (
    <div className="min-h-screen bg-tm-cream flex items-center justify-center px-6">
      <div className="w-full max-w-sm text-center rounded-2xl border border-tm-charcoal/20 bg-white p-5 shadow-soft text-tm-charcoal">
        <div className="text-lg font-outfit font-semibold tracking-tight">Signing you in…</div>
        <div className="mt-2 text-sm text-tm-charcoal/70">
          {hasToken ? "Finishing login." : "Redirecting to Google."}
        </div>
      </div>
    </div>
  );
}