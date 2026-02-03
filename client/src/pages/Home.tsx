import React from "react";
import CreateGiftForm from "../components/CreateGiftForm";

export default function Home() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="mx-auto max-w-5xl px-4 pt-10 pb-6">
        <div className="rounded-2xl bg-card shadow-soft border border-border px-6 py-10">
          <div className="max-w-2xl">
            <p className="inline-flex items-center gap-2 rounded-full bg-muted px-3 py-1 text-sm text-muted-foreground border border-border">
              A quiet way to send gratitude
            </p>

            <h1 className="mt-5 text-4xl sm:text-5xl font-semibold tracking-tight text-tm-charcoal">
              Send more than money.
            </h1>

            <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
              Send gratitude. Send closure. Send kindness. <br className="hidden sm:block" />
              A personal message, paired with a meaningful gift.
            </p>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <a
                href="#send"
                className="inline-flex items-center justify-center rounded-xl bg-primary px-5 py-3 text-primary-foreground font-medium shadow-soft border border-border hover:opacity-95 active:opacity-90"
              >
                Send a ThankuMail
              </a>

              <p className="text-sm text-muted-foreground">
                Private. Simple. Built for the moment.
              </p>
            </div>
          </div>
        </div>
      </header>

      <main id="send" className="mx-auto max-w-5xl px-4 pb-16">
        <div className="rounded-2xl bg-card shadow-soft border border-border p-6">
          <div className="mb-5">
            <h2 className="text-2xl font-semibold text-tm-charcoal">Create your ThankuMail</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Who should receive this? What do you want them to feel when they open it?
            </p>
          </div>

          <CreateGiftForm />
        </div>

        <footer className="mt-10 text-center text-sm text-muted-foreground">
          ThankuMail is designed to be calm, honest, and human.
        </footer>
      </main>
    </div>
  );
}
