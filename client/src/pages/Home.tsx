import React from "react";
import CreateGiftForm from "../components/CreateGiftForm";

export default function Home() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-[#3a1c71] via-[#5f2eea] to-[#a855f7] text-white">
      <main id="send" className="mx-auto max-w-5xl px-4 pt-16 pb-16">
        <div className="rounded-2xl bg-white/95 backdrop-blur shadow-soft border border-white/20 p-6 text-tm-charcoal">
          <div className="mb-5">
            <h2 className="text-2xl font-semibold">
              Create your thankÜmail
            </h2>
            <p className="mt-1 text-sm text-gray-600">
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
