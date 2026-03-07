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

export default function Login() {
  const googleAuthUrl = buildGoogleAuthUrl();
  const facebookAuthUrl = buildFacebookAuthUrl();
  const linkedinAuthUrl = buildLinkedinAuthUrl();

  const box = "rounded-2xl border border-tm-charcoal/20 bg-white p-5 shadow-soft text-tm-charcoal";

  return (
    <div className="w-full max-w-xl mx-auto">
      <div className={box}>
        <div className="flex items-center justify-between">
          <div className="text-lg font-outfit font-semibold tracking-tight">Registered sign in</div>
          <Link href="/" className="text-sm underline text-tm-charcoal/70 hover:text-tm-charcoal">
            Back
          </Link>
        </div>

        <div className="mt-3 text-sm text-tm-charcoal/75">
          Registered accounts use <span className="font-medium text-tm-charcoal">Google</span>,{" "}
          <span className="font-medium text-tm-charcoal">Facebook</span>, or{" "}
          <span className="font-medium text-tm-charcoal">LinkedIn</span>.
        </div>

        <div className="mt-4 grid gap-3">
          <a
            href={googleAuthUrl}
            className={classNames(
              "w-full inline-flex items-center justify-center rounded-2xl px-5 py-4 transition font-outfit text-lg tracking-tight border-2",
              "bg-tm-amber text-tm-charcoal border-tm-charcoal/30 cursor-pointer shadow-soft hover:shadow-xl hover:opacity-95 hover:-translate-y-[1px] active:translate-y-0 active:opacity-90",
            )}
          >
            Continue with Google
          </a>

          <a
            href={facebookAuthUrl}
            className={classNames(
              "w-full inline-flex items-center justify-center rounded-2xl px-5 py-4 transition font-outfit text-lg tracking-tight border-2",
              "bg-white text-tm-charcoal border-tm-charcoal/30 cursor-pointer shadow-soft hover:shadow-xl hover:bg-tm-cream hover:-translate-y-[1px] active:translate-y-0 active:opacity-90",
            )}
          >
            Continue with Facebook
          </a>

          <a
            href={linkedinAuthUrl}
            className={classNames(
              "w-full inline-flex items-center justify-center rounded-2xl px-5 py-4 transition font-outfit text-lg tracking-tight border-2",
              "bg-white text-tm-charcoal border-tm-charcoal/30 cursor-pointer shadow-soft hover:shadow-xl hover:bg-tm-cream hover:-translate-y-[1px] active:translate-y-0 active:opacity-90",
            )}
          >
            Continue with LinkedIn
          </a>
        </div>

        <div className="mt-3 text-xs text-tm-charcoal/60">
          This keeps the flow fast and helps protect the system from abuse.
        </div>
      </div>
    </div>
  );
}