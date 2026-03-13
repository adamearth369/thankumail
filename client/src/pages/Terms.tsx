// WHERE TO PASTE: client/src/pages/Terms.tsx
// ACTION: New file

import React from "react";

const FONT_BODY =
  "'DM Sans', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const FONT_TITLE =
  "'Outfit', 'DM Sans', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const FONT_WORDMARK =
  "'Quicksand', 'DM Sans', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export default function Terms() {
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
              Terms of Service
            </h1>

            <div className="space-y-6 text-[15px] leading-relaxed text-slate-700">

              <p>
                Welcome to thankümail. By using this website and service you agree
                to the following terms.
              </p>

              <h2 className="text-lg font-semibold text-slate-900">
                Service Description
              </h2>
              <p>
                thankümail allows users to send appreciation messages and optional
                gift amounts to recipients through a secure delivery link.
              </p>

              <h2 className="text-lg font-semibold text-slate-900">
                Acceptable Use
              </h2>
              <p>
                You agree not to use thankümail for harassment, fraud, spam,
                illegal activity, or any activity that harms recipients or the
                platform.
              </p>

              <h2 className="text-lg font-semibold text-slate-900">
                Payments
              </h2>
              <p>
                Some thankümails may include gift amounts processed by third-party
                payment providers. thankümail does not store payment card
                information.
              </p>

              <h2 className="text-lg font-semibold text-slate-900">
                No Stored Balance
              </h2>
              <p>
                thankümail does not operate as a wallet or stored value account.
                Funds are associated only with individual thankümails.
              </p>

              <h2 className="text-lg font-semibold text-slate-900">
                Service Availability
              </h2>
              <p>
                We may update, modify, or discontinue features at any time to
                maintain security, stability, and service quality.
              </p>

              <h2 className="text-lg font-semibold text-slate-900">
                Limitation of Liability
              </h2>
              <p>
                thankümail is provided on an "as available" basis without
                warranties of any kind. To the maximum extent permitted by law,
                thankümail is not liable for indirect or consequential damages.
              </p>

              <h2 className="text-lg font-semibold text-slate-900">
                Changes to These Terms
              </h2>
              <p>
                These terms may be updated from time to time. Continued use of the
                service constitutes acceptance of any changes.
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