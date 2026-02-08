import React from "react";
import CreateGiftForm from "../components/CreateGiftForm";

export default function Home() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-[#3a1c71] via-[#5f2eea] to-[#a855f7] text-white">
      <main id="send" className="mx-auto max-w-5xl px-4 pt-10 pb-20">
        {/* Logo */}
        <div className="flex justify-center mb-6">
          <div className="rounded-3xl bg-white/90 backdrop-blur px-6 py-4 shadow-soft border border-white/30">
            <img
              src="/thankumail-logo.png"
              alt="thankÜmail"
              className="w-[420px] sm:w-[520px] md:w-[620px] h-auto"
            />
          </div>
        </div>

        {/* Subline */}
        <div className="text-center mb-8">
          <p className="text-sm sm:text-base text-white/85">
            Anonymous appreciation. Quiet generosity. Human moments.
          </p>
        </div>

        {/* Card */}
        <div className="rounded-2xl bg-white/95 backdrop-blur shadow-soft border border-white/20 p-6 text-tm-charcoal">
          <CreateGiftForm />
        </div>

        <footer className="mt-10 text-center text-sm text-white/70">
          thankÜmail is designed to be calm, honest, and human.
        </footer>
      </main>
    </div>
  );
}
