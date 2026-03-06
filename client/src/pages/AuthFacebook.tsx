import React, { useEffect } from "react";
import { useLocation } from "wouter";

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
    const token = getTokenFromHash();

    if (!token) {
      setLocation("/login");
      return;
    }

    try {
      localStorage.setItem(STORAGE_KEY, token);
    } catch {}

    // Optional: quick verification (non-blocking)
    fetch("https://api.thankumail.com/api/auth/me", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(() => {})
      .catch(() => {});

    setLocation("/");
  }, [setLocation]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      <div className="w-full max-w-md rounded-2xl border border-tm-charcoal/20 bg-white p-6 shadow-soft text-tm-charcoal">
        <div className="text-xl font-outfit font-semibold">Signing you in…</div>
        <div className="mt-2 text-sm text-tm-charcoal/75">Finishing Facebook sign-in.</div>
      </div>
    </div>
  );
}