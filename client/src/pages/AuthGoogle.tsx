import React, { useEffect } from "react";

const API_BASE = "https://api.thankumail.com";

export default function AuthGoogle() {
  useEffect(() => {
    async function run() {
      try {
        const path = window.location.pathname;

        if (path === "/auth/google/success") {
          const r = await fetch(`${API_BASE}/api/auth/me`, {
            method: "GET",
            credentials: "include",
          });

          const j: any = await r.json().catch(() => ({}));

          if (r.ok && j?.ok) {
            window.location.replace("/");
            return;
          }

          window.location.replace("/login");
          return;
        }

        window.location.href = `${API_BASE}/api/auth/google`;
      } catch {
        window.location.replace("/login");
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