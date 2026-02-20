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
          headers: { Authorization: `Bearer ${token}` },
        });

        const j: any = await r.json().catch(() => ({}));
        if (cancelled) return;

        if (!r.ok || !j?.ok) {
          localStorage.removeItem(STORAGE_KEY);
          setLocation("/login");
          return;
        }

        window.history.replaceState({}, document.title, "/auth/google");
        setLocation("/");
      } catch {
        if (cancelled) return;
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
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-sm text-center">
        <div className="text-lg font-semibold">Signing you in…</div>
      </div>
    </div>
  );
}