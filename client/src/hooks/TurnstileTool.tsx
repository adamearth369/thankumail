import React, { useEffect, useRef, useState } from "react";

const SITE_KEY = "0x4AAAAAACXaTgda6akpnmmC";

function getTurnstile(): any {
  return (window as any).turnstile;
}

export default function TurnstileTool() {
  const widgetIdRef = useRef<any>(null);
  const renderedRef = useRef(false);
  const tokenRef = useRef<string>("");

  const [token, setToken] = useState("");
  const [ready, setReady] = useState(false);
  const [booting, setBooting] = useState(true);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    if (getTurnstile()) {
      setBooting(false);
      return;
    }

    const existing = document.querySelector<HTMLScriptElement>('script[data-turnstile="1"]');
    if (existing) {
      setBooting(false);
      return;
    }

    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.setAttribute("data-turnstile", "1");

    script.onload = () => setBooting(false);
    script.onerror = () => {
      setBooting(false);
      setBlocked(true);
    };

    document.body.appendChild(script);
  }, []);

  useEffect(() => {
    if (booting) return;
    if (blocked) return;
    if (renderedRef.current) return;

    const el = document.getElementById("ts-tool");
    const ts = getTurnstile();
    if (!el || !ts) return;

    try {
      const id = ts.render(el, {
        sitekey: SITE_KEY,
        appearance: "always",
        size: "normal",
        callback: (t: string) => {
          tokenRef.current = t || "";
          setToken(t || "");
          setReady(!!t);
        },
        "expired-callback": () => {
          tokenRef.current = "";
          setToken("");
          setReady(false);
        },
        "error-callback": () => {
          tokenRef.current = "";
          setToken("");
          setReady(false);
          setBlocked(true);
        },
      });

      widgetIdRef.current = id;
      renderedRef.current = true;
    } catch {}
  }, [booting, blocked]);

  function copyToken() {
    if (!tokenRef.current) return;
    navigator.clipboard.writeText(tokenRef.current);
  }

  function resetWidget() {
    const ts = getTurnstile();
    if (ts && widgetIdRef.current !== null) ts.reset(widgetIdRef.current);
    tokenRef.current = "";
    setToken("");
    setReady(false);
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 p-10">
      <div className="max-w-xl mx-auto bg-white rounded-2xl shadow p-6">
        <h1 className="text-2xl font-bold mb-2">Turnstile Token Tool</h1>
        <p className="text-sm text-slate-600 mb-4">
          Generate a fresh token, copy, then immediately run PowerShell test.
        </p>

        <div id="ts-tool" className="min-h-[80px] flex items-center justify-center mb-4" />

        {blocked && (
          <div className="text-red-600 text-sm mb-4">
            Turnstile blocked by browser/adblock.
          </div>
        )}

        <textarea
          value={token}
          readOnly
          className="w-full h-40 text-xs p-2 border rounded mb-4"
        />

        <div className="flex gap-3">
          <button
            onClick={copyToken}
            disabled={!ready}
            className="px-4 py-2 bg-green-600 text-white rounded disabled:opacity-40"
          >
            Copy Token
          </button>

          <button
            onClick={resetWidget}
            className="px-4 py-2 bg-slate-600 text-white rounded"
          >
            New Token
          </button>
        </div>
      </div>
    </div>
  );
}
