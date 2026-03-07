import React from "react";
import { Link } from "wouter";

function classNames(...xs: Array<string | false | undefined | null>) {
  return xs.filter(Boolean).join(" ");
}

function resolveApiBase(): string {
  try {
    const v = (import.meta as any)?.env?.VITE_API_BASE_URL;
    const envBase = typeof v === "string" ? v.trim() : "";
    if (envBase) return envBase.replace(/\/+$/, "");
  } catch {}
  return "https://api.thankumail.com";
}

function buildGoogleAuthUrl(): string {
  const base = resolveApiBase();
  return `${base}/api/auth/google`;
}

function buildFacebookAuthUrl(): string {
  const base = resolveApiBase();
  return `${base}/api/auth/facebook`;
}

function buildLinkedinAuthUrl(): string {
  const base = resolveApiBase();
  return `${base}/api/auth/linkedin`;
}

function buildMicrosoftAuthUrl(): string {
  const base = resolveApiBase();
  return `${base}/api/auth/microsoft`;
}

function GoogleIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 shrink-0">
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.2-2.27H12v4.31h6.45a5.52 5.52 0 0 1-2.39 3.62v3h3.87c2.27-2.09 3.57-5.17 3.57-8.66Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.95-2.91l-3.87-3c-1.07.72-2.45 1.15-4.08 1.15-3.14 0-5.8-2.12-6.75-4.97H1.25v3.09A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.25 14.27A7.2 7.2 0 0 1 4.87 12c0-.79.14-1.56.38-2.27V6.64H1.25A12 12 0 0 0 0 12c0 1.93.46 3.76 1.25 5.36l4-3.09Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.77c1.76 0 3.33.61 4.57 1.79l3.43-3.43C17.95 1.24 15.24 0 12 0A12 12 0 0 0 1.25 6.64l4 3.09c.95-2.85 3.61-4.96 6.75-4.96Z"
      />
    </svg>
  );
}

function FacebookIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 shrink-0">
      <path
        fill="currentColor"
        d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07c0 6.03 4.39 11.03 10.13 11.93v-8.44H7.08v-3.49h3.05V9.41c0-3.03 1.79-4.7 4.54-4.7 1.31 0 2.69.24 2.69.24v2.97h-1.52c-1.5 0-1.96.94-1.96 1.9v2.25h3.33l-.53 3.49h-2.8V24C19.61 23.1 24 18.1 24 12.07Z"
      />
    </svg>
  );
}

function LinkedinIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 shrink-0">
      <path
        fill="currentColor"
        d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.05-1.86-3.05-1.87 0-2.15 1.46-2.15 2.95v5.67H9.32V9h3.42v1.56h.05c.48-.9 1.64-1.85 3.38-1.85 3.61 0 4.28 2.38 4.28 5.48v6.26ZM5.3 7.43a2.07 2.07 0 1 1 0-4.14 2.07 2.07 0 0 1 0 4.14ZM7.08 20.45H3.52V9h3.56v11.45ZM22.23 0H1.77A1.76 1.76 0 0 0 0 1.74v20.52C0 23.22.8 24 1.77 24h20.46A1.77 1.77 0 0 0 24 22.26V1.74A1.77 1.77 0 0 0 22.23 0Z"
      />
    </svg>
  );
}

function MicrosoftIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 shrink-0">
      <path fill="#F25022" d="M1 1h10.5v10.5H1z" />
      <path fill="#7FBA00" d="M12.5 1H23v10.5H12.5z" />
      <path fill="#00A4EF" d="M1 12.5h10.5V23H1z" />
      <path fill="#FFB900" d="M12.5 12.5H23V23H12.5z" />
    </svg>
  );
}

type ProviderButtonProps = {
  href: string;
  label: string;
  icon: React.ReactNode;
  className: string;
  iconWrapClassName: string;
};

function ProviderButton({ href, label, icon, className, iconWrapClassName }: ProviderButtonProps) {
  return (
    <a
      href={href}
      className={classNames(
        "group w-full inline-flex items-center justify-center gap-3 rounded-2xl px-5 py-4 transition font-outfit text-lg tracking-tight border-2 shadow-soft hover:shadow-xl hover:-translate-y-[1px] active:translate-y-0 active:opacity-95",
        className,
      )}
    >
      <span
        className={classNames(
          "inline-flex h-9 w-9 items-center justify-center rounded-full border transition",
          iconWrapClassName,
        )}
      >
        {icon}
      </span>
      <span>{label}</span>
    </a>
  );
}

export default function Login() {
  const googleAuthUrl = buildGoogleAuthUrl();
  const facebookAuthUrl = buildFacebookAuthUrl();
  const linkedinAuthUrl = buildLinkedinAuthUrl();
  const microsoftAuthUrl = buildMicrosoftAuthUrl();

  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    const t = setTimeout(() => setMounted(true), 30);
    return () => clearTimeout(t);
  }, []);

  const box =
    "w-full max-w-xl rounded-2xl border border-white/20 bg-white/92 backdrop-blur-sm p-5 shadow-soft text-tm-charcoal";

  return (
    <div
      className="min-h-screen bg-cover bg-center bg-no-repeat text-tm-charcoal"
      style={{ backgroundImage: "url('/images/hero-background.png')" }}
    >
      <div className="min-h-screen bg-black/30 flex items-center justify-center px-4">
        <div
          className={[
            "transition-all duration-700 ease-out",
            mounted ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3",
          ].join(" ")}
        >
          <div className={box}>
            <div className="flex items-center justify-between gap-4">
              <div className="text-lg font-outfit font-semibold tracking-tight">Registered sign in</div>
              <Link href="/" className="text-sm underline text-tm-charcoal/70 hover:text-tm-charcoal">
                Back
              </Link>
            </div>

            <div className="mt-3 text-sm text-tm-charcoal/75">
              Registered accounts use <span className="font-medium text-tm-charcoal">Google</span>,{" "}
              <span className="font-medium text-tm-charcoal">LinkedIn</span>,{" "}
              <span className="font-medium text-tm-charcoal">Facebook</span>, or{" "}
              <span className="font-medium text-tm-charcoal">Microsoft</span>.
            </div>

            <div className="mt-4 grid gap-3">
              <ProviderButton
                href={googleAuthUrl}
                label="Continue with Google"
                icon={<GoogleIcon />}
                className="bg-white text-[#1F1F1F] border-[#E5E5E5] hover:bg-[#FAFAFA]"
                iconWrapClassName="bg-white border-[#E5E5E5]"
              />

              <ProviderButton
                href={microsoftAuthUrl}
                label="Continue with Microsoft"
                icon={<MicrosoftIcon />}
                className="bg-white text-[#1F1F1F] border-[#E5E5E5] hover:bg-[#FAFAFA]"
                iconWrapClassName="bg-white border-[#E5E5E5]"
              />

              <ProviderButton
                href={linkedinAuthUrl}
                label="Continue with LinkedIn"
                icon={<LinkedinIcon />}
                className="bg-white text-[#1F1F1F] border-[#E5E5E5] hover:bg-[#FAFAFA]"
                iconWrapClassName="bg-white border-[#E5E5E5]"
              />

              <ProviderButton
                href={facebookAuthUrl}
                label="Continue with Facebook"
                icon={<FacebookIcon />}
                className="bg-white text-[#1F1F1F] border-[#E5E5E5] hover:bg-[#FAFAFA]"
                iconWrapClassName="bg-white border-[#E5E5E5]"
              />
            </div>

            <div className="mt-3 text-xs text-tm-charcoal/60">
              This keeps the flow fast and helps protect the system from abuse.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}