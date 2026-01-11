import React, { useMemo, useState } from "react";

type CreateGiftResponse =
  | { success: true; giftId: string; claimLink: string }
  | { error: string; issues?: Array<{ path: (string | number)[]; message: string }> };

function centsFromDollarsInput(input: string): number {
  // Accepts "10", "10.00", "10.5" etc. Converts safely to cents.
  const cleaned = input.replace(/[^\d.]/g, "");
  if (!cleaned) return 0;
  const parts = cleaned.split(".");
  const dollars = parseInt(parts[0] || "0", 10);
  const cents = parseInt(((parts[1] || "") + "00").slice(0, 2), 10);
  if (!Number.isFinite(dollars) || !Number.isFinite(cents)) return 0;
  return dollars * 100 + cents;
}

function formatDollarsFromCents(cents: number): string {
  const v = Math.max(0, Math.floor(cents));
  const dollars = Math.floor(v / 100);
  const rem = v % 100;
  return `${dollars}.${rem.toString().padStart(2, "0")}`;
}

function getIssueMap(issues?: Array<{ path: (string | number)[]; message: string }>) {
  const map: Record<string, string> = {};
  for (const i of issues || []) {
    const key = (i.path?.[0] ?? "").toString();
    if (key && !map[key]) map[key] = i.message || "Invalid value";
  }
  return map;
}

export default function Home() {
  const [recipientEmail, setRecipientEmail] = useState("");
  const [message, setMessage] = useState("");
  const [amountStr, setAmountStr] = useState("10.00");

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ giftId: string; claimLink: string } | null>(null);

  const amountCents = useMemo(() => centsFromDollarsInput(amountStr), [amountStr]);
  const amountPreview = useMemo(() => formatDollarsFromCents(amountCents), [amountCents]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setApiError(null);
    setFieldErrors({});
    setResult(null);

    const localErrors: Record<string, string> = {};
    if (!recipientEmail.trim()) localErrors.recipientEmail = "Recipient email is required.";
    if (!message.trim()) localErrors.message = "Message is required.";
    if (amountCents < 1000) localErrors.amount = "Minimum is $10.00.";

    if (Object.keys(localErrors).length) {
      setFieldErrors(localErrors);
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch("/api/gifts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipientEmail: recipientEmail.trim(),
          message: message.trim(),
          amount: amountCents, // cents
        }),
      });

      const data = (await res.json().catch(() => null)) as CreateGiftResponse | null;

      if (!res.ok) {
        const issues = data && "issues" in data ? data.issues : undefined;
        const issueMap = getIssueMap(issues);
        if (Object.keys(issueMap).length) setFieldErrors(issueMap);

        const msg =
          (data && "error" in data && data.error) ||
          (data && "message" in (data as any) && (data as any).message) ||
          "Something went wrong. Please try again.";
        setApiError(msg);
        return;
      }

      if (data && "success" in data && data.success) {
        setResult({ giftId: data.giftId, claimLink: data.claimLink });
        return;
      }

      setApiError("Unexpected response. Please try again.");
    } catch {
      setApiError("Network error. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#fbfaf9] text-neutral-900">
      {/* Soft warm header wash */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-gradient-to-b from-purple-50/70 via-white to-transparent" />

      <div className="relative mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
        {/* Header */}
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-9 w-9 rounded-2xl bg-purple-600/90 shadow-sm" />
            <div className="leading-tight">
              <div className="font-[Outfit] text-lg font-bold tracking-tight">ThankuMail</div>
              <div className="text-xs text-neutral-500">Send gratitude. Simply.</div>
            </div>
          </div>

          <nav className="hidden items-center gap-6 text-sm text-neutral-600 sm:flex">
            <a href="#how" className="hover:text-neutral-900">
              How it works
            </a>
            <a href="#trust" className="hover:text-neutral-900">
              Trust
            </a>
          </nav>
        </header>

        {/* Hero + Form */}
        <section className="mt-10 grid gap-10 lg:grid-cols-2 lg:items-start">
          {/* Left: copy */}
          <div className="max-w-xl">
            <h1 className="font-[Outfit] text-4xl font-extrabold tracking-tight sm:text-5xl">
              Send gratitude.
              <span className="block text-purple-700">Simply.</span>
            </h1>

            <p className="mt-4 text-lg leading-relaxed text-neutral-700">
              A small gift. A real moment. No awkwardness. ThankuMail helps you share appreciation (or a gentle
              “thinking of you”) with a private, one-time link.
            </p>

            <div className="mt-7 flex flex-wrap items-center gap-3">
              <a
                href="#send"
                className="inline-flex items-center justify-center rounded-2xl bg-purple-700 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-purple-800 focus:outline-none focus:ring-2 focus:ring-purple-400"
              >
                Send a ThankuMail
              </a>

              <a
                href="#how"
                className="inline-flex items-center justify-center rounded-2xl px-4 py-3 text-sm font-semibold text-purple-700 hover:bg-purple-50 focus:outline-none focus:ring-2 focus:ring-purple-200"
              >
                See how it works →
              </a>
            </div>

            <div className="mt-8 rounded-3xl border border-neutral-200 bg-white/70 p-5 shadow-sm">
              <p className="text-sm text-neutral-600">
                “Thank you” lands different when it’s quiet, sincere, and doesn’t ask for anything back.
              </p>
              <p className="mt-2 text-xs text-neutral-500">— The ThankuMail vibe</p>
            </div>
          </div>

          {/* Right: form card */}
          <div id="send" className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-[Outfit] text-xl font-bold tracking-tight">Create a gift</h2>
                <p className="mt-1 text-sm text-neutral-600">Write a message, choose an amount, send the link.</p>
              </div>
              <div className="rounded-2xl bg-purple-50 px-3 py-2 text-xs font-semibold text-purple-800">
                Min $10.00
              </div>
            </div>

            <form className="mt-6 space-y-4" onSubmit={onSubmit}>
              <div>
                <label className="text-sm font-semibold text-neutral-800">Recipient email</label>
                <input
                  value={recipientEmail}
                  onChange={(e) => setRecipientEmail(e.target.value)}
                  placeholder="friend@example.com"
                  className="mt-2 w-full rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-purple-300 focus:ring-2 focus:ring-purple-100"
                />
                {fieldErrors.recipientEmail ? (
                  <p className="mt-1 text-xs text-red-600">{fieldErrors.recipientEmail}</p>
                ) : null}
              </div>

              <div>
                <label className="text-sm font-semibold text-neutral-800">Message</label>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Say the thing you’d want to hear."
                  rows={5}
                  maxLength={1000}
                  className="mt-2 w-full resize-none rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-purple-300 focus:ring-2 focus:ring-purple-100"
                />
                <div className="mt-1 flex items-center justify-between text-xs text-neutral-500">
                  <span>{fieldErrors.message ? <span className="text-red-600">{fieldErrors.message}</span> : " "}</span>
                  <span>{message.length}/1000</span>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="text-sm font-semibold text-neutral-800">Amount (CAD
