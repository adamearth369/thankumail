import React, { useEffect } from "react";

const API_BASE = "https://api.thankumail.com";
const STORAGE_KEY = "tm_session_token";

function getTokenFromHash(): string {
  const raw = String(window.location.hash || "");
  const hash = raw.startsWith("#") ? raw.slice(1) : raw;
  const params = new URLSearchParams(hash);
  return String(params.get("token") || "").trim();
}

function clearSession() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

function setToken(token: string) {
  try {
    localStorage.setItem(STORAGE_KEY, token);
  } catch {}
}

function stripHash() {
  try {
    window.history.replaceState({}, document.title, "/auth/google");
  } catch {}
}

export default function AuthGoogle() {
  useEffect(() => {
    async function run() {
      const token = getTokenFromHash();

      // If user directly visits /auth/google without token, start OAuth
      if (!token) {
        window.location.href = `${API_BASE}/api/auth/google`;
        return;
      }

      try {
        setToken(token);

        const r = await fetch(`${API_BASE}/api/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        const j: any = await r.json().catch(() => ({}));

        if (!r.ok || !j?.ok) {
          clearSession();
        }

        stripHash();
        window.location.replace("/");
      } catch {
        clearSession();
        stripHash();
        window.location.replace("/");
      }
    }

    run();
  }, []);

  return (
    <div className="min-h-screen bg-tm-cream flex items-center justify-center px-6">
      <div className="w-full max-w-sm text-center rounded-2xl border border-tm-charcoal/20 bg-white p-5 shadow-soft text-tm-charcoal">
        <div className="text-lg font-outfit font-semibold tracking-tight">Signing you in…</div>
        <div className="mt-2 text-sm text-tm-charcoal/70">Finishing login.</div>
      </div>
    </div>
  );
}