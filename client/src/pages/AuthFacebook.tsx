// WHERE TO PASTE: client/src/pages/AuthFacebook.tsx
// ACTION: Full file contents

import { useEffect } from "react";
import { useLocation } from "wouter";

const API_BASE = "https://api.thankumail.com";
const STORAGE_KEY = "tm_session_token";

function getTokenFromHash(): string {
  const raw = String(window.location.hash || "");
  const hash = raw.startsWith("#") ? raw.slice(1) : raw;
  const params = new URLSearchParams(hash);
  return String(params.get("token") || "").trim();
}

export default function AuthFacebook() {
  const [, setLocation] = useLocation();

  useEffect(() => {
    let cancelled = false;

    async function run() {
      const token = getTokenFromHash();

      if (!token) {
        setLocation("/login");
        return;
      }

      try {
        localStorage.setItem(STORAGE_KEY, token);

        const r = await fetch(`${API_BASE}/api/auth/me`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (!r.ok) {
          localStorage.removeItem(STORAGE_KEY);
          setLocation("/login");
          return;
        }

        if (!cancelled) {
          setLocation("/");
        }
      } catch {
        localStorage.removeItem(STORAGE_KEY);
        setLocation("/login");
      }
    }

    run();

    return () => {
      cancelled = true;
    };
  }, [setLocation]);

  return (
    <div className="min-h-[70vh] flex items-center justify-center px-4">
      <div className="rounded-2xl border border-tm-charcoal/20 bg-white p-6 shadow-soft text-tm-charcoal">
        <div className="text-lg font-outfit font-semibold">Signing you in…</div>
        <div className="mt-2 text-sm text-tm-charcoal/70">Completing Facebook authentication.</div>
      </div>
    </div>
  );
}