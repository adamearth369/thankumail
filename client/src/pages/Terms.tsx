// WHERE TO PASTE: client/src/pages/Terms.tsx
// ACTION: Full file replacement

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
                Welcome to thankümail. By accessing or using this website and
                its services, you agree to comply with and be bound by the
                following Terms of Service.
              </p>

              <h2 className="text-lg font-semibold text-slate-900">
                Service Description
              </h2>

              <p>
                thankümail allows users to send appreciation messages and
                optional monetary gifts to recipients through secure delivery
                links. The service is designed to facilitate positive,
                respectful communication.
              </p>

              <h2 className="text-lg font-semibold text-slate-900">
                Acceptable Use
              </h2>

              <p>
                Users agree not to use thankümail for harassment, threats,
                fraud, impersonation, illegal activity, or any misuse of
                anonymous communication.
              </p>

              <p>
                The platform must not be used to send abusive, deceptive,
                malicious, or harmful messages to recipients.
              </p>

              <h2 className="text-lg font-semibold text-slate-900">
                Abuse of Service and Loss of Anonymity
              </h2>

              <p>
                thankümail provides anonymity as a feature intended for
                legitimate appreciation messages. Anonymity is not guaranteed
                in cases where the service is abused.
              </p>

              <p>
                By using thankümail, users acknowledge and agree that if the
                service is used to violate these Terms of Service, harass
                others, commit fraud, or engage in unlawful conduct,
                thankümail reserves the right to investigate such activity.
              </p>

              <p>
                In cases of abuse or misuse of the platform, thankümail may
                disclose relevant user information, technical logs, account
                data, IP addresses, or other identifying information to
                appropriate authorities or affected parties where necessary
                to enforce these Terms, protect users, investigate abuse,
                or comply with applicable law.
              </p>

              <p>
                By using the service, users acknowledge that misuse of the
                platform may result in the loss of anonymity.
              </p>

              <h2 className="text-lg font-semibold text-slate-900">
                Account and Access Restrictions
              </h2>

              <p>
                thankümail reserves the right to suspend or block access to
                the platform, including restricting accounts, IP addresses,
                or other identifiers, if a user violates these Terms or
                attempts to misuse the service.
              </p>

              <h2 className="text-lg font-semibold text-slate-900">
                Payments
              </h2>

              <p>
                Some thankümails may include monetary gifts. Payments are
                processed by third-party payment providers such as Stripe.
                thankümail does not store credit card numbers or sensitive
                payment information.
              </p>

              <h2 className="text-lg font-semibold text-slate-900">
                No Stored Balance
              </h2>

              <p>
                thankümail does not function as a wallet or stored value
                account. Funds are associated only with individual
                thankümails and are processed through third-party payment
                providers.
              </p>

              <h2 className="text-lg font-semibold text-slate-900">
                Service Availability
              </h2>

              <p>
                thankümail may modify, suspend, or discontinue any part of
                the service at any time in order to maintain security,
                reliability, or operational stability.
              </p>

              <h2 className="text-lg font-semibold text-slate-900">
                Limitation of Liability
              </h2>

              <p>
                The service is provided on an "as available" and
                "as-is" basis without warranties of any kind. To the
                maximum extent permitted by law, thankümail is not liable
                for indirect, incidental, or consequential damages
                arising from the use of the platform.
              </p>

              <h2 className="text-lg font-semibold text-slate-900">
                Changes to These Terms
              </h2>

              <p>
                These Terms of Service may be updated periodically.
                Continued use of the service after changes are posted
                constitutes acceptance of the updated terms.
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