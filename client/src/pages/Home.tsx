import React, { useMemo, useState } from "react";
import CreateGiftForm from "../components/CreateGiftForm";

function absoluteLink(pathOrUrl: string) {
  if (!pathOrUrl) return pathOrUrl;
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const path = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
  return `${origin}${path}`;
}

function safeText(v: any) {
  return typeof v === "string" ? v : "";
}

export default function Home() {
  const [copied, setCopied] = useState(false);

  const lastPublicId = useMemo(() => {
    try {
      return safeText(localStorage.getItem("tm_last_publicId") || "");
    } catch {
      return "";
    }
  }, []);

  const claimUrl = useMemo(() => {
    if (!lastPublicId) return "";
    return absoluteLink(`/claim/${encodeURIComponent(lastPublicId)}`);
  }, [lastPublicId]);

  async function copyLink() {
    if (!claimUrl) return;
    try {
      await navigator.clipboard.writeText(claimUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-white via-white to-violet-50 text-slate-900">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-2xl bg-violet-600 shadow-sm" />
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight">ThanküMail</div>
            <div className="text-xs text-slate-500">Send a gift with a real message.</div>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl grid-cols-1 gap-10 px-6 pb-20 pt-6 lg:grid-cols-2">
        <section>
          <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">
            A small gift.
            <span className="block text-violet-700">A message they’ll remember.</span>
          </h1>
          <p className="mt-4 max-w-xl text-base leading-relaxed text-slate-600">
            Your words arrive first. The gift follows when they’re ready.
          </p>

          {claimUrl ? (
            <div className="mt-6 rounded-3xl border border-violet-100 bg-white p-5 text-sm text-slate-700 shadow-sm">
              <div className="font-semibold text-slate-900">Last ThanküMail link</div>
              <div className="mt-2 break-all rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 font-mono text-xs text-slate-800">
                {claimUrl}
              </div>

              <div className="mt-3 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={copyLink}
                  className="rounded-2xl bg-violet-600 px-5 py-3 text-sm font-semibold text-white hover:bg-violet-700"
                >
                  {copied ? "Copied" : "Copy link"}
                </button>

                <a
                  href={claimUrl}
                  className="rounded-2xl bg-white px-5 py-3 text-sm font-semibold text-slate-700 ring-1 ring-slate-200 hover:ring-violet-200"
                >
                  Open claim page →
                </a>
              </div>

              <div className="mt-2 text-xs text-slate-500">
                Tip: This saves your latest link in your browser so you can grab it again easily.
              </div>
            </div>
          ) : null}
        </section>

        <section>
          {/* Presets + CAPTCHA live inside CreateGiftForm */}
          <CreateGiftForm />
        </section>
      </main>
    </div>
  );
}
