                      import React, { useMemo, useState } from "react";

                      type CreateGiftResponse =
                        | { success: true; giftId: string; claimLink: string; email?: { ok: boolean } }
                        | { error: string; issues?: any[]; field?: string };

                      function moneyToCents(dollars: number) {
                        const cents = Math.round(dollars * 100);
                        return Number.isFinite(cents) ? cents : 0;
                      }

                      function centsToMoney(cents: number) {
                        return (cents / 100).toFixed(2);
                      }

                      function isEmail(s: string) {
                        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
                      }

                      function absoluteLink(maybeRelative: string) {
                        if (!maybeRelative) return maybeRelative;
                        if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;
                        const origin = typeof window !== "undefined" ? window.location.origin : "";
                        const path = maybeRelative.startsWith("/") ? maybeRelative : `/${maybeRelative}`;
                        return `${origin}${path}`;
                      }

                      function safeText(v: any) {
                        return typeof v === "string" ? v : "";
                      }

                      export default function Home() {
                        const [recipientEmail, setRecipientEmail] = useState("");
                        const [message, setMessage] = useState("");
                        const [amountDollars, setAmountDollars] = useState<number>(10);

                        const [submitting, setSubmitting] = useState(false);
                        const [err, setErr] = useState<string>("");
                        const [result, setResult] = useState<{
                          giftId: string;
                          claimLink: string;
                          recipient: string;
                          emailStatus: "sent" | "queued";
                        } | null>(null);
                        const [copied, setCopied] = useState(false);

                        const amountCents = useMemo(() => moneyToCents(amountDollars), [amountDollars]);

                        const canSubmit = useMemo(() => {
                          if (!isEmail(recipientEmail)) return false;
                          if (!message.trim()) return false;
                          if (!Number.isFinite(amountDollars)) return false;
                          if (amountCents < 1000) return false; // $10 min
                          return true;
                        }, [recipientEmail, message, amountDollars, amountCents]);

                        async function onSubmit(e: React.FormEvent) {
                          e.preventDefault();
                          setErr("");
                          setResult(null);
                          setCopied(false);

                          const email = recipientEmail.trim();
                          const msg = message.trim();

                          if (!isEmail(email)) return setErr("Please enter a valid email.");
                          if (!msg) return setErr("Please write a message.");
                          if (amountCents < 1000) return setErr("Minimum amount is $10.");

                          setSubmitting(true);
                          try {
                            const r = await fetch("/api/gifts", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                recipientEmail: email,
                                message: msg,
                                amount: amountCents,
                              }),
                            });

                            const data = (await r.json().catch(() => ({}))) as CreateGiftResponse;

                            if (!r.ok) {
                              const zodIssue =
                                Array.isArray((data as any)?.issues) && (data as any).issues?.[0]?.message;
                              setErr((data as any)?.error || zodIssue || "Something went wrong.");
                              return;
                            }

                            if ((data as any)?.success) {
                              const claimLink = absoluteLink(safeText((data as any).claimLink));
                              const emailOk = (data as any)?.email?.ok;
                              setResult({
                                giftId: safeText((data as any).giftId),
                                claimLink,
                                recipient: email,
                                emailStatus: emailOk === false ? "queued" : "sent",
                              });
                              return;
                            }

                            setErr("Unexpected response.");
                          } catch (e: any) {
                            setErr(String(e?.message || e || "Network error"));
                          } finally {
                            setSubmitting(false);
                          }
                        }

                        async function copyLink() {
                          if (!result?.claimLink) return;
                          try {
                            await navigator.clipboard.writeText(result.claimLink);
                            setCopied(true);
                            setTimeout(() => setCopied(false), 1200);
                          } catch {}
                        }

                        function resetForm() {
                          setErr("");
                          setResult(null);
                          setCopied(false);
                          setRecipientEmail("");
                          setMessage("");
                          setAmountDollars(10);
                        }

                        const presets = [
                          { label: "$10", value: 10 },
                          { label: "$25", value: 25 },
                          { label: "$50", value: 50 },
                          { label: "$100", value: 100 },
                        ];

                        return (
                          <div className="min-h-screen bg-gradient-to-b from-white via-white to-violet-50 text-slate-900">
                            <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
                              <div className="flex items-center gap-3">
                                <div className="h-9 w-9 rounded-2xl bg-violet-600 shadow-sm" />
                                <div className="leading-tight">
                                  <div className="text-sm font-semibold tracking-tight">ThanküMail</div>
                                  <div className="text-xs text-slate-500">A message first.</div>
                                </div>
                              </div>

                              <a
                                href="/api/health"
                                className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200 hover:ring-violet-200"
                              >
                                Status
                              </a>
                            </header>

                            <main className="mx-auto grid max-w-6xl grid-cols-1 gap-10 px-6 pb-20 pt-6 lg:grid-cols-2 lg:items-start">
                              {/* LEFT / HERO */}
                              <section className="pt-2">
                                <div className="inline-flex items-center gap-2 rounded-full border border-violet-100 bg-white px-3 py-1 text-xs text-slate-600 shadow-sm">
                                  <span className="h-2 w-2 rounded-full bg-violet-600" />
                                  Minimal • Warm • Private
                                </div>

                                <h1 className="mt-5 text-4xl font-extrabold tracking-tight sm:text-5xl">
                                  A small gift.
                                  <span className="block text-violet-700">A message they’ll remember.</span>
                                </h1>

                                <p className="mt-4 max-w-xl text-base leading-relaxed text-slate-600">
                                  Your words land first — before anything else. No accounts. No noise. Just
                                  something real.
                                </p>

                                <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-3">
                                  <div className="rounded-2xl border border-violet-100 bg-white p-4 shadow-sm">
                                    <div className="text-sm font-semibold">Fast</div>
                                    <div className="mt-1 text-xs text-slate-600">Create in under a minute.</div>
                                  </div>
                                  <div className="rounded-2xl border border-violet-100 bg-white p-4 shadow-sm">
                                    <div className="text-sm font-semibold">Warm</div>
                                    <div className="mt-1 text-xs text-slate-600">Your message is the moment.</div>
                                  </div>
                                  <div className="rounded-2xl border border-violet-100 bg-white p-4 shadow-sm">
                                    <div className="text-sm font-semibold">Simple</div>
                                    <div className="mt-1 text-xs text-slate-600">No login. No friction.</div>
                                  </div>
                                </div>

                                <div className="mt-8 rounded-2xl border border-violet-100 bg-white p-5 text-sm text-slate-600 shadow-sm">
                                  <div className="font-semibold text-slate-800">Tip</div>
                                  <div className="mt-1">
                                    Try: <span className="text-slate-800">“I see you. Thank you for being you.”</span>
                                  </div>
                                </div>
                              </section>

                              {/* RIGHT / FORM OR CONFIRM */}
                              <section className="lg:pt-2">
                                <div className="rounded-3xl border border-violet-100 bg-white p-6 shadow-sm">
                                  {!result ? (
                                    <>
                                      <h2 className="text-xl font-bold tracking-tight">Create a ThanküMail</h2>
                                      <p className="mt-1 text-sm text-slate-600">
                                        Minimum is $10. Your message comes first.
                                      </p>

                                      <form onSubmit={onSubmit} className="mt-6 space-y-4">
                                        <div>
                                          <label className="text-sm font-semibold text-slate-800">Recipient email</label>
                                          <input
                                            value={recipientEmail}
                                            onChange={(e) => setRecipientEmail(e.target.value)}
                                            placeholder="friend@example.com"
                                            className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none ring-violet-200 focus:ring-4"
                                            autoComplete="email"
                                          />
                                        </div>

                                        <div>
                                          <label className="text-sm font-semibold text-slate-800">Your message</label>
                                          <textarea
                                            value={message}
                                            onChange={(e) => setMessage(e.target.value)}
                                            placeholder="Write something real…"
                                            className="mt-2 h-28 w-full resize-none rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none ring-violet-200 focus:ring-4"
                                            maxLength={1000}
                                          />
                                          <div className="mt-1 text-xs text-slate-500">{message.trim().length}/1000</div>
                                        </div>

                                        <div>
                                          <label className="text-sm font-semibold text-slate-800">Amount</label>

                                          <div className="mt-2 flex flex-wrap gap-2">
                                            {presets.map((p) => {
                                              const active = amountDollars === p.value;
                                              return (
                                                <button
                                                  key={p.value}
                                                  type="button"
                                                  onClick={() => setAmountDollars(p.value)}
                                                  className={[
                                                    "rounded-2xl px-4 py-2 text-sm font-semibold transition",
                                                    active
                                                      ? "bg-violet-600 text-white"
                                                      : "border border-slate-200 bg-white text-slate-700 hover:border-violet-200",
                                                  ].join(" ")}
                                                >
                                                  {p.label}
                                                </button>
                                              );
                                            })}
                                          </div>

                                          <div className="mt-3 flex items-center gap-3">
                                            <div className="w-32">
                                              <input
                                                type="number"
                                                min={10}
                                                step={1}
                                                value={Number.isFinite(amountDollars) ? amountDollars : 10}
                                                onChange={(e) => setAmountDollars(Number(e.target.value))}
                                                className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none ring-violet-200 focus:ring-4"
                                              />
                                            </div>
                                            <div className="text-sm text-slate-600">
                                              You’ll send{" "}
                                              <span className="font-semibold text-slate-900">
                                                ${centsToMoney(amountCents)}
                                              </span>
                                            </div>
                                          </div>
                                        </div>

                                        {err ? (
                                          <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                                            {err}
                                          </div>
                                        ) : null}

                                        <button
                                          type="submit"
                                          disabled={!canSubmit || submitting}
                                          className={[
                                            "w-full rounded-2xl px-4 py-3 text-sm font-semibold shadow-sm transition",
                                            !canSubmit || submitting
                                              ? "bg-slate-200 text-slate-500"
                                              : "bg-violet-600 text-white hover:bg-violet-700",
                                          ].join(" ")}
                                        >
                                          {submitting ? "Creating…" : "Create gift"}
                                        </button>

                                        <div className="text-center text-xs text-slate-500">
                                          By sending, you agree to keep it kind. ❤️
                                        </div>
                                      </form>
                                    </>
                                  ) : (
                                    <>
                                      <div className="inline-flex items-center gap-2 rounded-full border border-violet-100 bg-violet-50 px-3 py-1 text-xs text-slate-700">
                                        <span className="h-2 w-2 rounded-full bg-violet-600" />
                                        Sent with care
                                      </div>

                                      <h2 className="mt-4 text-2xl font-extrabold tracking-tight">
                                        Your message is on its way.
                                        <span className="block text-violet-700">That’s the part that matters.</span>
                                      </h2>

                                      <p className="mt-3 text-sm leading-relaxed text-slate-600">
                                        We {result.emailStatus === "sent" ? "sent" : "queued"} the email to{" "}
                                        <span className="font-semibold text-slate-900">{result.recipient}</span>.
                                        If you want, you can also share the private link yourself.
                                      </p>

                                      <div className="mt-5 rounded-2xl border border-violet-200 bg-violet-50 px-4 py-4">
                                        <div className="text-sm font-semibold text-slate-900">Private link</div>

                                        <div className="mt-3 flex items-center gap-2">
                                          <input
                                            readOnly
                                            value={result.claimLink}
                                            className="w-full rounded-2xl border border-violet-200 bg-white px-3 py-2 text-xs text-slate-800"
                                          />
                                          <button
                                            type="button"
                                            onClick={copyLink}
                                            className="rounded-2xl bg-violet-600 px-4 py-2 text-xs font-semibold text-white hover:bg-violet-700"
                                          >
                                            {copied ? "Copied" : "Copy"}
                                          </button>
                                        </div>

                                        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                          <a
                                            href={result.claimLink}
                                            className="rounded-2xl bg-violet-600 px-5 py-3 text-center text-sm font-semibold text-white hover:bg-violet-700"
                                          >
                                            Open claim page →
                                          </a>

                                          <button
                                            type="button"
                                            onClick={resetForm}
                                            className="rounded-2xl bg-white px-5 py-3 text-sm font-semibold text-slate-700 ring-1 ring-slate-200 hover:ring-violet-200"
                                          >
                                            Send another
                                          </button>
                                        </div>

                                        <div className="mt-4 text-xs text-slate-500">
                                          You don’t need to add anything. Your words did the work.
                                        </div>
                                      </div>
                                    </>
                                  )}
                                </div>

                                <div className="mt-6 rounded-3xl border border-violet-100 bg-white p-5 text-sm text-slate-600 shadow-sm">
                                  <div className="font-semibold text-slate-800">What happens next?</div>
                                  <ol className="mt-2 list-decimal space-y-1 pl-5">
                                    <li>They open the link and see your message first.</li>
                                    <li>They claim when they’re ready.</li>
                                    <li>That’s it. Simple.</li>
                                  </ol>
                                </div>
                              </section>
                            </main>

                            <footer className="border-t border-violet-100 bg-white">
                              <div className="mx-auto flex max-w-6xl flex-col gap-2 px-6 py-10 text-sm text-slate-600 sm:flex-row sm:items-center sm:justify-between">
                                <div>© {new Date().getFullYear()} ThanküMail</div>
                                <div className="flex gap-4">
                                  <a className="hover:text-slate-900" href="/health">
                                    Status
                                  </a>
                                  <a className="hover:text-slate-900" href="/api/health">
                                    API
                                  </a>
                                </div>
                              </div>
                            </footer>
                          </div>
                        );
                      }
