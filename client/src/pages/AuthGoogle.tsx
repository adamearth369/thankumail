// WHERE TO PASTE: client/src/pages/AuthGoogle.tsx
// ACTION: Full file replacement (paste exactly)

import React, { useEffect } from "react";
import { useLocation } from "wouter";

const API_BASE = "https://api.thankumail.com";

// Canonical token key
const STORAGE_KEY = "tm_session_token";

// Legacy keys we must clear (defensive)
const LEGACY_KEYS = ["tmSessionToken", "sessionToken", "tm_token", "token"];

function getTokenFromHash(): string {
  const raw = String(window.location.hash || "");
  const hash = raw.startsWith("#") ? raw.slice(1) : raw;
  const params = new URLSearchParams(hash);
  return String(params.get("token") || "").trim();
}

function clearAllSessionKeys() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    for (const k of LEGACY_KEYS) localStorage.removeItem(k);
  } catch {
    // ignore
  }
}

function setCanonicalToken(token: string) {
  try {
    const t = String(token || "").trim();
    if (!t) return;
    localStorage.setItem(STORAGE_KEY, t);
  } catch {
    // ignore
  }
}

function stripHashAndKeepPath() {
  try {
    // Keep this route but remove #token=... so refreshes don't re-run token parsing
    window.history.replaceState({}, document.title, "/auth/google");
  } catch {
    // ignore
  }
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
        // Always clear legacy keys first, then store only the canonical token
        clearAllSessionKeys();
        setCanonicalToken(token);

        // Validate session
        const r = await fetch(`${API_BASE}/api/auth/me`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        });

        const j: any = await r.json().catch(() => ({}));
        if (cancelled) return;

        if (!r.ok || !j?.ok) {
          clearAllSessionKeys();
          stripHashAndKeepPath();
          window.location.replace("/");
          return;
        }

        // Clean the URL and hard-navigate home so the app re-inits cleanly
        stripHashAndKeepPath();
        window.location.replace("/");
      } catch {
        if (cancelled) return;
        clearAllSessionKeys();
        stripHashAndKeepPath();
        window.location.replace("/");
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