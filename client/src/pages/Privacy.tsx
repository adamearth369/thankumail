// WHERE TO PASTE: client/src/pages/Privacy.tsx
// ACTION: New file

import React from "react";

const FONT_BODY =
  "'DM Sans', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const FONT_TITLE =
  "'Outfit', 'DM Sans', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const FONT_WORDMARK =
  "'Quicksand', 'DM Sans', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export default function Privacy() {
  const shellStyle: React.CSSProperties = {
    fontFamily: FONT_BODY,
    WebkitFontSmoothing: "antialiased",
    MozOsxFontSmoothing: "grayscale",
  };

  return (
    <div
      className="min-h-screen bg-cover bg-center bg-no-repeat text-white"
      style={{ backgroundImage: "url('/images/hero-background.png')" }}
    >
      <div className="min-h-screen bg-black/35" style={shellStyle}>
        <main className="mx-auto max-w-3xl px-4 pt-24 pb-16">
          <div className="rounded-2xl bg-white/95 backdrop-blur shadow-soft border border-white/20 p-8 text-slate-900">

            <div
              className="text-sm text-slate-500 mb-2"
              style={{ fontFamily: FONT_WORDMARK, fontWeight: 600 }}
            >
              thankümail
            </div>

            <h1
              className="text-3xl md:text-4xl tracking-tight mb-6"
              style={{ fontFamily: FONT_TITLE, fontWeight: 800 }}
            >
              Privacy Policy
            </h1>

            <div className="space-y-6 text-[15px] leading-relaxed text-slate-700">

              <p>
                thankümail is designed to allow people to send appreciation
                messages and optional gifts. Protecting user privacy is
                important to us.
              </p>

              <h2 className="text-lg font-semibold text-slate-900">
                Information We Collect
              </h2>
              <p>
                We may collect limited information required to operate the
                service, including email addresses, message content, delivery
                information, technical logs, and payment session data from
                third-party payment providers.
              </p>

              <h2 className="text-lg font-semibold text-slate-900">
                Payment Processing
              </h2>
              <p>
                Payments are processed through third-party providers such as
                Stripe. thankümail does not store credit card numbers or
                sensitive payment details.
              </p>

              <h2 className="text-lg font-semibold text-slate-900">
                How Information Is Used
              </h2>
              <p>
                Information is used only to deliver thankümails, process
                payments, maintain system security, prevent abuse, and operate
                the platform.
              </p>

              <h2 className="text-lg font-semibold text-slate-900">
                Abuse and Misuse of the Service
              </h2>
              <p>
                thankümail is intended for respectful appreciation messages.
                Abuse of the platform including harassment, fraud, illegal
                activity, or violations of the Terms of Service may result in
                investigation and account restrictions.
              </p>

              <p>
                If the service is abused or used to violate applicable laws,
                thankümail reserves the right to disclose relevant user
                information to appropriate authorities or parties as required
                to investigate misuse, enforce our Terms of Service, or comply
                with legal obligations.
              </p>

              <h2 className="text-lg font-semibold text-slate-900">
                Data Security
              </h2>
              <p>
                Reasonable security measures are used to protect the platform
                and user information. However, no internet service can be
                guaranteed completely secure.
              </p>

              <h2 className="text-lg font-semibold text-slate-900">
                Policy Updates
              </h2>
              <p>
                This policy may be updated periodically to reflect operational
                or legal changes. Continued use of the service constitutes
                acceptance of any updates.
              </p>

            </div>

            <div className="mt-8 text-xs text-slate-500">
              Last updated: {new Date().getFullYear()}
            </div>

          </div>
        </main>
      </div>
    </div>
  );
}