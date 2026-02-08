import React from "react";
import CreateGiftForm from "../components/CreateGiftForm";

export default function Home() {
  return (
    <div
      className="min-h-screen text-foreground"
      style={{
        background:
          "linear-gradient(135deg, #2b124c 0%, #3b1e6d 35%, #5a2c8a 70%, #7a3fb5 100%)",
      }}
    >
      <main id="send" className="mx-auto max-w-5xl px-4 pt-20 pb-16">
        <div className="rounded-2xl bg-white/90 backdrop-blur shadow-soft border border-white/20 p-6">
          <div className="mb-5">
            <h2 className="text-2xl font-semibold text-tm-charcoal">
              Create your thankÜmail
            </h2>
            <p className="mt-1 text-sm text-tm-charcoal/70">
              Who should receive this? What do you want them to feel when they open it?
            </p>
          </div>

          <CreateGiftForm />
        </div>

        <footer className="mt-10 text-center text-sm text-white/70">
          thankÜmail is designed to be calm, honest, and human.
        </footer>
      </main>
    </div>
  );
}
