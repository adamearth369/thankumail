import React, { useEffect } from "react";

const API_BASE = "https://api.thankumail.com";

export default function AuthFacebook() {
  useEffect(() => {
    async function run() {
      try {
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
      } catch {
        window.location.replace("/login");
      }
    }

    run();
  }, []);

  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      <div className="w-full max-w-md rounded-2xl border border-tm-charcoal/20 bg-white p-6 shadow-soft text-tm-charcoal">
        <div className="text-xl font-outfit font-semibold">Signing you in…</div>
        <div className="mt-2 text-sm text-tm-charcoal/75">Finishing Facebook sign-in.</div>
      </div>
    </div>
  );
}