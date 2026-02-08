// WHERE TO PASTE: client/src/pages/Home.tsx
// ACTION: Full file replacement (paste exactly)

import React from "react";
import CreateGiftForm from "../components/CreateGiftForm";

export default function Home() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <main id="send" className="mx-auto max-w-5xl px-4 pt-16 pb-16">
        <div className="rounded-2xl bg-card shadow-soft border border-border p-6">
          <div className="mb-5">
            <h2 className="text-2xl font-semibold text-tm-charcoal">
              Create your ThankuMail
            </h2>
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
