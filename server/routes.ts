import express from "express";
import type { Express, Request } from "express";
import { createServer, type Server } from "http";
import crypto from "crypto";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { z } from "zod";
import { and, asc, desc, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import dns from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";

import { db } from "./db";
import {
  gifts,
  users,
  authMagicLinks,
  authSessions,
  stripeWebhookEvents,
  authEmailThrottle,
  supporters,
} from "@shared/schema";
import {
  sendGiftEmail,
  sendReminderEmail,
  sendReturnToSenderEmail,
  sendAuthMagicLinkEmail,
} from "./email";
import { sendGiftSms } from "./sms";

/* -------------------- VERSION -------------------- */
const VERSION = "routes_v2026-04-16_027_supporters";
const COMMIT = process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || "";

/* -------------------- ROUTES MARKER -------------------- */
const ROUTES_MARKER = "locked_scope_guest_preset_email_only_no_amount_no_sms_registered_google_only_preset_or_custom_280_optional_sms_fixed_amounts_25_50_100_250_500_1000_google_oauth_redirect_v3_add_api_auth_google_alias_plus_stripe_checkout_webhook_persist_v3_alias_routes_fix_paywall_delivery_v1_stripe_webhook_rawbody_fix_v1_stripe_webhook_route_no_route_raw_v1_admin_gifts_list_v1_delivery_tracking_v1_exact_once_paid_delivery_v1_admin_stripe_reconcile_v1_admin_stripe_session_fetch_v1_admin_reconcile_idempotent_v1_claim_safe_gift_get_v1_reminder_persist_atomic_v2_reminder_persist_verify_v1_auth_logout_revoke_v1_reminder_persist_patch_v1_admin_gift_get_v1_admin_reminder_target_v1_reminder_gap_env_parse_debug_v1_facebook_oauth_v1_auth_me_provider_fields_v1_oauth_provider_persist_v2_auth_provider_column_persist_v1_linkedin_oidc_v1_microsoft_oidc_v1_microsoft_graph_me_email_fallback_v1_oauth_skip_mx_v1_microsoft_oauth_hardening_v1_microsoft_existing_user_reuse_v1_dashboard_me_gifts_v1_dashboard_stats_v1_dashboard_gift_detail_v1_me_remind_v1_auth_cookie_only_remove_bearer_v1_auth_no_token_return_v1_stripe_webhook_amount_match_v1_enumeration_publicid_validation_v1_claim_requires_paid_v1_claim_turnstile_enforced_v1_claim_rate_limit_v1_claim_rate_limit_ip_key_v1_auth_remove_google_fragment_token_v1_auth_remove_facebook_fragment_token_v1_auth_cookie_only_cleanup_v1_gift_get_publicid_validation_v2_claim_timing_floor_v1_claim_paid_check_restore_v1_claim_timing_equalization_v1_microsoft_tenant_restriction_enforce_v1_oauth_error_sanitize_v1_google_oauth_error_sanitize_v1_facebook_oauth_error_sanitize_v1_linkedin_oauth_error_sanitize_v1_oauth_error_sweep_fix_v1_auth_request_error_normalize_v1_auth_me_error_normalize_v1_auth_logout_error_normalize_v1_auth_me_gifts_error_normalize_v1_admin_token_header_canonical_v1_claim_rate_limit_ipv6_safe_v1_oauth_error_status_normalize_v1_stripe_checkout_auth_error_normalize_v1_stripe_webhook_event_replay_protection_v1_v1_oauth_single_email_single_user_auth_abuse_logging_v1_auth_request_uniform_timing_response_v1_auth_email_canonical_pipeline_v1_auth_email_canonical_delivery_v1_auth_email_canonical_boundary_v1_auth_email_hash_store_v1_auth_email_hash_no_recompute_v1_auth_sender_single_canonical_v1_auth_email_no_raw_lookup_v1";

/* -------------------- URLS -------------------- */
const FRONTEND_URL = String(process.env.FRONTEND_URL || "https://thankumail.com").replace(/\/+$/, "");
const API_URL = String(process.env.API_URL || "https://api.thankumail.com").replace(/\/+$/, "");

/* -------------------- STRIPE -------------------- */
const STRIPE_SECRET_KEY = String(process.env.STRIPE_SECRET_KEY || "").trim();
const STRIPE_PUBLISHABLE_KEY = String(process.env.STRIPE_PUBLISHABLE_KEY || "").trim();
const STRIPE_WEBHOOK_SECRET = String(process.env.STRIPE_WEBHOOK_SECRET || "").trim();
const STRIPE_CURRENCY = String(process.env.STRIPE_CURRENCY || "usd").trim().toLowerCase();

/* -------------------- SCOPE CONSTANTS -------------------- */
const PRESET_MIN_ID = 1;
const PRESET_MAX_ID = 7;

/* -------------------- AMOUNTS -------------------- */
const ALLOWED_AMOUNTS_DOLLARS = [25, 50, 100, 250, 500, 1000] as const;
const ALLOWED_AMOUNTS_CENTS = new Set(ALLOWED_AMOUNTS_DOLLARS.map((d) => d * 100));
const MIN_AMOUNT_CENTS_REGISTERED = 25 * 100;

/* -------------------- TURNSTILE -------------------- */
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_SECRET_KEY = (process.env.TURNSTILE_SECRET_KEY || "").trim();
const TURNSTILE_BYPASS = String(process.env.TURNSTILE_BYPASS || "false").toLowerCase() === "true";

/* -------------------- AUTH HARDENING -------------------- */
const AUTH_MAGIC_LINK_TTL_MS = 10 * 60 * 1000;
const AUTH_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AUTH_RETURN_TOKEN = false;
const AUTH_MX_VALIDATE_ENABLED =
  String(process.env.AUTH_MX_VALIDATE_ENABLED ?? "false").toLowerCase() === "true";
const AUTH_MAGIC_LINK_ENABLED =
  String(process.env.AUTH_MAGIC_LINK_ENABLED ?? "false").toLowerCase() === "true";
const AUTH_REQUEST_MIN_RESPONSE_MS = Math.max(
  0,
  Number(process.env.AUTH_REQUEST_MIN_RESPONSE_MS ?? 900),
);

/* -------------------- GOOGLE OAUTH -------------------- */
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || "").trim();
const GOOGLE_CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || "").trim();
const GOOGLE_REDIRECT_URI = `${API_URL}/api/auth/google/callback`;

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

/* -------------------- FACEBOOK OAUTH -------------------- */
const FACEBOOK_APP_ID = (process.env.FACEBOOK_APP_ID || "").trim();
const FACEBOOK_APP_SECRET = (process.env.FACEBOOK_APP_SECRET || "").trim();
const FACEBOOK_REDIRECT_URI = `${API_URL}/api/auth/facebook/callback`;

const FACEBOOK_AUTH_URL = "https://www.facebook.com/v19.0/dialog/oauth";
const FACEBOOK_TOKEN_URL = "https://graph.facebook.com/v19.0/oauth/access_token";
const FACEBOOK_ME_URL = "https://graph.facebook.com/me";

/* -------------------- LINKEDIN OIDC -------------------- */
const LINKEDIN_CLIENT_ID = (process.env.LINKEDIN_CLIENT_ID || "").trim();
const LINKEDIN_CLIENT_SECRET = (process.env.LINKEDIN_CLIENT_SECRET || "").trim();
const LINKEDIN_REDIRECT_URI = `${API_URL}/api/auth/linkedin/callback`;

const LINKEDIN_AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization";
const LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const LINKEDIN_USERINFO_URL = "https://api.linkedin.com/v2/userinfo";

/* -------------------- MICROSOFT OIDC -------------------- */
const MICROSOFT_CLIENT_ID = (process.env.MICROSOFT_CLIENT_ID || "").trim();
const MICROSOFT_CLIENT_SECRET = (process.env.MICROSOFT_CLIENT_SECRET || "").trim();
const MICROSOFT_TENANT_ID = (process.env.MICROSOFT_TENANT_ID || "common").trim() || "common";
const MICROSOFT_REDIRECT_URI = `${API_URL}/api/auth/microsoft/callback`;

const MICROSOFT_AUTH_URL = `https://login.microsoftonline.com/${encodeURIComponent(
  MICROSOFT_TENANT_ID,
)}/oauth2/v2.0/authorize`;
const MICROSOFT_TOKEN_URL = `https://login.microsoftonline.com/${encodeURIComponent(
  MICROSOFT_TENANT_ID,
)}/oauth2/v2.0/token`;
const MICROSOFT_USERINFO_URL = "https://graph.microsoft.com/oidc/userinfo";
const MICROSOFT_GRAPH_ME_URL = "https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName";
const MICROSOFT_EXPECTED_ISSUER_PREFIX = "https://login.microsoftonline.com/";
const MICROSOFT_ALLOWED_TENANT_IDS = new Set(
  String(process.env.MICROSOFT_ALLOWED_TENANT_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

/* -------------------- OAUTH STATE STORE -------------------- */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
type OauthStateRecord = {
  exp: number;
  ip: string;
  ua: string;
  provider: "google" | "facebook" | "linkedin" | "microsoft";
  codeVerifier?: string;
  nonce?: string;
};
const oauthStateStore = new Map<string, OauthStateRecord>();
function pruneOauthState() {
  const nowMs = Date.now();
  for (const [k, v] of oauthStateStore.entries()) {
    if (!v || v.exp <= nowMs) oauthStateStore.delete(k);
  }
}

/* -------------------- ENV HELPERS -------------------- */
function readNumberEnv(name: string, def: number) {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return { raw: null as string | null, num: def };
  const trimmed = String(raw).trim();
  if (!trimmed) return { raw: "", num: def };
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return { raw: trimmed, num: def };
  return { raw: trimmed, num: n };
}

/**
 * Disposable emails:
 * - Primary source: server/disposableDomains.txt (one domain per line)
 * - Optional overrides: DISPOSABLE_EMAIL_DOMAINS env (comma-separated exact domains)
 */
function loadDisposableDomainsFromFile(): { set: Set<string>; loadedFrom: string | null } {
  const cwd = process.cwd();

  const candidates = [
    path.resolve(cwd, "server", "disposableDomains.txt"),
    path.resolve(cwd, "disposableDomains.txt"),
    path.resolve(cwd, "dist", "server", "disposableDomains.txt"),
    path.resolve(cwd, "dist", "disposableDomains.txt"),
    path.resolve(__dirname, "server", "disposableDomains.txt"),
    path.resolve(__dirname, "disposableDomains.txt"),
    path.resolve(__dirname, "..", "server", "disposableDomains.txt"),
    path.resolve(__dirname, "..", "disposableDomains.txt"),
  ];

  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, "utf8");
      const lines = raw
        .split(/\r?\n/g)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
        .filter((s) => !s.startsWith("#"))
        .filter((s) => !s.startsWith("//"));
      return { set: new Set(lines), loadedFrom: p };
    } catch {
      // ignore
    }
  }
  return { set: new Set(), loadedFrom: null };
}

const DISPOSABLE_FILE = loadDisposableDomainsFromFile();
const DISPOSABLE_EMAIL_DOMAINS_FILE = DISPOSABLE_FILE.set;
const DISPOSABLE_EMAIL_DOMAINS_FILE_PATH = DISPOSABLE_FILE.loadedFrom;

const DISPOSABLE_EMAIL_DOMAINS_ENV = new Set(
  String(process.env.DISPOSABLE_EMAIL_DOMAINS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

const DISPOSABLE_EMAIL_DOMAINS = new Set<string>([
  ...Array.from(DISPOSABLE_EMAIL_DOMAINS_FILE),
  ...Array.from(DISPOSABLE_EMAIL_DOMAINS_ENV),
]);

/* -------------------- LIMITS -------------------- */
const DAILY_LIMIT_IP = Math.max(0, Number(process.env.DAILY_LIMIT_IP ?? 10));
const DAILY_LIMIT_SENDER = Math.max(0, Number(process.env.DAILY_LIMIT_SENDER ?? 0));
const DAILY_LIMIT_PHONE = Math.max(0, Number(process.env.DAILY_LIMIT_PHONE ?? 3));

const MIN_CLAIM_DELAY_SEC = Math.max(0, Number(process.env.MIN_CLAIM_DELAY_SEC ?? 60));
const SMS_DUPLICATE_WINDOW_SEC = Math.max(0, Number(process.env.SMS_DUPLICATE_WINDOW_SEC ?? 90));

const REMINDER_GAP_ENV = readNumberEnv("REMINDER_GAP_MS", 172800000);
const REMINDER_GAP_MS = Math.max(1_000, REMINDER_GAP_ENV.num);

const REMINDER_MAX = Math.max(0, Number(process.env.REMINDER_MAX ?? 3));
const REMINDER_SENDING_ENABLED =
  String(process.env.REMINDER_SENDING_ENABLED ?? "true").toLowerCase() === "true";

/* -------------------- ADMIN -------------------- */
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || "").trim();

/* -------------------- DELIVERY IDEMPOTENCY -------------------- */
const DELIVERY_RETRY_AFTER_MS = Math.max(5_000, Number(process.env.DELIVERY_RETRY_AFTER_MS ?? 60_000));

/* -------------------- HELPERS -------------------- */
function now() {
  return new Date();
}

function getIp(req: Request) {
  const xf = (req.headers["x-forwarded-for"] || "") as string;
  return (xf.split(",")[0] || "").trim() || req.socket.remoteAddress || "";
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256Hex(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

function randomBase64Url(bytes = 32) {
  return crypto
    .randomBytes(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function moneyToCents(dollars: number) {
  const cents = Math.round((Number(dollars) || 0) * 100);
  return Number.isFinite(cents) ? cents : 0;
}

type CanonicalEmailParts = {
  raw: string;
  email: string;
  domain: string;
  emailHash: string;
  domainHash: string;
};

function normalizeEmail(e: unknown) {
  return String(e || "").trim().toLowerCase();
}

function canonicalizeEmailParts(input: unknown): CanonicalEmailParts {
  const raw = String(input || "");
  const email = normalizeEmail(raw);
  const at = email.lastIndexOf("@");
  const domain = at > 0 ? email.slice(at + 1).trim().toLowerCase() : "";

  return {
    raw,
    email,
    domain,
    emailHash: sha256Hex(email),
    domainHash: sha256Hex(domain),
  };
}

function requireVerifiedOAuthEmail(email: any) {
  const canonical = canonicalizeEmailParts(email);
  if (!canonical.email) {
    throw new Error("OAUTH_EMAIL_REQUIRED");
  }
  return canonical.email;
}

function extractDomain(email: unknown) {
  return canonicalizeEmailParts(email).domain;
}

function isDisposableEmail(email: unknown) {
  const canonical = canonicalizeEmailParts(email);
  if (!canonical.domain) return false;
  if (!DISPOSABLE_EMAIL_DOMAINS.size) return false;
  return DISPOSABLE_EMAIL_DOMAINS.has(canonical.domain);
}

function isE164(s: string) {
  return /^\+[1-9]\d{7,14}$/.test(String(s || "").trim());
}

function sha256Base64Url(input: string) {
  return crypto
    .createHash("sha256")
    .update(input)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function parseJwtPayload(token: string): Record<string, any> | null {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return null;
    const payload = parts[1]
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
    const json = Buffer.from(payload, "base64").toString("utf8");
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function isMicrosoftTenantAllowed(tid: string) {
  const tenant = String(tid || "").trim();
  if (!tenant)
    return (
      MICROSOFT_TENANT_ID === "common" ||
      MICROSOFT_TENANT_ID === "organizations" ||
      MICROSOFT_TENANT_ID === "consumers"
    );
  if (MICROSOFT_ALLOWED_TENANT_IDS.size > 0) return MICROSOFT_ALLOWED_TENANT_IDS.has(tenant);
  if (
    MICROSOFT_TENANT_ID === "common" ||
    MICROSOFT_TENANT_ID === "organizations" ||
    MICROSOFT_TENANT_ID === "consumers"
  ) {
    return true;
  }
  return tenant === MICROSOFT_TENANT_ID;
}

async function mxLooksValid(domain: string) {
  if (!AUTH_MX_VALIDATE_ENABLED) return { ok: true, reason: "disabled" as const };
  if (!domain) return { ok: false, reason: "no-domain" as const };
  try {
    const mx = await dns.resolveMx(domain);
    if (!Array.isArray(mx) || mx.length === 0) return { ok: false, reason: "no-mx" as const };
    return { ok: true, reason: "ok" as const };
  } catch {
    return { ok: false, reason: "dns-failed" as const };
  }
}

async function verifyTurnstile(turnstileToken: string, remoteip: string) {
  if (!TURNSTILE_SECRET_KEY) {
    return { ok: true, mode: "disabled" as const, codes: [] as string[] };
  }
  if (TURNSTILE_BYPASS) {
    return { ok: true, mode: "bypass" as const, codes: [] as string[] };
  }

  const body = new URLSearchParams();
  body.set("secret", TURNSTILE_SECRET_KEY);
  body.set("response", String(turnstileToken || ""));
  if (remoteip) body.set("remoteip", remoteip);

  const r = await fetch(TURNSTILE_VERIFY_URL, { method: "POST", body });
  const j: any = await r.json().catch(() => ({}));

  const success = Boolean(j && j.success);
  const codes: string[] = Array.isArray(j?.["error-codes"]) ? j["error-codes"] : [];
  return { ok: success, mode: "enforced" as const, codes };
}

function isAdmin(req: Request) {
  if (!ADMIN_TOKEN) return false;
  const x = String(req.headers["x-admin-token"] || "").trim();
  return Boolean(x && x === ADMIN_TOKEN);
}

function shouldRequireTurnstile() {
  return Boolean(TURNSTILE_SECRET_KEY) && !TURNSTILE_BYPASS;
}

function publicSiteBase() {
  return FRONTEND_URL;
}

function buildAuthConsumeUrl(token: string) {
  return `${publicSiteBase()}/auth/consume?token=${encodeURIComponent(token)}`;
}

function oauthError(res: any, _status: number, code: string, detail: any = undefined) {
  const payload: any = {
    error: "Authentication failed",
    code,
    version: VERSION,
  };

  if (process.env.NODE_ENV !== "production" && detail) {
    payload.detail = detail;
  }

  return res.status(401).json(payload);
}

function logAuth(event: string, fields: Record<string, any> = {}) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      version: VERSION,
      ...fields,
    }),
  );
}

function isValidPresetId(n: any) {
  const v = Number(n);
  return Number.isInteger(v) && v >= PRESET_MIN_ID && v <= PRESET_MAX_ID;
}

function normalizeFixedAmountToCents(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;

  if ((ALLOWED_AMOUNTS_DOLLARS as readonly number[]).includes(n)) return n * 100;
  if (ALLOWED_AMOUNTS_CENTS.has(n)) return n;

  return null;
}

function buildClaimUrl(publicId: string) {
  const base = (process.env.PUBLIC_CLAIM_BASE_URL || `${FRONTEND_URL}/claim`).replace(/\/+$/, "");
  return `${base}/${publicId}`;
}

type AuthProvider = "google" | "facebook" | "linkedin" | "microsoft" | "email";

function normalizeAuthProvider(v: unknown): AuthProvider {
  const raw = String(v || "").trim().toLowerCase();
  if (raw === "google") return "google";
  if (raw === "facebook") return "facebook";
  if (raw === "linkedin") return "linkedin";
  if (raw === "microsoft") return "microsoft";
  return "email";
}

function deriveAuthProvider(user: {
  authProvider?: string | null;
  googleSub?: string | null;
  facebookId?: string | null;
  linkedinId?: string | null;
  microsoftId?: string | null;
} | null): AuthProvider | null {
  if (!user) return null;
  const persisted = normalizeAuthProvider(user.authProvider);
  if (persisted !== "email") return persisted;
  if (String(user.googleSub || "").trim()) return "google";
  if (String(user.facebookId || "").trim()) return "facebook";
  if (String(user.linkedinId || "").trim()) return "linkedin";
  if (String(user.microsoftId || "").trim()) return "microsoft";
  return "email";
}

function logAuthAbuse(event: string, req: Request, fields: Record<string, any> = {}) {
  const ip = getIp(req);
  const ua = String(req.headers["user-agent"] || "").slice(0, 200);

  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ip,
      ua,
      path: req.path,
      method: req.method,
      ...fields,
    }),
  );
}

/* -------------------- AUTH: SESSION REVOKE HELPERS -------------------- */
async function revokeSessionToken(sessionToken: string) {
  const t = String(sessionToken || "").trim();
  if (!t) return { ok: false as const, code: "MISSING_TOKEN" as const };
  const sessionHash = sha256Hex(t);

  const updated = await db
    .update(authSessions)
    .set({ revokedAt: now() })
    .where(and(eq(authSessions.sessionHash, sessionHash), isNull(authSessions.revokedAt)))
    .returning({ userId: authSessions.userId });

  return updated?.length
    ? { ok: true as const, userId: String(updated[0].userId) }
    : { ok: false as const, code: "NOT_FOUND_OR_ALREADY_REVOKED" as const };
}

/* -------------------- STRIPE HELPERS -------------------- */
async function stripePostForm(pathname: string, params: URLSearchParams) {
  if (!STRIPE_SECRET_KEY) {
    return {
      ok: false as const,
      status: 503,
      error: { error: "Stripe not configured", code: "STRIPE_NOT_CONFIGURED" },
    };
  }

  const resp = await fetch(`https://api.stripe.com/v1${pathname}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const json: any = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    return {
      ok: false as const,
      status: resp.status,
      error: json || { error: "Stripe request failed" },
    };
  }

  return { ok: true as const, status: resp.status, data: json };
}

function safeEqualHex(a: string, b: string) {
  const aa = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function stripeWebhookVerify(rawBody: Buffer, sigHeader: string, secret: string) {
  const parts = String(sigHeader || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const tPart = parts.find((p) => p.startsWith("t="));
  const v1Parts = parts.filter((p) => p.startsWith("v1="));
  const t = tPart ? tPart.slice(2) : "";
  const v1s = v1Parts.map((p) => p.slice(3)).filter(Boolean);

  if (!t || !v1s.length) return { ok: false as const, reason: "missing-signature" as const };

  const signedPayload = `${t}.${rawBody.toString("utf8")}`;
  const expected = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");

  const ok = v1s.some((v) => safeEqualHex(v, expected));
  return ok ? { ok: true as const } : { ok: false as const, reason: "mismatch" as const };
}

function normalizeStripePaymentStatus(s: any): string {
  const v = String(s || "").trim().toLowerCase();
  if (!v) return "unknown";
  return v;
}

function stripeIsPaid(sessionPaymentStatus: any): boolean {
  const v = normalizeStripePaymentStatus(sessionPaymentStatus);
  return v === "paid";
}

function getStripeRawBody(req: Request): Buffer {
  const rb = (req as any).rawBody;
  if (Buffer.isBuffer(rb) && rb.length) return rb as Buffer;
  const b = (req as any).body;
  if (Buffer.isBuffer(b) && b.length) return b as Buffer;
  return Buffer.from("");
}

/* -------------------- DAILY COUNTS -------------------- */
const memIpCounts = new Map<string, { day: string; count: number }>();
const memPhoneCounts = new Map<string, { day: string; count: number }>();

function dayKey(d: Date) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function bumpMemIp(ip: string) {
  const k = dayKey(new Date());
  const cur = memIpCounts.get(ip);
  if (!cur || cur.day !== k) {
    memIpCounts.set(ip, { day: k, count: 1 });
    return 1;
  }
  cur.count += 1;
  memIpCounts.set(ip, cur);
  return cur.count;
}

function getMemIp(ip: string) {
  const k = dayKey(new Date());
  const cur = memIpCounts.get(ip);
  if (!cur || cur.day !== k) return 0;
  return cur.count;
}

function bumpMemPhone(p: string) {
  const k = dayKey(new Date());
  const cur = memPhoneCounts.get(p);
  if (!cur || cur.day !== k) {
    memPhoneCounts.set(p, { day: k, count: 1 });
    return 1;
  }
  cur.count += 1;
  memPhoneCounts.set(p, cur);
  return cur.count;
}

function getMemPhone(p: string) {
  const k = dayKey(new Date());
  const cur = memPhoneCounts.get(p);
  if (!cur || cur.day !== k) return 0;
  return cur.count;
}

async function countDailyBySenderEmail(senderEmail: string) {
  if (!DAILY_LIMIT_SENDER) return 0;

  const canonical = canonicalizeEmailParts(senderEmail);
  if (!canonical.emailHash) return 0;

  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const rows = await db
    .select({ c: sql<number>`count(*)` })
    .from(gifts)
    .where(
      and(
        eq(gifts.senderEmailHash, canonical.emailHash),
        gte(gifts.createdAt, start)
      )
    );

  return Number(rows?.[0]?.c || 0);
}
/* -------------------- AUTH EMAIL DB THROTTLE -------------------- */
const AUTH_DB_WINDOW_MS = 15 * 60 * 1000;
const AUTH_DB_MAX = 3;

async function getAuthEmailThrottle(emailHash: string) {
  const rows = await db
    .select({
      id: authEmailThrottle.id,
      count: authEmailThrottle.count,
      windowStart: authEmailThrottle.windowStart,
    })
    .from(authEmailThrottle)
    .where(eq(authEmailThrottle.emailHash, emailHash))
    .orderBy(desc(authEmailThrottle.windowStart))
    .limit(1);

  return rows?.[0] || null;
}

async function bumpAuthEmailThrottle(emailHash: string) {
  const nowTs = new Date();
  const existing = await getAuthEmailThrottle(emailHash);

  if (!existing) {
    await db.insert(authEmailThrottle).values({
      emailHash,
      windowStart: nowTs,
      count: 1,
    });
    return 1;
  }

  const windowAge = nowTs.getTime() - new Date(existing.windowStart).getTime();

  if (windowAge >= AUTH_DB_WINDOW_MS) {
    await db.insert(authEmailThrottle).values({
      emailHash,
      windowStart: nowTs,
      count: 1,
    });
    return 1;
  }

  const updated = await db
    .update(authEmailThrottle)
    .set({ count: existing.count + 1 })
    .where(eq(authEmailThrottle.id, existing.id))
    .returning({ count: authEmailThrottle.count });

  return Number(updated?.[0]?.count || existing.count + 1);
}

async function getAuthDomainThrottle(domainHash: string) {
  const rows = await db
    .select({
      id: authEmailThrottle.id,
      count: authEmailThrottle.count,
      windowStart: authEmailThrottle.windowStart,
    })
    .from(authEmailThrottle)
    .where(eq(authEmailThrottle.emailHash, domainHash))
    .orderBy(desc(authEmailThrottle.windowStart))
    .limit(1);

  return rows?.[0] || null;
}

async function bumpAuthDomainThrottle(domainHash: string) {
  const nowTs = new Date();
  const existing = await getAuthDomainThrottle(domainHash);

  if (!existing) {
    await db.insert(authEmailThrottle).values({
      emailHash: domainHash,
      windowStart: nowTs,
      count: 1,
    });
    return 1;
  }

  const windowAge = nowTs.getTime() - new Date(existing.windowStart).getTime();

  if (windowAge >= AUTH_DB_WINDOW_MS) {
    await db.insert(authEmailThrottle).values({
      emailHash: domainHash,
      windowStart: nowTs,
      count: 1,
    });
    return 1;
  }

  const updated = await db
    .update(authEmailThrottle)
    .set({ count: existing.count + 1 })
    .where(eq(authEmailThrottle.id, existing.id))
    .returning({ count: authEmailThrottle.count });

  return Number(updated?.[0]?.count || existing.count + 1);
}
/* -------------------- AUTH -------------------- */
type Authed =
  | { isAuthed: true; userId: string; sessionToken: string; source: "cookie" }
  | { isAuthed: false };

const AUTH_COOKIE_NAME = "tm_session";
const AUTH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/",
};

function readSessionTokenFromCookie(req: Request) {
  return String((req as any)?.cookies?.[AUTH_COOKIE_NAME] || "").trim();
}

function setAuthCookie(res: any, sessionToken: string, expiresAt: Date) {
  res.cookie(AUTH_COOKIE_NAME, sessionToken, {
    ...AUTH_COOKIE_OPTIONS,
    expires: expiresAt,
  });
}

function clearAuthCookie(res: any) {
  res.clearCookie(AUTH_COOKIE_NAME, AUTH_COOKIE_OPTIONS);
}

async function getAuth(req: Request): Promise<Authed> {
  const cookieToken = readSessionTokenFromCookie(req);

  let sessionToken = cookieToken;
  let source: "cookie" = "cookie";

  if (!sessionToken) return { isAuthed: false };

  const sessionHash = sha256Hex(sessionToken);

  const row = await db
    .select({
      userId: authSessions.userId,
      expiresAt: authSessions.expiresAt,
      revokedAt: authSessions.revokedAt,
    })
    .from(authSessions)
    .where(eq(authSessions.sessionHash, sessionHash))
    .limit(1);

  const s = row?.[0];
  if (!s) return { isAuthed: false };
  if (s.revokedAt) return { isAuthed: false };
  if (s.expiresAt && new Date(s.expiresAt).getTime() <= Date.now()) return { isAuthed: false };

  return { isAuthed: true, userId: String(s.userId), sessionToken, source };
}

async function issueSessionForEmail(
  email: string,
  req: Request,
  opts?: {
    authProvider?: AuthProvider;
    googleSub?: string | null;
    facebookId?: string | null;
    linkedinId?: string | null;
    microsoftId?: string | null;
  },
) {
  const canonicalEmail = canonicalizeEmailParts(email);
  const norm = canonicalEmail.email;
  const domain = canonicalEmail.domain;

  if (!domain) {
    return { ok: false as const, code: "INVALID_EMAIL" as const, error: "Invalid email" };
  }
  if (isDisposableEmail(norm)) {
    return {
      ok: false as const,
      code: "DISPOSABLE_EMAIL_BLOCKED" as const,
      error: "Email provider not supported",
    };
  }

  const authProvider = normalizeAuthProvider(opts?.authProvider);

  if (authProvider === "email") {
    const mx = await mxLooksValid(domain);
    if (!mx.ok) {
      return {
        ok: false as const,
        code: "MX_INVALID" as const,
        error: "Email domain not deliverable",
        reason: mx.reason,
      };
    }
  }

  const googleSub = String(opts?.googleSub || "").trim() || null;
  const facebookId = String(opts?.facebookId || "").trim() || null;
  const linkedinId = String(opts?.linkedinId || "").trim() || null;
  const microsoftId = String(opts?.microsoftId || "").trim() || null;

  const byProvider =
    googleSub
      ? await db
          .select({
            id: users.id,
            email: users.email,
            authProvider: users.authProvider,
            googleSub: users.googleSub,
            facebookId: users.facebookId,
            linkedinId: users.linkedinId,
            microsoftId: (users as any).microsoftId,
          })
          .from(users)
          .where(eq(users.googleSub, googleSub))
          .limit(1)
      : facebookId
        ? await db
            .select({
              id: users.id,
              email: users.email,
              authProvider: users.authProvider,
              googleSub: users.googleSub,
              facebookId: users.facebookId,
              linkedinId: users.linkedinId,
              microsoftId: (users as any).microsoftId,
            })
            .from(users)
            .where(eq(users.facebookId, facebookId))
            .limit(1)
        : linkedinId
          ? await db
              .select({
                id: users.id,
                email: users.email,
                authProvider: users.authProvider,
                googleSub: users.googleSub,
                facebookId: users.facebookId,
                linkedinId: users.linkedinId,
                microsoftId: (users as any).microsoftId,
              })
              .from(users)
              .where(eq(users.linkedinId, linkedinId))
              .limit(1)
          : microsoftId
            ? await db
                .select({
                  id: users.id,
                  email: users.email,
                  authProvider: users.authProvider,
                  googleSub: users.googleSub,
                  facebookId: users.facebookId,
                  linkedinId: users.linkedinId,
                  microsoftId: (users as any).microsoftId,
                })
                .from(users)
                .where(eq((users as any).microsoftId, microsoftId))
                .limit(1)
            : [];

  const byEmail = await db
    .select({
      id: users.id,
      email: users.email,
      authProvider: users.authProvider,
      googleSub: users.googleSub,
      facebookId: users.facebookId,
      linkedinId: users.linkedinId,
      microsoftId: (users as any).microsoftId,
    })
    .from(users)
    .where(eq(users.email, canonicalEmail.email))
    .limit(1);

  const providerUser = byProvider?.[0];
  const emailUser = byEmail?.[0];

  if (providerUser && emailUser && String(providerUser.id || "") !== String(emailUser.id || "")) {
    return {
      ok: false as const,
      code: "OAUTH_EMAIL_ALREADY_LINKED" as const,
      error: "This email is already linked to another account",
    };
  }

  let userId = "";

  if (providerUser) {
    userId = String(providerUser.id || "");
  } else if (emailUser) {
    userId = String(emailUser.id || "");
  }

  if (!userId) {
    userId = crypto.randomBytes(16).toString("hex");
    await db.insert(users).values({
      id: userId,
      email: norm,
      authProvider,
      googleSub,
      facebookId,
      linkedinId,
      microsoftId,
      createdAt: now(),
      lastLoginAt: null,
    } as any);
  }

  const sessionToken = randomToken(32);
  const sessionHash = sha256Hex(sessionToken);
  const expiresAt = new Date(Date.now() + AUTH_SESSION_TTL_MS);
  const ip = getIp(req);
  const ua = String(req.headers["user-agent"] || "").slice(0, 500);

  await db.transaction(async (tx) => {
    await tx.insert(authSessions).values({
      userId,
      sessionHash,
      expiresAt,
      revokedAt: null,
      ip,
      userAgent: ua || null,
      createdAt: now(),
    });

    const userPatch: Record<string, any> = {
      lastLoginAt: now(),
      authProvider,
      email: norm,
    };

    if (googleSub) userPatch.googleSub = googleSub;
    if (facebookId) userPatch.facebookId = facebookId;
    if (linkedinId) userPatch.linkedinId = linkedinId;
    if (microsoftId) userPatch.microsoftId = microsoftId;

    await tx.update(users).set(userPatch).where(eq(users.id, userId));
  });

  return { ok: true as const, userId, sessionToken, expiresAt };
}

/* -------------------- DELIVERY (EXACT-ONCE BEST-EFFORT) -------------------- */
async function deliverGiftIfEligible(publicId: string, reason: string) {
  const claimed = await db.transaction(async (tx) => {
    const row = await tx
      .select({
        id: gifts.id,
        publicId: gifts.publicId,
        recipientEmail: gifts.recipientEmail,
        recipientPhone: gifts.recipientPhone,
        senderEmail: gifts.senderEmail,
        messageMode: gifts.messageMode,
        presetMessageId: gifts.presetMessageId,
        message: gifts.message,
        amount: gifts.amount,
        paymentStatus: gifts.paymentStatus,
        paidAt: gifts.paidAt,
        deliveredAt: (gifts as any).deliveredAt,
        deliveredEmailAt: (gifts as any).deliveredEmailAt,
        deliveredSmsAt: (gifts as any).deliveredSmsAt,
        deliveryAttemptedAt: (gifts as any).deliveryAttemptedAt,
        deliveryError: (gifts as any).deliveryError,
      })
      .from(gifts)
      .where(eq(gifts.publicId, publicId))
      .limit(1);

    const g = row?.[0];
    if (!g) return { ok: false as const, code: "NOT_FOUND" as const };

    const alreadyDelivered = Boolean((g as any).deliveredAt);
    if (alreadyDelivered) return { ok: false as const, code: "ALREADY_DELIVERED" as const };

    const requiresPayment = g.amount != null;
    if (requiresPayment) {
      const paid = Boolean(g.paidAt) || String(g.paymentStatus || "").toLowerCase() === "paid";
      if (!paid) return { ok: false as const, code: "NOT_PAID" as const };
    }

    const toEmail = g.recipientEmail ? canonicalizeEmailParts(g.recipientEmail).email : "";
    const toPhone = String(g.recipientPhone || "").trim();

    if (!toEmail && !toPhone) return { ok: false as const, code: "NO_RECIPIENT" as const };

    const attemptedCol = (gifts as any).deliveryAttemptedAt;
    const deliveredCol = (gifts as any).deliveredAt;
    const errCol = (gifts as any).deliveryError;
    const cutoff = new Date(Date.now() - DELIVERY_RETRY_AFTER_MS);

    const updated = await tx
      .update(gifts)
      .set({
        deliveryAttemptedAt: now() as any,
        deliveryError: null as any,
      })
      .where(
        and(
          eq(gifts.id, g.id),
          isNull(deliveredCol),
          or(isNull(attemptedCol), and(lt(attemptedCol, cutoff), sql`${errCol} is not null`)),
        ),
      )
      .returning({ id: gifts.id });

    if (!updated?.length)
      return { ok: false as const, code: "IN_PROGRESS_OR_ALREADY_ATTEMPTED" as const };

    return {
      ok: true as const,
      gift: {
        id: g.id,
        publicId: g.publicId,
        toEmail,
        toPhone,
        senderEmail: String(g.senderEmail || "").trim() || "",
        messageMode: String(g.messageMode || "preset"),
        presetMessageId: g.presetMessageId ?? null,
        message: String(g.message || ""),
        amountCents: g.amount == null ? null : Number(g.amount),
        deliveredEmailAt: (g as any).deliveredEmailAt,
        deliveredSmsAt: (g as any).deliveredSmsAt,
      },
    };
  });

  if (!claimed.ok) {
    return claimed;
  }

  const g = claimed.gift;
  const claimUrl = buildClaimUrl(g.publicId);

  let emailOk = false;
  let smsOk = false;
  const errs: string[] = [];

  if (g.toEmail) {
    if (g.deliveredEmailAt) {
      emailOk = true;
    } else {
      try {
        await sendGiftEmail({
          to: g.toEmail,
          publicId: g.publicId,
          claimUrl,
          amountCents: g.amountCents,
          senderEmail: g.senderEmail || undefined,
          message: g.messageMode === "custom" ? (String(g.message || "").trim() || undefined) : undefined,
          presetMessageId: g.messageMode === "preset" ? (g.presetMessageId ?? undefined) : undefined,
        } as any);
        emailOk = true;
      } catch (e: any) {
        errs.push(`email: ${String(e?.message || e)}`);
      }
    }
  } else {
    emailOk = true;
  }

  if (g.toPhone) {
    if (g.deliveredSmsAt) {
      smsOk = true;
    } else {
      try {
        await sendGiftSms({
          toPhone: g.toPhone,
          publicId: g.publicId,
          claimUrl,
        } as any);
        smsOk = true;
      } catch (e: any) {
        errs.push(`sms: ${String(e?.message || e)}`);
      }
    }
  } else {
    smsOk = true;
  }

  const deliveryOk = Boolean(emailOk && smsOk);
  const deliveryError = errs.length ? errs.join("; ") : null;

  await db
    .update(gifts)
    .set(
      {
        deliveredAt: deliveryOk ? (now() as any) : (null as any),
        deliveredEmailAt: g.toEmail && emailOk ? (now() as any) : (undefined as any),
        deliveredSmsAt: g.toPhone && smsOk ? (now() as any) : (undefined as any),
        deliveryError: deliveryError as any,
      } as any,
    )
    .where(eq(gifts.id, g.id));

  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: "delivery_attempt_finished",
      reason,
      publicId: g.publicId,
      email: g.toEmail ? emailOk : null,
      sms: g.toPhone ? smsOk : null,
      ok: deliveryOk,
      error: deliveryError || undefined,
      version: VERSION,
    }),
  );

  return { ok: true as const, delivered: deliveryOk, deliveryError };
}

/* -------------------- VALIDATION -------------------- */
const zEmail = z.string().trim().email();

const zCreateGift = z.object({
  recipientEmail: zEmail.optional().nullable(),
  recipientPhone: z.string().trim().optional().nullable(),

  senderEmail: zEmail.optional().nullable(),

  messageMode: z.enum(["preset", "custom"]).optional(),
  presetMessageId: z.coerce.number().int().optional().nullable(),
  message: z.string().trim().max(280).optional().nullable(),

  amountDollars: z.coerce.number().optional().nullable(),
  amountCents: z.coerce.number().int().optional().nullable(),
  amount: z.coerce.number().optional().nullable(),

  turnstileToken: z.string().trim().optional().nullable(),
});

const zAuthRequest = z.object({
  email: zEmail,
  turnstileToken: z.string().trim().optional().nullable(),
});

const zAuthConsume = z.object({
  token: z.string().trim().min(10),
});

const zStripeCheckout = z.object({
  amount: z.any(),
  publicId: z.string().trim().optional().nullable(),
  successUrl: z.string().trim().url().optional().nullable(),
  cancelUrl: z.string().trim().url().optional().nullable(),
});

const zAdminReconcile = z.object({
  publicId: z.string().trim().optional().nullable(),
  limit: z.coerce.number().int().optional().nullable(),
});

const zAdminRevokeSessions = z.object({
  userId: z.string().trim().optional().nullable(),
  sessionHash: z.string().trim().optional().nullable(),
});

const zAdminRemindersSend = z.object({
  limit: z.coerce.number().int().optional().nullable(),
  publicId: z.string().trim().optional().nullable(),
});

/* -------------------- RATE LIMITERS -------------------- */
const limiterCreateGift = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

const limiterAuthRequest = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  requestPropertyName: "authRequestRateLimit",
  keyGenerator: (req) => ipKeyGenerator(getIp(req) || req.ip || "unknown"),
  handler: (req, res) => {
    const ip = getIp(req);
    const authRequestRateLimit = (req as any).authRequestRateLimit;
if (authRequestRateLimit) {
  const remaining = Number(authRequestRateLimit.remaining ?? -1);
  const limit = Number(authRequestRateLimit.limit ?? -1);

  if (remaining >= 0 && limit > 0 && remaining <= 2) {
    logAuthAbuse("auth_request_ip_near_limit", req, {
      ip,
      remaining,
      limit,
      path: req.originalUrl,
      method: req.method,
    });
  }
}

    logAuthAbuse("auth_request_ip_rate_limited", req, {
      code: "AUTH_REQUEST_IP_RATE_LIMITED",
      ip,
      path: req.originalUrl,
      method: req.method,
    });

    return res.status(429).json({
      error: "Too many requests",
      code: "AUTH_REQUEST_IP_RATE_LIMITED",
      retryAfterSec: 60,
      version: VERSION,
    });
  },
});

const limiterAuthConsume = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

const limiterAdmin = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

const limiterGoogle = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

const limiterFacebook = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

const limiterLinkedin = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

const limiterMicrosoft = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

const limiterStripe = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,

});
const limiterClaim = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(getIp(req) || req.ip || "unknown"),
  handler: (req, res) => {
    const ip = getIp(req);

    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: "abuse_claim_rate_limited",
        ip,
        path: req.originalUrl,
        method: req.method,
        version: VERSION,
      }),
    );

    return res.status(429).json({
      error: "Too many claim attempts",
      code: "CLAIM_RATE_LIMITED",
      retryAfterSec: 60,
      version: VERSION,
    });
  },
});
/* -------------------- STRIPE CORE HANDLERS -------------------- */
async function handleCreateCheckoutSession(req: Request, res: any) {
  try {
    const a = await getAuth(req);
    if (!a.isAuthed) {
      return res.status(401).json({
  error: "Authentication required",
  code: "AUTH_REQUIRED",
  version: VERSION,
});
    }

    if (!STRIPE_SECRET_KEY || !STRIPE_PUBLISHABLE_KEY) {
      return res.status(503).json({
        error: "Stripe not configured",
        code: "STRIPE_NOT_CONFIGURED",
        version: VERSION,
      });
    }

    const parsed = zStripeCheckout.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid request",
        code: "INVALID_REQUEST",
        issues: parsed.error.issues,
        version: VERSION,
      });
    }

    const amountCents = normalizeFixedAmountToCents(parsed.data.amount);
    if (!amountCents) {
      return res.status(400).json({
        error: `Amount must be one of: ${ALLOWED_AMOUNTS_DOLLARS.join(", ")}`,
        field: "amount",
        code: "AMOUNT_NOT_ALLOWED",
        version: VERSION,
      });
    }
    if (amountCents < MIN_AMOUNT_CENTS_REGISTERED) {
      return res.status(400).json({
        error: "Minimum amount is $25",
        field: "amount",
        code: "MIN_AMOUNT",
        version: VERSION,
      });
    }

    const publicId = String(parsed.data.publicId || "").trim();

    if (publicId) {
      const g = await db
        .select({
          id: gifts.id,
          senderUserId: gifts.senderUserId,
          amount: gifts.amount,
          paymentStatus: gifts.paymentStatus,
          paidAt: gifts.paidAt,
        })
        .from(gifts)
        .where(eq(gifts.publicId, publicId))
        .limit(1);

      const row = g?.[0];
      if (!row) {
        return res.status(404).json({ error: "Gift not found", code: "GIFT_NOT_FOUND", version: VERSION });
      }
      if (String(row.senderUserId || "") !== a.userId) {
        return res.status(403).json({ error: "Forbidden", code: "FORBIDDEN", version: VERSION });
      }
      if (row.paidAt || String(row.paymentStatus || "").toLowerCase() === "paid") {
        return res.status(409).json({ error: "Already paid", code: "ALREADY_PAID", version: VERSION });
      }
      if (row.amount != null && Number(row.amount) !== amountCents) {
        return res.status(400).json({
          error: "Amount mismatch for gift",
          code: "AMOUNT_MISMATCH",
          version: VERSION,
        });
      }
    }

    const successUrl = `${FRONTEND_URL}/pay/success?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${FRONTEND_URL}/pay/cancel`;

    const params = new URLSearchParams();
    params.set("mode", "payment");
    params.set("success_url", successUrl);
    params.set("cancel_url", cancelUrl);

    params.set("line_items[0][quantity]", "1");
    params.set("line_items[0][price_data][currency]", STRIPE_CURRENCY);
    params.set("line_items[0][price_data][unit_amount]", String(amountCents));
    params.set("line_items[0][price_data][product_data][name]", "ThankuMail Gift");
    params.set(
      "line_items[0][price_data][product_data][description]",
      "A ThankuMail gift certificate payment",
    );

    params.set("metadata[userId]", a.userId);
    if (publicId) params.set("metadata[publicId]", publicId);
    params.set("client_reference_id", a.userId);

    const created = await stripePostForm("/checkout/sessions", params);
    if (!created.ok) {
      return res.status(created.status).json({
        error: "Stripe session create failed",
        code: "STRIPE_CREATE_SESSION_FAILED",
        stripe: created.error,
        version: VERSION,
      });
    }

    const sessionId = String(created.data?.id || "");
    const sessionUrl = String(created.data?.url || "");

    if (publicId && sessionId) {
  const updated = await db
    .update(gifts)
    .set({
      stripeCheckoutSessionId: sessionId,
      paymentStatus: "created",
    })
    .where(
      and(
        eq(gifts.publicId, publicId),
        eq(gifts.senderUserId, a.userId),
        isNull(gifts.stripeCheckoutSessionId),
        isNull(gifts.paidAt),
      ),
    )
    .returning({
      id: gifts.id,
      stripeCheckoutSessionId: gifts.stripeCheckoutSessionId,
    });

  if (!updated?.length) {
    return res.status(409).json({
      error: "Checkout session already exists or gift already paid",
      code: "CHECKOUT_SESSION_ALREADY_EXISTS",
      version: VERSION,
    });
  }
}

    return res.json({
      ok: true,
      sessionId,
      url: sessionUrl,
      amountCents,
      currency: STRIPE_CURRENCY,
      version: VERSION,
    });
  } catch (err: any) {
    return res.status(500).json({
      error: "Stripe create session failed",
      code: "STRIPE_CREATE_SESSION_FAILED",
      detail: String(err?.message || err),
      version: VERSION,
    });
  }
}

async function handleStripeWebhook(req: Request, res: any) {
  try {
    if (!STRIPE_WEBHOOK_SECRET) return res.status(503).send("Stripe webhook not configured");

    const sig = String(req.headers["stripe-signature"] || "");
    const rawBody = getStripeRawBody(req);

    if (!sig || !rawBody.length) return res.status(400).send("Missing signature/body");

    const v = stripeWebhookVerify(rawBody, sig, STRIPE_WEBHOOK_SECRET);
    if (!v.ok) return res.status(400).send("Invalid signature");

    const event = JSON.parse(rawBody.toString("utf8") || "{}");
    const eventId = String(event?.id || "");
    const type = String(event?.type || "");
    const obj = event?.data?.object || null;

    if (!eventId) return res.status(400).send("Missing event id");

    try {
      await db.insert(stripeWebhookEvents).values({
        stripeEventId: eventId,
        stripeType: type,
        receivedAt: now(),
      });
    } catch {
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: "stripe_webhook_duplicate_ignored",
          stripeEventId: eventId,
          version: VERSION,
        }),
      );
      return res.status(200).send("duplicate");
    }

    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: "stripe_webhook_received",
        stripeType: type,
        stripeId: eventId,
        version: VERSION,
      }),
    );

    if (type === "checkout.session.completed") {
      const sessionId = String(obj?.id || "");
      const paymentIntentId = String(obj?.payment_intent || "");
      const paymentStatus = normalizeStripePaymentStatus(obj?.payment_status);
      const amountTotal = obj?.amount_total ?? null;
      const metadata = obj?.metadata || {};
      const publicId = String(metadata?.publicId || "").trim();

      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: "stripe_checkout_completed",
          sessionId,
          paymentIntentId,
          paymentStatus,
          amountTotal,
          publicId: publicId || null,
          version: VERSION,
        }),
      );

      if (publicId) {
        const amountCents = amountTotal != null ? Number(amountTotal) : null;
        let shouldDeliver = false;

        await db.transaction(async (tx) => {
          const row = await tx
            .select({
              id: gifts.id,
              amount: gifts.amount,
              paymentStatus: gifts.paymentStatus,
              paidAt: gifts.paidAt,
            })
            .from(gifts)
            .where(eq(gifts.publicId, publicId))
            .limit(1);

          const g = row?.[0];
          if (!g) return;

          const alreadyPaid =
            Boolean(g.paidAt) || String(g.paymentStatus || "").toLowerCase() === "paid";

          const existingAmountCents =
            g.amount == null || g.amount === undefined ? null : Number(g.amount);

          const normalizedAmountCents =
            amountCents != null && Number.isFinite(amountCents) ? Number(amountCents) : null;

          if (
            stripeIsPaid(paymentStatus) &&
            existingAmountCents != null &&
            normalizedAmountCents != null &&
            existingAmountCents !== normalizedAmountCents
          ) {
            await tx
              .update(gifts)
              .set({
                stripeCheckoutSessionId: sessionId || null,
                stripePaymentIntentId: paymentIntentId || null,
                paymentStatus: "amount_mismatch",
              })
              .where(eq(gifts.id, g.id));

            console.log(
              JSON.stringify({
                ts: new Date().toISOString(),
                event: "stripe_checkout_amount_mismatch",
                publicId,
                sessionId,
                expectedAmount: existingAmountCents,
                actualAmount: normalizedAmountCents,
                version: VERSION,
              }),
            );

            shouldDeliver = false;
            return;
          }

          if (alreadyPaid) {
            await tx
              .update(gifts)
              .set({
                stripeCheckoutSessionId: sessionId || null,
                stripePaymentIntentId: paymentIntentId || null,
                paymentStatus: "paid",
              })
              .where(eq(gifts.id, g.id));

            shouldDeliver = false;
            return;
          }

          await tx
            .update(gifts)
            .set({
              paymentStatus: stripeIsPaid(paymentStatus) ? "paid" : paymentStatus,
              stripeCheckoutSessionId: sessionId || null,
              stripePaymentIntentId: paymentIntentId || null,
              paidAt: stripeIsPaid(paymentStatus) ? now() : null,
            })
            .where(eq(gifts.id, g.id));

          shouldDeliver = stripeIsPaid(paymentStatus);
        });

        if (shouldDeliver) {
          try {
            await deliverGiftIfEligible(publicId, "stripe_webhook_paid");
          } catch (e: any) {
            console.log(
              JSON.stringify({
                ts: new Date().toISOString(),
                event: "delivery_after_paid_error",
                publicId,
                error: String(e?.message || e),
                version: VERSION,
              }),
            );
          }
        }
      }
    }

    return res.status(200).send("ok");
  } catch (err: any) {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: "stripe_webhook_error",
        error: String(err?.message || err),
        version: VERSION,
      }),
    );
    return res.status(500).send("error");
  }
}

/* -------------------- ROUTES -------------------- */
export function registerRoutes(app: Express): Server {
  /* -------------------- HEALTH/VERSION -------------------- */
  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      version: VERSION,
      commit: COMMIT,
      marker: ROUTES_MARKER,
      ts: new Date().toISOString(),
    });
  });

  app.get("/api/version", (_req, res) => {
    res.json({
      version: VERSION,
      commit: COMMIT,
      routesMarker: ROUTES_MARKER,

      urls: { frontend: FRONTEND_URL, api: API_URL },

      stripe: {
        configured: Boolean(STRIPE_SECRET_KEY && STRIPE_PUBLISHABLE_KEY),
        hasSecretKey: Boolean(STRIPE_SECRET_KEY),
        hasPublishableKey: Boolean(STRIPE_PUBLISHABLE_KEY),
        hasWebhookSecret: Boolean(STRIPE_WEBHOOK_SECRET),
        currency: STRIPE_CURRENCY,
      },

      turnstile: {
        configured: Boolean(TURNSTILE_SECRET_KEY),
        bypass: TURNSTILE_BYPASS,
        mode: TURNSTILE_SECRET_KEY ? (TURNSTILE_BYPASS ? "bypass" : "enforced") : "disabled",
      },

      auth: {
        magicLinkEnabled: AUTH_MAGIC_LINK_ENABLED,
        magicLinkTtlMs: AUTH_MAGIC_LINK_TTL_MS,
        sessionTtlMs: AUTH_SESSION_TTL_MS,
        returnToken: AUTH_RETURN_TOKEN,
        mxValidateEnabled: AUTH_MX_VALIDATE_ENABLED,
        disposableListSize: DISPOSABLE_EMAIL_DOMAINS.size,
        disposableFileLoaded: DISPOSABLE_EMAIL_DOMAINS_FILE.size > 0,
        disposableEnvLoaded: DISPOSABLE_EMAIL_DOMAINS_ENV.size > 0,
        disposableFilePath: DISPOSABLE_EMAIL_DOMAINS_FILE_PATH,
        authConsumeUrlSample: `${publicSiteBase()}/auth/consume?token=...`,
        canonicalEmailPipeline: true,
      },

      google: {
        configured: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
        redirectUri: GOOGLE_REDIRECT_URI,
      },

      facebook: {
        configured: Boolean(FACEBOOK_APP_ID && FACEBOOK_APP_SECRET),
        redirectUri: FACEBOOK_REDIRECT_URI,
        hasAppId: Boolean(FACEBOOK_APP_ID),
        hasAppSecret: Boolean(FACEBOOK_APP_SECRET),
      },

      linkedin: {
        configured: Boolean(LINKEDIN_CLIENT_ID && LINKEDIN_CLIENT_SECRET),
        redirectUri: LINKEDIN_REDIRECT_URI,
        hasClientId: Boolean(LINKEDIN_CLIENT_ID),
        hasClientSecret: Boolean(LINKEDIN_CLIENT_SECRET),
      },

      microsoft: {
        configured: Boolean(MICROSOFT_CLIENT_ID && MICROSOFT_CLIENT_SECRET && MICROSOFT_TENANT_ID),
        redirectUri: MICROSOFT_REDIRECT_URI,
        hasClientId: Boolean(MICROSOFT_CLIENT_ID),
        hasClientSecret: Boolean(MICROSOFT_CLIENT_SECRET),
        tenantId: MICROSOFT_TENANT_ID || null,
        allowedTenantIdsConfigured: MICROSOFT_ALLOWED_TENANT_IDS.size > 0,
        pkce: true,
        nonce: true,
      },

      limits: {
        dailyLimitIp: DAILY_LIMIT_IP,
        dailyLimitSender: DAILY_LIMIT_SENDER,
        dailyLimitPhone: DAILY_LIMIT_PHONE,
        minClaimDelaySec: MIN_CLAIM_DELAY_SEC,
        smsDuplicateWindowSec: SMS_DUPLICATE_WINDOW_SEC,
      },

      reminders: {
        reminderGapMs: REMINDER_GAP_MS,
        reminderGapEnv: {
          raw: REMINDER_GAP_ENV.raw,
          parsed: REMINDER_GAP_ENV.num,
        },
        reminderMax: REMINDER_MAX,
        reminderSendingEnabled: REMINDER_SENDING_ENABLED,
      },

      lockedScope: {
        guest: { delivery: "email-only", message: "preset-only", amount: "none", sms: "no" },
        registered: {
          delivery: "email-or-sms",
          message: "preset-or-custom (max 280)",
          amount: `optional (allowed: ${ALLOWED_AMOUNTS_DOLLARS.join(", ")}; min $25 when present)`,
          sms: "optional",
          auth: "google + facebook + linkedin + microsoft",
        },
      },

      presetIds: { min: PRESET_MIN_ID, max: PRESET_MAX_ID },
    });
  });
app.get("/api/supporters", async (_req, res) => {
  try {
    const rows = await db
      .select({
        name: supporters.name,
        anonymous: supporters.anonymous,
      })
      .from(supporters)
      .orderBy(desc(supporters.createdAt));

    res.json({ supporters: rows });
  } catch {
    res.status(500).json({ error: "Failed to load supporters" });
  }
});

  /* -------------------- STRIPE: CONFIG -------------------- */
  app.get("/api/stripe/config", (_req, res) => {
    if (!STRIPE_PUBLISHABLE_KEY) {
      return res.status(503).json({
        error: "Stripe not configured",
        code: "STRIPE_NOT_CONFIGURED",
        version: VERSION,
      });
    }

    return res.json({
      ok: true,
      publishableKey: STRIPE_PUBLISHABLE_KEY,
      configured: Boolean(STRIPE_SECRET_KEY && STRIPE_PUBLISHABLE_KEY),
      version: VERSION,
      commit: COMMIT,
    });
  });

  /* -------------------- STRIPE: CHECKOUT SESSION (CANONICAL + ALIAS) -------------------- */
  app.post("/api/stripe/checkout/session", limiterStripe, handleCreateCheckoutSession);
  app.post("/api/stripe/create-checkout-session", limiterStripe, handleCreateCheckoutSession);

  /* -------------------- STRIPE: WEBHOOK (CANONICAL + ALIAS) -------------------- */
  app.post("/api/webhooks/stripe", limiterStripe, handleStripeWebhook);
  app.post("/api/stripe/webhook", limiterStripe, handleStripeWebhook);

  /* -------------------- AUTH: LOGOUT (REVOKE CURRENT SESSION) -------------------- */
  app.post("/api/auth/logout", async (req, res) => {
    const a = await getAuth(req);

    clearAuthCookie(res);

    if (!a.isAuthed) {
  return res.status(401).json({
    error: "Unauthorized",
    code: "UNAUTHORIZED",
    version: VERSION,
  });
}

    const r = await revokeSessionToken(a.sessionToken);

    return res.json({
      ok: true,
      revoked: r.ok,
      version: VERSION,
    });
  });

    /* -------------------- AUTH: ME -------------------- */
  app.get("/api/auth/me", async (req, res) => {
    try {
      const a = await getAuth(req);

      if (!a.isAuthed) {
        return res.status(401).json({
          error: "Unauthorized",
          code: "UNAUTHORIZED",
          version: VERSION,
        });
      }

      const rows = await db
        .select({
          id: users.id,
          email: users.email,
          authProvider: users.authProvider,
          googleSub: users.googleSub,
          facebookId: users.facebookId,
          linkedinId: users.linkedinId,
          microsoftId: (users as any).microsoftId,
          createdAt: users.createdAt,
          lastLoginAt: users.lastLoginAt,
        })
        .from(users)
        .where(eq(users.id, a.userId))
        .limit(1);

      const user = rows?.[0];
      if (!user) {
        return res.status(401).json({
          error: "Unauthorized",
          code: "UNAUTHORIZED",
          version: VERSION,
        });
      }

      return res.json({
        ok: true,
        user: {
          id: String(user.id),
          email: String(user.email || ""),
          authProvider: deriveAuthProvider(user),
          createdAt: user.createdAt,
          lastLoginAt: user.lastLoginAt,
        },
        version: VERSION,
      });
    } catch (err: any) {
      return res.status(500).json({
        error: "Auth me failed",
        code: "AUTH_ME_FAILED",
        detail: String(err?.message || err),
        version: VERSION,
      });
    }
  });

  /* -------------------- ME (ALIAS) -------------------- */
  app.get("/api/me", async (req, res) => {
    try {
      const a = await getAuth(req);

      if (!a.isAuthed) {
        return res.status(401).json({
          error: "Unauthorized",
          code: "UNAUTHORIZED",
          version: VERSION,
        });
      }

      const rows = await db
        .select({
          id: users.id,
          email: users.email,
          authProvider: users.authProvider,
          googleSub: users.googleSub,
          facebookId: users.facebookId,
          linkedinId: users.linkedinId,
          microsoftId: (users as any).microsoftId,
          createdAt: users.createdAt,
          lastLoginAt: users.lastLoginAt,
        })
        .from(users)
        .where(eq(users.id, a.userId))
        .limit(1);

      const user = rows?.[0];
      if (!user) {
        return res.status(401).json({
          error: "Unauthorized",
          code: "UNAUTHORIZED",
          version: VERSION,
        });
      }

      return res.json({
        ok: true,
        user: {
          id: String(user.id),
          email: String(user.email || ""),
          authProvider: deriveAuthProvider(user),
          createdAt: user.createdAt,
          lastLoginAt: user.lastLoginAt,
        },
        version: VERSION,
      });
    } catch (err: any) {
      return res.status(500).json({
        error: "Me failed",
        code: "ME_FAILED",
        detail: String(err?.message || err),
        version: VERSION,
      });
    }
  });

    /* -------------------- ME: GIFTS -------------------- */
  app.get("/api/me/gifts", async (req, res) => {
    try {
      const a = await getAuth(req);

      if (!a.isAuthed) {
        return res.status(401).json({
          error: "Unauthorized",
          code: "UNAUTHORIZED",
          version: VERSION,
        });
      }

      const rows = await db
        .select({
          publicId: gifts.publicId,
          senderEmail: gifts.senderEmail,
          recipientEmail: gifts.recipientEmail,
          recipientPhone: gifts.recipientPhone,
          deliveryMethod: gifts.deliveryMethod,
          messageMode: gifts.messageMode,
          presetMessageId: gifts.presetMessageId,
          message: gifts.message,
          amount: gifts.amount,
          paymentStatus: gifts.paymentStatus,
          createdAt: gifts.createdAt,
          deliveredAt: (gifts as any).deliveredAt,
          claimedAt: gifts.claimedAt,
        })
        .from(gifts)
        .where(eq(gifts.senderUserId, a.userId))
        .orderBy(desc(gifts.createdAt))
        .limit(50);

      return res.json({
        ok: true,
        gifts: rows,
        version: VERSION,
      });
    } catch (err: any) {
      return res.status(500).json({
        error: "Failed to load gifts",
        code: "ME_GIFTS_FAILED",
        detail: String(err?.message || err),
        version: VERSION,
      });
    }
  });

  /* -------------------- ME: GIFT DETAIL -------------------- */
  app.get("/api/me/gifts/:publicId", async (req, res) => {
    try {
      const a = await getAuth(req);

      if (!a.isAuthed) {
        return res.status(401).json({
          error: "Unauthorized",
          code: "UNAUTHORIZED",
          version: VERSION,
        });
      }

      const publicId = String(req.params.publicId || "").trim();

      if (!/^[a-f0-9]{32}$/i.test(publicId)) {
        return res.status(404).json({
          error: "Not found",
          code: "NOT_FOUND",
          version: VERSION,
        });
      }

      const rows = await db
        .select({
          publicId: gifts.publicId,
          senderUserId: gifts.senderUserId,
          senderEmail: gifts.senderEmail,
          recipientEmail: gifts.recipientEmail,
          recipientPhone: gifts.recipientPhone,
          deliveryMethod: gifts.deliveryMethod,
          messageMode: gifts.messageMode,
          presetMessageId: gifts.presetMessageId,
          message: gifts.message,
          amount: gifts.amount,
          paymentStatus: gifts.paymentStatus,
          stripeCheckoutSessionId: gifts.stripeCheckoutSessionId,
          stripePaymentIntentId: gifts.stripePaymentIntentId,
          paidAt: gifts.paidAt,
          deliveredAt: (gifts as any).deliveredAt,
          deliveredEmailAt: (gifts as any).deliveredEmailAt,
          deliveredSmsAt: (gifts as any).deliveredSmsAt,
          deliveryAttemptedAt: (gifts as any).deliveryAttemptedAt,
          deliveryError: (gifts as any).deliveryError,
          isClaimed: gifts.isClaimed,
          claimedAt: gifts.claimedAt,
          createdAt: gifts.createdAt,
          reminderCount: gifts.reminderCount,
          lastReminderSentAt: gifts.lastReminderSentAt,
          returnedToSenderAt: gifts.returnedToSenderAt,
        })
        .from(gifts)
        .where(and(eq(gifts.publicId, publicId), eq(gifts.senderUserId, a.userId)))
        .limit(1);

      const gift = rows?.[0];
      if (!gift) {
        return res.status(404).json({
          error: "Not found",
          code: "NOT_FOUND",
          version: VERSION,
        });
      }

      return res.json({
        ok: true,
        gift,
        version: VERSION,
      });
    } catch (err: any) {
      return res.status(500).json({
        error: "Failed to load gift",
        code: "ME_GIFT_GET_FAILED",
        detail: String(err?.message || err),
        version: VERSION,
      });
    }
  });

  /* -------------------- ME: STATS -------------------- */
  app.get("/api/me/stats", async (req, res) => {
    try {
      const a = await getAuth(req);

      if (!a.isAuthed) {
        return res.status(401).json({
          error: "Unauthorized",
          code: "UNAUTHORIZED",
          version: VERSION,
        });
      }

      const rows = await db
        .select({
          sentCount: sql<number>`count(*)`,
          claimedCount: sql<number>`coalesce(sum(case when ${gifts.isClaimed} = true or ${gifts.claimedAt} is not null then 1 else 0 end), 0)`,
          pendingCount: sql<number>`coalesce(sum(case when (${gifts.isClaimed} = false or ${gifts.isClaimed} is null) and ${gifts.claimedAt} is null then 1 else 0 end), 0)`,
          totalValueSent: sql<number>`coalesce(sum(${gifts.amount}), 0)`,
        })
        .from(gifts)
        .where(eq(gifts.senderUserId, a.userId));

      const stats = rows?.[0] || {
        sentCount: 0,
        claimedCount: 0,
        pendingCount: 0,
        totalValueSent: 0,
      };

      return res.json({
        ok: true,
        sentCount: Number(stats.sentCount || 0),
        claimedCount: Number(stats.claimedCount || 0),
        pendingCount: Number(stats.pendingCount || 0),
        totalValueSent: Number(stats.totalValueSent || 0),
        version: VERSION,
      });
    } catch (err: any) {
      return res.status(500).json({
        error: "Failed to load stats",
        code: "ME_STATS_FAILED",
        detail: String(err?.message || err),
        version: VERSION,
      });
    }
  });

  /* -------------------- ADMIN: REVOKE SESSIONS -------------------- */
  app.post("/api/admin/auth/sessions/revoke", limiterAdmin, async (req, res) => {
    try {
      if (!ADMIN_TOKEN) {
        return res.status(503).json({
          error: "ADMIN_TOKEN not configured",
          code: "ADMIN_NOT_CONFIGURED",
          version: VERSION,
        });
      }
      if (!isAdmin(req)) {
        return res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED", version: VERSION });
      }

      const parsed = zAdminRevokeSessions.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid request",
          code: "INVALID_REQUEST",
          issues: parsed.error.issues,
          version: VERSION,
        });
      }

      const userId = String(parsed.data.userId || "").trim();
      const sessionHash = String(parsed.data.sessionHash || "").trim();

      if (!userId && !sessionHash) {
        return res.status(400).json({
          error: "userId or sessionHash required",
          code: "MISSING_TARGET",
          version: VERSION,
        });
      }

      let updatedCount = 0;

      if (sessionHash) {
        const updated = await db
          .update(authSessions)
          .set({ revokedAt: now() })
          .where(and(eq(authSessions.sessionHash, sessionHash), isNull(authSessions.revokedAt)))
          .returning({ userId: authSessions.userId });

        updatedCount += updated?.length ? updated.length : 0;
      } else if (userId) {
        const updated = await db
          .update(authSessions)
          .set({ revokedAt: now() })
          .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)))
          .returning({ userId: authSessions.userId });

        updatedCount += updated?.length ? updated.length : 0;
      }

      return res.json({ ok: true, revokedCount: updatedCount, version: VERSION });
    } catch (err: any) {
      return res.status(500).json({
        error: "Admin revoke failed",
        code: "ADMIN_REVOKE_FAILED",
        detail: String(err?.message || err),
        version: VERSION,
      });
    }
  });

  /* -------------------- ADMIN: STRIPE SESSION FETCH -------------------- */
  app.get("/api/admin/stripe/session/:sessionId", limiterAdmin, async (req, res) => {
    try {
      if (!ADMIN_TOKEN) {
        return res.status(503).json({
          error: "ADMIN_TOKEN not configured",
          code: "ADMIN_NOT_CONFIGURED",
          version: VERSION,
        });
      }
      if (!isAdmin(req)) {
        return res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED", version: VERSION });
      }

      if (!STRIPE_SECRET_KEY) {
        return res.status(503).json({
          error: "Stripe not configured",
          code: "STRIPE_NOT_CONFIGURED",
          version: VERSION,
        });
      }

      const sessionId = String(req.params.sessionId || "").trim();
      if (!sessionId) {
        return res.status(400).json({ error: "Missing sessionId", code: "MISSING_SESSION_ID", version: VERSION });
      }
      if (!/^cs_(test|live)_[a-zA-Z0-9]+$/.test(sessionId)) {
        return res.status(400).json({ error: "Invalid sessionId", code: "INVALID_SESSION_ID", version: VERSION });
      }

      const url = new URL(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
      url.searchParams.set("expand[]", "payment_intent");
      url.searchParams.set("expand[]", "customer");

      const resp = await fetch(url.toString(), {
        method: "GET",
        headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
      });

      const json: any = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        return res.status(resp.status).json({
          error: "Stripe fetch failed",
          code: "STRIPE_FETCH_FAILED",
          stripe: json,
          version: VERSION,
        });
      }

      const metadata = json?.metadata || {};
      const publicId = String(metadata?.publicId || "").trim() || null;

      return res.json({
        ok: true,
        session: json,
        publicId,
        version: VERSION,
        commit: COMMIT,
      });
    } catch (err: any) {
      return res.status(500).json({
        error: "Admin session fetch failed",
        code: "ADMIN_SESSION_FETCH_FAILED",
        detail: String(err?.message || err),
        version: VERSION,
      });
    }
  });

  /* -------------------- ADMIN: STRIPE RECONCILE (PAID BUT NOT DELIVERED) -------------------- */
  app.post("/api/admin/stripe/reconcile", limiterAdmin, async (req, res) => {
    try {
      if (!ADMIN_TOKEN) {
        return res.status(503).json({
          error: "ADMIN_TOKEN not configured",
          code: "ADMIN_NOT_CONFIGURED",
          version: VERSION,
        });
      }
      if (!isAdmin(req)) {
        return res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED", version: VERSION });
      }

      const parsed = zAdminReconcile.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid request",
          code: "INVALID_REQUEST",
          issues: parsed.error.issues,
          version: VERSION,
        });
      }

      const publicId = String(parsed.data.publicId || "").trim();
      const limit = Math.max(1, Math.min(50, Number(parsed.data.limit ?? 25)));

      let targets: Array<{ publicId: string }> = [];

      if (publicId) {
        targets = [{ publicId }];
      } else {
        const rows = await db
          .select({ publicId: gifts.publicId })
          .from(gifts)
          .where(
            and(
              sql`${gifts.amount} is not null`,
              or(eq(gifts.paymentStatus, "paid"), sql`lower(${gifts.paymentStatus}) = 'paid'`),
              isNull((gifts as any).deliveredAt),
            ),
          )
          .orderBy(desc(gifts.paidAt), desc(gifts.id))
          .limit(limit);

        targets = rows.map((r) => ({ publicId: String(r.publicId || "").trim() })).filter((r) => r.publicId);
      }

      let attempted = 0;
      let delivered = 0;
      let skipped = 0;

      for (const t of targets) {
        attempted++;
        const r = await deliverGiftIfEligible(t.publicId, "admin_reconcile_paid");
        if (!r.ok) {
          skipped++;
        } else {
          if ((r as any).delivered) delivered++;
          else skipped++;
        }
      }

      return res.json({ ok: true, attempted, delivered, skipped, version: VERSION });
    } catch (err: any) {
      return res.status(500).json({
        error: "Reconcile failed",
        code: "RECONCILE_FAILED",
        detail: String(err?.message || err),
        version: VERSION,
      });
    }
  });

  /* -------------------- ADMIN: GIFTS LIST -------------------- */
  app.get("/api/admin/gifts", limiterAdmin, async (req, res) => {
    try {
      if (!ADMIN_TOKEN) {
        return res.status(503).json({
          error: "ADMIN_TOKEN not configured",
          code: "ADMIN_NOT_CONFIGURED",
          version: VERSION,
        });
      }
      if (!isAdmin(req)) {
        return res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED", version: VERSION });
      }

      const limit = Math.max(1, Math.min(50, Number(req.query.limit ?? 20)));

      const rows = await db
        .select({
          id: gifts.id,
          publicId: gifts.publicId,

          senderUserId: gifts.senderUserId,
          senderEmail: gifts.senderEmail,

          recipientEmail: gifts.recipientEmail,
          recipientPhone: gifts.recipientPhone,
          deliveryMethod: gifts.deliveryMethod,

          messageMode: gifts.messageMode,
          presetMessageId: gifts.presetMessageId,
          message: gifts.message,

          amount: gifts.amount,
          paymentStatus: gifts.paymentStatus,
          stripeCheckoutSessionId: gifts.stripeCheckoutSessionId,
          stripePaymentIntentId: gifts.stripePaymentIntentId,
          paidAt: gifts.paidAt,

          deliveredAt: (gifts as any).deliveredAt,
          deliveredEmailAt: (gifts as any).deliveredEmailAt,
          deliveredSmsAt: (gifts as any).deliveredSmsAt,
          deliveryAttemptedAt: (gifts as any).deliveryAttemptedAt,
          deliveryError: (gifts as any).deliveryError,

          isClaimed: gifts.isClaimed,
          claimedAt: gifts.claimedAt,
          createdAt: gifts.createdAt,

          reminderCount: gifts.reminderCount,
          lastReminderSentAt: gifts.lastReminderSentAt,
          returnedToSenderAt: gifts.returnedToSenderAt,
        })
        .from(gifts)
        .orderBy(desc(gifts.createdAt), desc(gifts.id))
        .limit(limit);

      return res.json({ ok: true, gifts: rows, limit, version: VERSION });
    } catch (err: any) {
      return res.status(500).json({
        error: "Admin gifts list failed",
        code: "ADMIN_GIFTS_FAILED",
        detail: String(err?.message || err),
        version: VERSION,
      });
    }
  });

  /* -------------------- ADMIN: GIFT GET -------------------- */
  app.get("/api/admin/gifts/:publicId", limiterAdmin, async (req, res) => {
    try {
      if (!ADMIN_TOKEN) {
        return res.status(503).json({
          error: "ADMIN_TOKEN not configured",
          code: "ADMIN_NOT_CONFIGURED",
          version: VERSION,
        });
      }
      if (!isAdmin(req)) {
        return res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED", version: VERSION });
      }

      const publicId = String(req.params.publicId || "").trim();

if (!/^[a-f0-9]{32}$/i.test(publicId)) {
  return res.status(404).json({
    error: "Not found",
    code: "NOT_FOUND",
    version: VERSION,
  });
}

      const rows = await db
        .select({
          id: gifts.id,
          publicId: gifts.publicId,
          senderUserId: gifts.senderUserId,
          senderEmail: gifts.senderEmail,
          recipientEmail: gifts.recipientEmail,
          recipientPhone: gifts.recipientPhone,
          deliveryMethod: gifts.deliveryMethod,
          messageMode: gifts.messageMode,
          presetMessageId: gifts.presetMessageId,
          message: gifts.message,
          amount: gifts.amount,
          paymentStatus: gifts.paymentStatus,
          stripeCheckoutSessionId: gifts.stripeCheckoutSessionId,
          stripePaymentIntentId: gifts.stripePaymentIntentId,
          paidAt: gifts.paidAt,
          deliveredAt: (gifts as any).deliveredAt,
          deliveredEmailAt: (gifts as any).deliveredEmailAt,
          deliveredSmsAt: (gifts as any).deliveredSmsAt,
          deliveryAttemptedAt: (gifts as any).deliveryAttemptedAt,
          deliveryError: (gifts as any).deliveryError,
          isClaimed: gifts.isClaimed,
          claimedAt: gifts.claimedAt,
          createdAt: gifts.createdAt,
          reminderCount: gifts.reminderCount,
          lastReminderSentAt: gifts.lastReminderSentAt,
          returnedToSenderAt: gifts.returnedToSenderAt,
        })
        .from(gifts)
        .where(
          and(
            eq(gifts.publicId, publicId),
            eq(gifts.stripeCheckoutSessionId, sessionId)
         )
       )
        .limit(1);

      const g = rows?.[0];
      if (!g) return res.status(404).json({ error: "Not found", code: "NOT_FOUND", version: VERSION });

      return res.json({ ok: true, gift: g, version: VERSION });
    } catch (err: any) {
      return res.status(500).json({
        error: "Admin gift get failed",
        code: "ADMIN_GIFT_GET_FAILED",
        detail: String(err?.message || err),
        version: VERSION,
      });
    }
  });

  /* -------------------- AUTH: GOOGLE OAUTH -------------------- */
  app.get("/api/auth/google", limiterGoogle, async (req, res) => {
    pruneOauthState();

    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  return oauthError(res, 503, "GOOGLE_NOT_CONFIGURED");
}

    const ip = getIp(req);
    const ua = String(req.headers["user-agent"] || "").slice(0, 200);

    const state = `g_${randomToken(16)}`;
    oauthStateStore.set(state, { exp: Date.now() + OAUTH_STATE_TTL_MS, ip, ua, provider: "google" });

    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set("client_id", GOOGLE_CLIENT_ID);
    url.searchParams.set("redirect_uri", GOOGLE_REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state);
    url.searchParams.set("access_type", "online");
    url.searchParams.set("prompt", "select_account");

    res.setHeader("Cache-Control", "no-store");
    return res.redirect(302, url.toString());
  });

  app.get("/api/auth/google/start", limiterGoogle, async (req, res) => {
    pruneOauthState();

    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return res
        .status(503)
        .json({ error: "Google auth not configured", code: "GOOGLE_NOT_CONFIGURED", version: VERSION });
    }

    const ip = getIp(req);
    const ua = String(req.headers["user-agent"] || "").slice(0, 200);

    const state = `g_${randomToken(16)}`;
    oauthStateStore.set(state, { exp: Date.now() + OAUTH_STATE_TTL_MS, ip, ua, provider: "google" });

    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set("client_id", GOOGLE_CLIENT_ID);
    url.searchParams.set("redirect_uri", GOOGLE_REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state);
    url.searchParams.set("access_type", "online");
    url.searchParams.set("prompt", "select_account");

    res.setHeader("Cache-Control", "no-store");
    return res.redirect(302, url.toString());
  });

  app.get("/api/auth/google/callback", limiterGoogle, async (req, res) => {
  pruneOauthState();

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res
      .status(503)
      .json({ error: "Google auth not configured", code: "GOOGLE_NOT_CONFIGURED", version: VERSION });
  }

  const code = String(req.query.code || "");
  const state = String(req.query.state || "");
  const err = String(req.query.error || "");

  if (err) {
  logAuthAbuse("oauth_google_failed", req, {
    code: "GOOGLE_OAUTH_ERROR",
  });

  return oauthError(res, 400, "GOOGLE_OAUTH_ERROR", { error: err });
}

  if (!code || !state) {
  logAuthAbuse("oauth_google_failed", req, {
    code: "GOOGLE_CALLBACK_INVALID",
  });

  return oauthError(res, 400, "GOOGLE_CALLBACK_INVALID");
}

  const saved = oauthStateStore.get(state);
  oauthStateStore.delete(state);

  if (!saved) {
  logAuthAbuse("oauth_google_failed", req, {
    code: "OAUTH_STATE_INVALID",
  });

  return oauthError(res, 400, "OAUTH_STATE_INVALID");
}

  const ip = getIp(req);
  const ua = String(req.headers["user-agent"] || "").slice(0, 200);

  if (saved.ip && saved.ip !== ip) {
  logAuthAbuse("oauth_google_failed", req, {
    code: "OAUTH_STATE_MISMATCH",
    check: "ip",
  });

  return oauthError(res, 400, "OAUTH_STATE_MISMATCH");
}

  if (saved.ua && saved.ua !== ua) {
  logAuthAbuse("oauth_google_failed", req, {
    code: "OAUTH_STATE_MISMATCH",
    check: "ua",
  });

  return oauthError(res, 400, "OAUTH_STATE_MISMATCH");
}

  const body = new URLSearchParams();
  body.set("code", code);
  body.set("client_id", GOOGLE_CLIENT_ID);
  body.set("client_secret", GOOGLE_CLIENT_SECRET);
  body.set("redirect_uri", GOOGLE_REDIRECT_URI);
  body.set("grant_type", "authorization_code");

  const tokenResp = await fetch(GOOGLE_TOKEN_URL, { method: "POST", body });
  const tokenJson: any = await tokenResp.json().catch(() => ({}));

  const accessToken = String(tokenJson?.access_token || "");

  if (!accessToken) {
  logAuthAbuse("oauth_google_failed", req, {
    code: "GOOGLE_TOKEN_EXCHANGE_FAILED",
  });

  return oauthError(res, 400, "GOOGLE_TOKEN_EXCHANGE_FAILED", tokenJson);
}

  const infoResp = await fetch(GOOGLE_USERINFO_URL, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const infoJson: any = await infoResp.json().catch(() => ({}));

  const rawEmail = infoJson?.email;
const emailVerified = infoJson?.email_verified;
const googleSub = String(infoJson?.sub || "").trim();

let email = "";
try {
  email = requireVerifiedOAuthEmail(rawEmail);
} catch {
  return oauthError(res, 400, "GOOGLE_NO_EMAIL");
}

if (emailVerified !== true) {
  return oauthError(res, 400, "EMAIL_NOT_VERIFIED");
}

  const issued = await issueSessionForEmail(email, req, {
    authProvider: "google",
    googleSub: googleSub || null,
  });

  if (!issued.ok) {
  return oauthError(res, 400, String(issued.code || "AUTH_SESSION_ISSUE_FAILED"), {
    reason: (issued as any).reason,
  });
}

  /* SET SECURE COOKIE */
  setAuthCookie(res, issued.sessionToken, issued.expiresAt);

  res.setHeader("Cache-Control", "no-store");

  /* redirect without exposing token */
  return res.redirect(302, `${FRONTEND_URL}/auth/google/success`);
});

  /* -------------------- AUTH: FACEBOOK OAUTH -------------------- */
  app.get("/api/auth/facebook", limiterFacebook, async (req, res) => {
    pruneOauthState();

    if (!FACEBOOK_APP_ID || !FACEBOOK_APP_SECRET) {
      return oauthError(res, 503, "FACEBOOK_NOT_CONFIGURED");
    }

    const ip = getIp(req);
    const ua = String(req.headers["user-agent"] || "").slice(0, 200);

    const state = `f_${randomToken(16)}`;
    oauthStateStore.set(state, { exp: Date.now() + OAUTH_STATE_TTL_MS, ip, ua, provider: "facebook" });

    const url = new URL(FACEBOOK_AUTH_URL);
    url.searchParams.set("client_id", FACEBOOK_APP_ID);
    url.searchParams.set("redirect_uri", FACEBOOK_REDIRECT_URI);
    url.searchParams.set("state", state);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "email");

    res.setHeader("Cache-Control", "no-store");
    return res.redirect(302, url.toString());
  });

  app.get("/api/auth/facebook/callback", limiterFacebook, async (req, res) => {
    pruneOauthState();

    if (!FACEBOOK_APP_ID || !FACEBOOK_APP_SECRET) {
      return res
        .status(503)
        .json({ error: "Facebook auth not configured", code: "FACEBOOK_NOT_CONFIGURED", version: VERSION });
    }

    const code = String(req.query.code || "").trim();
    const state = String(req.query.state || "").trim();

    const error = String(req.query.error || "").trim();
    const errorReason = String(req.query.error_reason || "").trim();
    const errorDescription = String(req.query.error_description || "").trim();

    if (error) {
  return oauthError(res, 400, "FACEBOOK_OAUTH_ERROR", {
    error,
    errorReason,
    errorDescription,
  });
}

    if (!code || !state) {
  return oauthError(res, 400, "FACEBOOK_CALLBACK_INVALID");
}

    const saved = oauthStateStore.get(state);
    oauthStateStore.delete(state);

    if (!saved || saved.exp <= Date.now() || saved.provider !== "facebook") {
  return oauthError(res, 400, "OAUTH_STATE_INVALID");
}

    const ip = getIp(req);
    const ua = String(req.headers["user-agent"] || "").slice(0, 200);
    if (saved.ip && saved.ip !== ip) {
  return oauthError(res, 400, "OAUTH_STATE_MISMATCH");
}
    if (saved.ua && saved.ua !== ua) {
  return oauthError(res, 400, "OAUTH_STATE_MISMATCH");
}

    const tokenUrl = new URL(FACEBOOK_TOKEN_URL);
    tokenUrl.searchParams.set("client_id", FACEBOOK_APP_ID);
    tokenUrl.searchParams.set("redirect_uri", FACEBOOK_REDIRECT_URI);
    tokenUrl.searchParams.set("client_secret", FACEBOOK_APP_SECRET);
    tokenUrl.searchParams.set("code", code);

    const tokenResp = await fetch(tokenUrl.toString(), { method: "GET" });
    const tokenJson: any = await tokenResp.json().catch(() => ({}));

    const accessToken = String(tokenJson?.access_token || "").trim();
    if (!accessToken) {
  return oauthError(res, 400, "FACEBOOK_TOKEN_EXCHANGE_FAILED", tokenJson);
}

    const meUrl = new URL(FACEBOOK_ME_URL);
    meUrl.searchParams.set("fields", "id,name,email");
    meUrl.searchParams.set("access_token", accessToken);

    const infoResp = await fetch(meUrl.toString(), { method: "GET" });
    const infoJson: any = await infoResp.json().catch(() => ({}));

    const rawEmail = infoJson?.email;
const facebookId = String(infoJson?.id || "").trim();

let email = "";
try {
  email = requireVerifiedOAuthEmail(rawEmail);
} catch {
  return oauthError(res, 400, "FACEBOOK_NO_EMAIL", {
    hasId: Boolean(infoJson?.id),
    hasName: Boolean(infoJson?.name),
  });
}

    const issued = await issueSessionForEmail(email, req, {
      authProvider: "facebook",
      facebookId: facebookId || null,
    });
    if (!issued.ok) {
  return oauthError(res, 400, String(issued.code || "AUTH_SESSION_ISSUE_FAILED"), {
    reason: (issued as any).reason,
  });
}

    logAuth("auth_facebook_success", { emailDomain: extractDomain(email) });

    res.setHeader("Cache-Control", "no-store");
    return res.redirect(302, buildFacebookConsumeUrl(issued.sessionToken, email));
  });

  /* -------------------- AUTH: LINKEDIN OIDC -------------------- */
  app.get("/api/auth/linkedin", limiterLinkedin, async (req, res) => {
    pruneOauthState();

    if (!LINKEDIN_CLIENT_ID || !LINKEDIN_CLIENT_SECRET) {
  return oauthError(res, 503, "LINKEDIN_NOT_CONFIGURED");
}

    const ip = getIp(req);
    const ua = String(req.headers["user-agent"] || "").slice(0, 200);

    const state = `li_${randomToken(16)}`;
    oauthStateStore.set(state, { exp: Date.now() + OAUTH_STATE_TTL_MS, ip, ua, provider: "linkedin" });

    const url = new URL(LINKEDIN_AUTH_URL);
    url.searchParams.set("client_id", LINKEDIN_CLIENT_ID);
    url.searchParams.set("redirect_uri", LINKEDIN_REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid profile email");
    url.searchParams.set("state", state);

    res.setHeader("Cache-Control", "no-store");
    return res.redirect(302, url.toString());
  });

  app.get("/api/auth/linkedin/start", limiterLinkedin, async (req, res) => {
    pruneOauthState();

    if (!LINKEDIN_CLIENT_ID || !LINKEDIN_CLIENT_SECRET) {
      return res
        .status(503)
        .json({ error: "LinkedIn auth not configured", code: "LINKEDIN_NOT_CONFIGURED", version: VERSION });
    }

    const ip = getIp(req);
    const ua = String(req.headers["user-agent"] || "").slice(0, 200);

    const state = `li_${randomToken(16)}`;
    oauthStateStore.set(state, { exp: Date.now() + OAUTH_STATE_TTL_MS, ip, ua, provider: "linkedin" });

    const url = new URL(LINKEDIN_AUTH_URL);
    url.searchParams.set("client_id", LINKEDIN_CLIENT_ID);
    url.searchParams.set("redirect_uri", LINKEDIN_REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid profile email");
    url.searchParams.set("state", state);

    res.setHeader("Cache-Control", "no-store");
    return res.redirect(302, url.toString());
  });

  app.get("/api/auth/linkedin/callback", limiterLinkedin, async (req, res) => {
    pruneOauthState();

    if (!LINKEDIN_CLIENT_ID || !LINKEDIN_CLIENT_SECRET) {
      return res
        .status(503)
        .json({ error: "LinkedIn auth not configured", code: "LINKEDIN_NOT_CONFIGURED", version: VERSION });
    }

    const code = String(req.query.code || "").trim();
    const state = String(req.query.state || "").trim();
    const error = String(req.query.error || "").trim();
    const errorDescription = String(req.query.error_description || "").trim();

    if (error) {
  return oauthError(res, 400, "LINKEDIN_OAUTH_ERROR", {
    error,
    errorDescription,
  });
}

    if (!code || !state) {
  return oauthError(res, 400, "LINKEDIN_CALLBACK_INVALID");
}

    const saved = oauthStateStore.get(state);
    oauthStateStore.delete(state);

    if (!saved || saved.exp <= Date.now() || saved.provider !== "linkedin") {
  return oauthError(res, 400, "OAUTH_STATE_INVALID");
}

    const ip = getIp(req);
    const ua = String(req.headers["user-agent"] || "").slice(0, 200);
    if (saved.ip && saved.ip !== ip) {
  return oauthError(res, 400, "OAUTH_STATE_MISMATCH");
}
    if (saved.ua && saved.ua !== ua) {
  return oauthError(res, 400, "OAUTH_STATE_MISMATCH");
}

    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("code", code);
    body.set("client_id", LINKEDIN_CLIENT_ID);
    body.set("client_secret", LINKEDIN_CLIENT_SECRET);
    body.set("redirect_uri", LINKEDIN_REDIRECT_URI);

    const tokenResp = await fetch(LINKEDIN_TOKEN_URL, { method: "POST", body });
    const tokenJson: any = await tokenResp.json().catch(() => ({}));

    const accessToken = String(tokenJson?.access_token || "").trim();
    if (!accessToken) {
  return oauthError(res, 400, "LINKEDIN_TOKEN_EXCHANGE_FAILED", tokenJson);
}

    const infoResp = await fetch(LINKEDIN_USERINFO_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const infoJson: any = await infoResp.json().catch(() => ({}));

    const rawEmail = infoJson?.email;
const emailVerified = infoJson?.email_verified;
const linkedinId = String(infoJson?.sub || "").trim();

let email = "";
try {
  email = requireVerifiedOAuthEmail(rawEmail);
} catch {
  return oauthError(res, 400, "LINKEDIN_NO_EMAIL", {
    hasSub: Boolean(infoJson?.sub),
    hasName: Boolean(infoJson?.name),
  });
}

if (emailVerified !== true) {
  return oauthError(res, 400, "EMAIL_NOT_VERIFIED");
}

    const issued = await issueSessionForEmail(email, req, {
      authProvider: "linkedin",
      linkedinId: linkedinId || null,
    });
    if (!issued.ok) {
  return oauthError(res, 400, String(issued.code || "AUTH_SESSION_ISSUE_FAILED"), {
    reason: (issued as any).reason,
  });
}

    logAuth("auth_linkedin_success", { emailDomain: extractDomain(email) });

    res.setHeader("Cache-Control", "no-store");
    return res.redirect(302, buildLinkedinConsumeUrl(issued.sessionToken, email));
  });
    /* -------------------- AUTH: MICROSOFT OIDC -------------------- */
  app.get("/api/auth/microsoft", limiterMicrosoft, async (req, res) => {
    pruneOauthState();

        if (!MICROSOFT_CLIENT_ID || !MICROSOFT_CLIENT_SECRET || !MICROSOFT_TENANT_ID) {
  return oauthError(res, 503, "MICROSOFT_NOT_CONFIGURED");
}

    const microsoftTenantRestricted =
      MICROSOFT_ALLOWED_TENANT_IDS.size > 0 ||
      !["common", "organizations", "consumers"].includes(String(MICROSOFT_TENANT_ID || "").trim().toLowerCase());

    if (!microsoftTenantRestricted) {
      return res.status(503).json({
        error: "Microsoft tenant restriction not configured",
        code: "MICROSOFT_TENANT_RESTRICTION_REQUIRED",
        version: VERSION,
      });
    }

    const ip = getIp(req);
    const ua = String(req.headers["user-agent"] || "").slice(0, 200);

    const state = `ms_${randomToken(16)}`;
    const codeVerifier = randomBase64Url(48);
    const nonce = randomBase64Url(24);

    oauthStateStore.set(state, {
      exp: Date.now() + OAUTH_STATE_TTL_MS,
      ip,
      ua,
      provider: "microsoft",
      codeVerifier,
      nonce,
    });

    const url = new URL(MICROSOFT_AUTH_URL);
    url.searchParams.set("client_id", MICROSOFT_CLIENT_ID);
    url.searchParams.set("redirect_uri", MICROSOFT_REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("scope", "openid profile email User.Read");
    url.searchParams.set("state", state);
    url.searchParams.set("prompt", "select_account");
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("code_challenge", sha256Base64Url(codeVerifier));
    url.searchParams.set("code_challenge_method", "S256");

    res.setHeader("Cache-Control", "no-store");
    return res.redirect(302, url.toString());
  });

  app.get("/api/auth/microsoft/start", limiterMicrosoft, async (req, res) => {
    pruneOauthState();

        if (!MICROSOFT_CLIENT_ID || !MICROSOFT_CLIENT_SECRET || !MICROSOFT_TENANT_ID) {
      return oauthError(res, 503, "MICROSOFT_NOT_CONFIGURED");
    }

    const normalizedMicrosoftTenantId = String(MICROSOFT_TENANT_ID || "").trim().toLowerCase();
    const microsoftTenantRestricted =
      MICROSOFT_ALLOWED_TENANT_IDS.size > 0 ||
      !["common", "organizations", "consumers"].includes(normalizedMicrosoftTenantId);

    if (!microsoftTenantRestricted) {
      return res.status(503).json({
        error: "Microsoft tenant restriction not configured",
        code: "MICROSOFT_TENANT_RESTRICTION_REQUIRED",
        version: VERSION,
      });
    }

    const ip = getIp(req);
    const ua = String(req.headers["user-agent"] || "").slice(0, 200);

    const state = `ms_${randomToken(16)}`;
    const codeVerifier = randomBase64Url(48);
    const nonce = randomBase64Url(24);

    oauthStateStore.set(state, {
      exp: Date.now() + OAUTH_STATE_TTL_MS,
      ip,
      ua,
      provider: "microsoft",
      codeVerifier,
      nonce,
    });

    const url = new URL(MICROSOFT_AUTH_URL);
    url.searchParams.set("client_id", MICROSOFT_CLIENT_ID);
    url.searchParams.set("redirect_uri", MICROSOFT_REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("scope", "openid profile email User.Read");
    url.searchParams.set("state", state);
    url.searchParams.set("prompt", "select_account");
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("code_challenge", sha256Base64Url(codeVerifier));
    url.searchParams.set("code_challenge_method", "S256");

    res.setHeader("Cache-Control", "no-store");
    return res.redirect(302, url.toString());
  });

  app.get("/api/auth/microsoft/callback", limiterMicrosoft, async (req, res) => {
    pruneOauthState();

    if (!MICROSOFT_CLIENT_ID || !MICROSOFT_CLIENT_SECRET || !MICROSOFT_TENANT_ID) {
      return res
        .status(503)
        .json({ error: "Microsoft auth not configured", code: "MICROSOFT_NOT_CONFIGURED", version: VERSION });
    }

    const code = String(req.query.code || "").trim();
    const state = String(req.query.state || "").trim();
    const error = String(req.query.error || "").trim();
    const errorDescription = String(req.query.error_description || "").trim();

    if (error) {
  return oauthError(res, 400, "MICROSOFT_OAUTH_ERROR", { error, errorDescription });
}

    if (!code || !state) {
  return oauthError(res, 400, "MICROSOFT_CALLBACK_INVALID");
}

    const saved = oauthStateStore.get(state);
    oauthStateStore.delete(state);

    if (!saved || saved.exp <= Date.now() || saved.provider !== "microsoft") {
  return oauthError(res, 400, "OAUTH_STATE_INVALID");
}

    const ip = getIp(req);
    const ua = String(req.headers["user-agent"] || "").slice(0, 200);
    if (saved.ip && saved.ip !== ip) {
  return oauthError(res, 400, "OAUTH_STATE_MISMATCH");
}
    if (saved.ua && saved.ua !== ua) {
  return oauthError(res, 400, "OAUTH_STATE_MISMATCH");
}
    if (!saved.codeVerifier || !saved.nonce) {
  return oauthError(res, 400, "OAUTH_STATE_INVALID");
}

    const body = new URLSearchParams();
    body.set("client_id", MICROSOFT_CLIENT_ID);
    body.set("client_secret", MICROSOFT_CLIENT_SECRET);
    body.set("code", code);
    body.set("redirect_uri", MICROSOFT_REDIRECT_URI);
    body.set("grant_type", "authorization_code");
    body.set("scope", "openid profile email User.Read");
    body.set("code_verifier", saved.codeVerifier);

    const tokenResp = await fetch(MICROSOFT_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const tokenJson: any = await tokenResp.json().catch(() => ({}));

    const accessToken = String(tokenJson?.access_token || "").trim();
    const idToken = String(tokenJson?.id_token || "").trim();
    const tokenType = String(tokenJson?.token_type || "").trim().toLowerCase();

    if (!accessToken) {
  return oauthError(res, 400, "MICROSOFT_TOKEN_EXCHANGE_FAILED", tokenJson);
}

    if (tokenType && tokenType !== "bearer") {
  return oauthError(res, 400, "MICROSOFT_TOKEN_TYPE_INVALID");
}

    const idTokenClaims = idToken ? parseJwtPayload(idToken) : null;
    if (idToken && !idTokenClaims) {
  return oauthError(res, 400, "MICROSOFT_ID_TOKEN_INVALID");
}

    if (idTokenClaims) {
      const aud = String(idTokenClaims.aud || "").trim();
      const iss = String(idTokenClaims.iss || "").trim();
      const nonce = String(idTokenClaims.nonce || "").trim();
      const tid = String(idTokenClaims.tid || "").trim();
      const exp = Number(idTokenClaims.exp || 0);

      if (aud && aud !== MICROSOFT_CLIENT_ID) {
  return oauthError(res, 400, "MICROSOFT_ID_TOKEN_AUD_INVALID");
}

            if (iss && !iss.startsWith(MICROSOFT_EXPECTED_ISSUER_PREFIX)) {
  return oauthError(res, 400, "MICROSOFT_ID_TOKEN_ISS_INVALID");
}

      if (tid && iss) {
        const expectedIss = `https://login.microsoftonline.com/${tid}/v2.0`;
        if (iss !== expectedIss) {
  return oauthError(res, 400, "MICROSOFT_ID_TOKEN_ISS_TENANT_MISMATCH");
}
      }

      if (nonce !== saved.nonce) {
  return oauthError(res, 400, "MICROSOFT_NONCE_INVALID");
}

      if (exp && Date.now() >= exp * 1000) {
  return oauthError(res, 400, "MICROSOFT_ID_TOKEN_EXPIRED");
}

            if (!tid) {
  return oauthError(res, 400, "MICROSOFT_TENANT_MISSING");
}

      if (!isMicrosoftTenantAllowed(tid)) {
  return oauthError(res, 400, "MICROSOFT_TENANT_NOT_ALLOWED");
}
    }

    const infoResp = await fetch(MICROSOFT_USERINFO_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const infoJson: any = await infoResp.json().catch(() => ({}));

    let email = "";
try {
  email = requireVerifiedOAuthEmail(
    infoJson?.email ||
      infoJson?.preferred_username ||
      infoJson?.upn ||
      idTokenClaims?.email ||
      idTokenClaims?.preferred_username ||
      idTokenClaims?.upn ||
      "",
  );
} catch {
  email = "";
}

    let microsoftId = String(
      infoJson?.sub || infoJson?.oid || idTokenClaims?.oid || idTokenClaims?.sub || "",
    ).trim();

    const emailVerified = infoJson?.email_verified;
    const tenantIdFromClaims = String(infoJson?.tid || idTokenClaims?.tid || "").trim();

    if (tenantIdFromClaims && !isMicrosoftTenantAllowed(tenantIdFromClaims)) {
  return oauthError(res, 400, "MICROSOFT_TENANT_NOT_ALLOWED");
}

        let graphMeJson: any = null;
    if (!email || !microsoftId) {
      const graphMeResp = await fetch(MICROSOFT_GRAPH_ME_URL, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      graphMeJson = await graphMeResp.json().catch(() => ({}));

      const graphTenantId = String(graphMeJson?.tenantId || graphMeJson?.tid || "").trim();
      if (graphTenantId && !isMicrosoftTenantAllowed(graphTenantId)) {
  return oauthError(res, 400, "MICROSOFT_TENANT_NOT_ALLOWED");
}

      if (!email) {
        email = normalizeEmail(String(graphMeJson?.mail || graphMeJson?.userPrincipalName || ""));
      }

      if (!microsoftId) {
        microsoftId = String(graphMeJson?.id || "").trim();
      }
    }

    if (!email) {
  return oauthError(res, 400, "MICROSOFT_NO_EMAIL", {
    hasSub: Boolean(infoJson?.sub || idTokenClaims?.sub),
    hasPreferredUsername: Boolean(
      infoJson?.preferred_username || idTokenClaims?.preferred_username,
    ),
    hasGraphMail: Boolean(graphMeJson?.mail),
    hasGraphUserPrincipalName: Boolean(graphMeJson?.userPrincipalName),
  });
}

    if (emailVerified === false) {
  return oauthError(res, 400, "EMAIL_NOT_VERIFIED");
}

    const issued = await issueSessionForEmail(email, req, {
      authProvider: "microsoft",
      microsoftId: microsoftId || null,
    });
    if (!issued.ok) {
  return oauthError(res, 400, String(issued.code || "AUTH_SESSION_ISSUE_FAILED"), {
    reason: (issued as any).reason,
  });
}

    logAuth("auth_microsoft_success", {
      emailDomain: extractDomain(email),
      tenantRestricted:
        MICROSOFT_ALLOWED_TENANT_IDS.size > 0 ||
        !["common", "organizations", "consumers"].includes(MICROSOFT_TENANT_ID),
    });

    res.setHeader("Cache-Control", "no-store");
    return res.redirect(302, buildMicrosoftConsumeUrl(issued.sessionToken, email));
  });

  /* -------------------- AUTH: MAGIC LINK (DISABLED BY DEFAULT) -------------------- */
    app.post("/api/auth/request", limiterAuthRequest, async (req, res) => {
    if (!AUTH_MAGIC_LINK_ENABLED) {
      return res.status(403).json({
        error: "Not available",
        code: "AUTH_REQUEST_UNAVAILABLE",
        version: VERSION,
      });
    }

    const startedAt = Date.now();

    const finishUniformAuthRequestResponse = async () => {
      await sleep(Math.max(0, AUTH_REQUEST_MIN_RESPONSE_MS - (Date.now() - startedAt)));

      return res.json({
        ok: true,
        sent: true,
        version: VERSION,
      });
    };

    try {
      const ip = getIp(req);
      const parsed = zAuthRequest.safeParse(req.body || {});
      if (!parsed.success) {
        return finishUniformAuthRequestResponse();
      }

      const canonicalEmail = canonicalizeEmailParts(parsed.data.email);
      const email = canonicalEmail.email;
      const domain = canonicalEmail.domain;
      const turnstileToken = String(parsed.data.turnstileToken || "").trim();

      const emailHash = canonicalEmail.emailHash;
      const domainHash = canonicalEmail.domainHash;

      const throttle = await getAuthEmailThrottle(emailHash);
      const domainThrottle = await getAuthDomainThrottle(domainHash);

      if (throttle) {
        const windowAge = Date.now() - new Date(throttle.windowStart).getTime();
        const count = Number(throttle.count || 0);

        if (windowAge < AUTH_DB_WINDOW_MS && count === AUTH_DB_MAX - 1) {
          logAuthAbuse("auth_request_email_throttle_near_limit", req, {
            emailHash,
            emailDomain: domain,
            countInWindow: count,
            windowMs: AUTH_DB_WINDOW_MS,
          });
        }

        if (windowAge < AUTH_DB_WINDOW_MS && count >= AUTH_DB_MAX) {
          logAuthAbuse("auth_request_rate_limited", req, {
            code: "AUTH_REQUEST_RATE_LIMITED",
            emailHash,
            emailDomain: domain,
            count,
          });

          return res.status(429).json({
            error: "Too many requests",
            code: "AUTH_REQUEST_RATE_LIMITED",
            retryAfterSec: Math.ceil(AUTH_DB_WINDOW_MS / 1000),
            version: VERSION,
          });
        }
      }

      if (domainThrottle) {
        const domainWindowAge = Date.now() - new Date(domainThrottle.windowStart).getTime();
        const domainCount = Number(domainThrottle.count || 0);

        if (domainWindowAge < AUTH_DB_WINDOW_MS && domainCount >= 10) {
          logAuthAbuse("auth_request_domain_rate_limited", req, {
            code: "AUTH_REQUEST_DOMAIN_RATE_LIMITED",
            emailHash,
            domainHash,
            emailDomain: domain,
            count: domainCount,
          });

          return res.status(429).json({
            error: "Too many requests",
            code: "AUTH_REQUEST_DOMAIN_RATE_LIMITED",
            retryAfterSec: Math.ceil(AUTH_DB_WINDOW_MS / 1000),
            version: VERSION,
          });
        }
      }

      if (!domain) {
        return finishUniformAuthRequestResponse();
      }

      if (shouldRequireTurnstile() && !turnstileToken) {
        logAuthAbuse("auth_request_turnstile_failed", req, {
          code: "VERIFICATION_FAILED",
          turnstile: true,
          emailHash,
          emailDomain: domain,
          reason: "missing_token",
        });

        return finishUniformAuthRequestResponse();
      }

      const v = await verifyTurnstile(turnstileToken, ip);
      if (!v.ok) {
        logAuthAbuse("auth_request_turnstile_failed", req, {
          code: "VERIFICATION_FAILED",
          turnstile: true,
          emailHash,
          emailDomain: domain,
        });

        return finishUniformAuthRequestResponse();
      }

      if (isDisposableEmail(email)) {
        logAuthAbuse("auth_request_disposable_blocked", req, {
          code: "EMAIL_NOT_ALLOWED",
          emailHash,
          emailDomain: domain,
          disposable: true,
        });

        return finishUniformAuthRequestResponse();
      }

      const mx = await mxLooksValid(domain);
      if (!mx.ok) {
        logAuthAbuse("auth_request_mx_failed", req, {
          code: "INVALID_REQUEST",
          emailHash,
          emailDomain: domain,
          mxReason: mx.reason,
        });

        return finishUniformAuthRequestResponse();
      }

      const rawToken = randomToken(24);
      const tokenHash = sha256Hex(rawToken);
      const expiresAt = new Date(Date.now() + AUTH_MAGIC_LINK_TTL_MS);
      const ua = String(req.headers["user-agent"] || "").slice(0, 500);

      try {
        await db.insert(authMagicLinks).values({
          email,
          tokenHash,
          expiresAt,
          consumedAt: null,
          ip,
          userAgent: ua || null,
          createdAt: now(),
        });

        logAuthAbuse("auth_request_magiclink_persisted", req, {
          emailHash,
          emailDomain: domain,
          expiresAt: expiresAt.toISOString(),
        });
      } catch (e: any) {
        logAuthAbuse("auth_request_magiclink_persist_failed", req, {
          code: "AUTH_REQUEST_PERSIST_FAILED",
          emailHash,
          emailDomain: domain,
          error: String(e?.message || e),
        });

        return finishUniformAuthRequestResponse();
      }

      logAuthAbuse("auth_request_accepted", req, {
        emailHash,
        emailDomain: domain,
        count: throttle ? Number(throttle.count || 0) + 1 : 1,
      });

      const loginUrl = buildAuthConsumeUrl(rawToken);

      try {
        logAuth("auth_magiclink_email_send_start", { toDomain: domain });

        await bumpAuthEmailThrottle(emailHash);
        await bumpAuthDomainThrottle(domainHash);

        const r = await sendAuthMagicLinkEmail({ to: email, loginUrl });
        logAuth("auth_magiclink_email_send_result", {
          toDomain: domain,
          ok: Boolean(r.ok),
          error: r.ok ? undefined : String(r.error || "unknown"),
        });
      } catch (e: any) {
        logAuth("auth_magiclink_email_send_crash", {
          toDomain: domain,
          error: String(e?.message || e),
        });
      }

      if (AUTH_RETURN_TOKEN) {
        await sleep(Math.max(0, AUTH_REQUEST_MIN_RESPONSE_MS - (Date.now() - startedAt)));

        return res.json({
          ok: true,
          token: rawToken,
          loginUrl,
          expiresAt: expiresAt.toISOString(),
          version: VERSION,
        });
      }

      return finishUniformAuthRequestResponse();
    } catch (e: any) {
      logAuthAbuse("auth_request_failed_catch", req, {
        code: "AUTH_REQUEST_FAILED",
        error: String(e?.message || e),
      });

      return finishUniformAuthRequestResponse();
    }
  });

  /* -------------------- GIFTS: CREATE -------------------- */
  app.post("/api/gifts", limiterCreateGift, async (req, res) => {
    try {
      const ip = getIp(req);

      if (DAILY_LIMIT_IP > 0) {
        const current = getMemIp(ip);
        if (current >= DAILY_LIMIT_IP) {
          return res.status(429).json({
            error: "Daily limit reached",
            code: "DAILY_LIMIT_IP",
            retryAfterSec: 60 * 60,
            version: VERSION,
          });
        }
      }

      const parsed = zCreateGift.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid request",
          code: "INVALID_REQUEST",
          issues: parsed.error.issues,
          version: VERSION,
        });
      }

      const a = await getAuth(req);
      const isRegistered = a.isAuthed;

      const {
        recipientEmail,
        recipientPhone,
        senderEmail,
        messageMode,
        presetMessageId,
        message,
        amountDollars,
        amountCents,
        amount,
        turnstileToken,
      } = parsed.data;

      const v = await verifyTurnstile(String(turnstileToken || ""), ip);
      if (!v.ok) {
        return res.status(400).json({
          error: "Missing or invalid CAPTCHA token",
          field: "turnstileToken",
          code: "TURNSTILE_FAILED",
          codes: v.codes,
          version: VERSION,
        });
      }

      let normSenderEmail = "";

      if (isRegistered) {
        const u = await db
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, a.userId))
          .limit(1);

        normSenderEmail = canonicalizeEmailParts(u?.[0]?.email || "").email;

        if (!normSenderEmail) {
          return res.status(401).json({
            error: "Unauthorized",
            code: "UNAUTHORIZED",
            version: VERSION,
          });
        }
      } else {
        const senderCanonical = canonicalizeEmailParts(senderEmail || "");
        const normSenderEmail = senderCanonical.email;
        if (!normSenderEmail) {
          return res.status(400).json({
            error: "Sender email is required",
            field: "senderEmail",
            code: "SENDER_EMAIL_REQUIRED",
            version: VERSION,
          });
        }
        if (isDisposableEmail(normSenderEmail)) {
          return res.status(400).json({
            error: "Sender email provider not supported",
            field: "senderEmail",
            code: "DISPOSABLE_EMAIL_BLOCKED",
            version: VERSION,
          });
        }
      }

      if (DAILY_LIMIT_SENDER > 0 && normSenderEmail) {
        const c = await countDailyBySenderEmail(normSenderEmail);
        if (c >= DAILY_LIMIT_SENDER) {
          return res.status(429).json({
            error: "Daily limit reached",
            code: "DAILY_LIMIT_SENDER",
            retryAfterSec: 60 * 60,
            version: VERSION,
          });
        }
      }

      const recipientCanonical = canonicalizeEmailParts(recipientEmail || "");
const toEmail = recipientCanonical.email;
const toEmailDomain = recipientCanonical.domain;
const toEmailHash = recipientCanonical.emailHash;
const toDomainHash = recipientCanonical.domainHash;
      const toPhone = String(recipientPhone || "").trim();

      if (!isRegistered) {
        if (!toEmail) {
          return res.status(400).json({
            error: "Recipient email is required",
            field: "recipientEmail",
            code: "RECIPIENT_EMAIL_REQUIRED",
            version: VERSION,
          });
        }
        if (toPhone) {
          return res.status(400).json({
            error: "Guests cannot send SMS",
            field: "recipientPhone",
            code: "GUEST_SMS_NOT_ALLOWED",
            version: VERSION,
          });
        }
      } else {
        const hasEmail = Boolean(toEmail);
        const hasPhone = Boolean(toPhone);
        if (!hasEmail && !hasPhone) {
          return res.status(400).json({
            error: "Recipient email or phone is required",
            code: "RECIPIENT_REQUIRED",
            version: VERSION,
          });
        }
        if (hasPhone && !isE164(toPhone)) {
          return res.status(400).json({
            error: "Invalid phone number (use E.164, e.g. +16045551234)",
            field: "recipientPhone",
            code: "PHONE_INVALID",
            version: VERSION,
          });
        }
      }

      if (toEmail && isDisposableEmail(toEmail)) {
        return res.status(400).json({
          error: "Recipient email provider not supported",
          field: "recipientEmail",
          code: "DISPOSABLE_EMAIL_BLOCKED",
          version: VERSION,
        });
      }

      if (isRegistered && toPhone && DAILY_LIMIT_PHONE > 0) {
        const current = getMemPhone(toPhone);
        if (current >= DAILY_LIMIT_PHONE) {
          return res.status(429).json({
            error: "Daily limit reached",
            code: "DAILY_LIMIT_PHONE",
            retryAfterSec: 60 * 60,
            version: VERSION,
          });
        }
      }

      let finalAmountCents: number | null = null;

      if (amountCents != null) finalAmountCents = Number(amountCents);
      else if (amountDollars != null) finalAmountCents = moneyToCents(Number(amountDollars));

      if (finalAmountCents == null && amount != null) {
        finalAmountCents = normalizeFixedAmountToCents(amount);
      }

      let finalMessageMode: "preset" | "custom" = (messageMode as any) || "preset";
      let finalPresetMessageId: number | null = presetMessageId == null ? null : Number(presetMessageId);
      let finalMessage: string = message ? String(message).trim() : "";

      if (!isRegistered) {
        finalMessageMode = "preset";
        finalMessage = "";

        if (!isValidPresetId(finalPresetMessageId)) {
          return res.status(400).json({
            error: `Preset message is required (must be ${PRESET_MIN_ID}–${PRESET_MAX_ID})`,
            field: "presetMessageId",
            code: "GUEST_PRESET_REQUIRED",
            version: VERSION,
          });
        }

        if (finalAmountCents != null && finalAmountCents !== 0) {
          return res.status(400).json({
            error: "Guests cannot include an amount",
            field: "amount",
            code: "GUEST_AMOUNT_NOT_ALLOWED",
            version: VERSION,
          });
        }

        finalAmountCents = null;
      } else {
        if (finalMessageMode === "custom") {
          const m = String(finalMessage || "").trim();
          if (!m) {
            return res.status(400).json({
              error: "Message is required for custom mode",
              field: "message",
              code: "CUSTOM_MESSAGE_REQUIRED",
              version: VERSION,
            });
          }
          if (m.length > 280) {
            return res.status(400).json({
              error: "Message too long (max 280)",
              field: "message",
              code: "MESSAGE_TOO_LONG",
              version: VERSION,
            });
          }
          finalMessage = m;
          finalPresetMessageId = null;
        } else {
          finalMessageMode = "preset";
          finalMessage = "";

          if (!isValidPresetId(finalPresetMessageId)) {
            return res.status(400).json({
              error: `Preset message is required (must be ${PRESET_MIN_ID}–${PRESET_MAX_ID})`,
              field: "presetMessageId",
              code: "PRESET_REQUIRED",
              version: VERSION,
            });
          }
        }

        if (finalAmountCents != null) {
          if (finalAmountCents < MIN_AMOUNT_CENTS_REGISTERED) {
            return res.status(400).json({
              error: "Minimum amount is $25",
              field: "amount",
              code: "MIN_AMOUNT",
              version: VERSION,
            });
          }
          if (!ALLOWED_AMOUNTS_CENTS.has(finalAmountCents)) {
            return res.status(400).json({
              error: `Amount must be one of: ${ALLOWED_AMOUNTS_DOLLARS.join(", ")}`,
              field: "amount",
              code: "AMOUNT_NOT_ALLOWED",
              version: VERSION,
            });
          }
        }
      }

      if (DAILY_LIMIT_IP > 0) bumpMemIp(ip);
      if (isRegistered && toPhone && DAILY_LIMIT_PHONE > 0) bumpMemPhone(toPhone);

      const publicId = crypto.randomBytes(16).toString("hex");
      const claimUrl = buildClaimUrl(publicId);

      const deliveryMethod = isRegistered ? (toPhone ? (toEmail ? "email+sms" : "sms") : "email") : "email";

const senderCanonical = canonicalizeEmailParts(normSenderEmail);

await db.insert(gifts).values({
  publicId,
  senderUserId: isRegistered ? a.userId : null,
  senderEmail: normSenderEmail || null,
  senderEmailHash: senderCanonical.emailHash || null,
  recipientEmail: toEmail || null,
  recipientPhone: isRegistered ? (toPhone || null) : null,
  deliveryMethod,

        messageMode: finalMessageMode,
        presetMessageId: finalPresetMessageId,
        message: finalMessage,

        amount: finalAmountCents,

        paymentStatus: finalAmountCents != null ? "requires_payment" : null,
        stripeCheckoutSessionId: null,
        stripePaymentIntentId: null,
        paidAt: null,

        deliveredAt: null as any,
        deliveredEmailAt: null as any,
        deliveredSmsAt: null as any,
        deliveryAttemptedAt: null as any,
        deliveryError: null as any,

        isClaimed: false,
        createdAt: now(),
        claimedAt: null,

        reminderCount: 0,
        lastReminderSentAt: null,
        returnedToSenderAt: null,
      } as any);

      const requiresPayment = finalAmountCents != null;

      let emailSent = false;
      let smsQueued = false;
      let deliveryError: string | null = null;

      if (!requiresPayment) {
        const r = await deliverGiftIfEligible(publicId, "create_no_payment");
        if (r.ok) {
          emailSent = Boolean(toEmail);
          smsQueued = Boolean(isRegistered && toPhone);
          deliveryError = (r as any).deliveryError ? String((r as any).deliveryError) : null;
        } else {
          deliveryError = "Delivery failed to start";
        }
      }

      return res.json({
        ok: true,
        publicId,
        claimUrl,
        deliveryOk: requiresPayment ? true : Boolean(!deliveryError),
        emailSent: requiresPayment ? false : emailSent,
        smsQueued: requiresPayment ? false : smsQueued,
        deliveryError: deliveryError || undefined,
        version: VERSION,
        paymentRequired: requiresPayment,
        paymentStatus: requiresPayment ? "requires_payment" : null,
      });
    } catch (err: any) {
      return res.status(500).json({
        error: "Create gift failed",
        code: "CREATE_GIFT_FAILED",
        detail: String(err?.message || err),
        version: VERSION,
      });
    }
  });

  /* -------------------- GIFTS: GET (CLAIM-SAFE) -------------------- */
  app.get("/api/gifts/:publicId", async (req, res) => {
    try {
      const publicId = String(req.params.publicId || "").trim();
      if (!publicId) {
        return res.status(400).json({ error: "Missing id", code: "MISSING_ID", version: VERSION });
      }

      const row = await db
        .select({
          publicId: gifts.publicId,
          deliveryMethod: gifts.deliveryMethod,
          messageMode: gifts.messageMode,
          presetMessageId: gifts.presetMessageId,
          message: gifts.message,
          amount: gifts.amount,
          paymentStatus: gifts.paymentStatus,
          createdAt: gifts.createdAt,
          claimedAt: gifts.claimedAt,
          isClaimed: gifts.isClaimed,
        })
        .from(gifts)
        .where(eq(gifts.publicId, publicId))
        .limit(1);

      const g = row?.[0];
      if (!g) {
        return res.status(404).json({ error: "Not found", code: "NOT_FOUND", version: VERSION });
      }

      const mode = (g.messageMode as any) || "preset";

      return res.json({
        ok: true,
        gift: {
          publicId: g.publicId,
          deliveryMethod: (g.deliveryMethod as any) || null,
          messageMode: mode,
          presetMessageId: g.presetMessageId ?? null,
          message: mode === "custom" ? String(g.message || "") : "",
          amount: g.amount ?? null,
          paymentStatus: g.paymentStatus ?? null,
          createdAt: g.createdAt,
          claimed: Boolean(g.isClaimed || g.claimedAt),
        },
        version: VERSION,
      });
    } catch (err: any) {
      return res.status(500).json({
        error: "Get gift failed",
        code: "GET_GIFT_FAILED",
        detail: String(err?.message || err),
        version: VERSION,
      });
    }
  });

/* -------------------- CLAIM -------------------- */
  app.post("/api/gifts/:publicId/claim", limiterClaim, async (req, res) => {
    const claimStartedAt = Date.now();
    const CLAIM_TIMING_FLOOR_MS = 350;

    async function applyClaimTimingFloor() {
      await sleep(Math.max(0, CLAIM_TIMING_FLOOR_MS - (Date.now() - claimStartedAt)));
    }

    try {
      const publicId = String(req.params.publicId || "").trim();

      if (!/^[a-f0-9]{32}$/i.test(publicId)) {
        await applyClaimTimingFloor();
        return res.status(404).json({
          error: "Not found",
          code: "NOT_FOUND",
          version: VERSION,
        });
      }

      const preRow = await db
        .select({
          id: gifts.id,
          amount: gifts.amount,
          paymentStatus: gifts.paymentStatus,
          createdAt: gifts.createdAt,
          claimedAt: gifts.claimedAt,
          isClaimed: gifts.isClaimed,
        })
        .from(gifts)
        .where(eq(gifts.publicId, publicId))
        .limit(1);

      const preGift = preRow?.[0];
      const preAmountCents = Number(preGift?.amount || 0);
      const createdAtMs = preGift?.createdAt ? new Date(preGift.createdAt).getTime() : 0;
      const minDelayMs = MIN_CLAIM_DELAY_SEC * 1000;

      if (!preGift) {
        await applyClaimTimingFloor();
        return res.status(404).json({
          error: "Not found",
          code: "NOT_FOUND",
          version: VERSION,
        });
      }

      if (preGift.isClaimed || preGift.claimedAt) {
        await applyClaimTimingFloor();
        return res.status(409).json({
          error: "Already claimed",
          code: "ALREADY_CLAIMED",
          version: VERSION,
        });
      }

      if (createdAtMs && Date.now() - createdAtMs < minDelayMs) {
        const waitMs = minDelayMs - (Date.now() - createdAtMs);
        await applyClaimTimingFloor();
        return res.status(429).json({
          error: "Please wait a moment before claiming",
          code: "CLAIM_TOO_SOON",
          retryAfterSec: Math.ceil(waitMs / 1000),
          version: VERSION,
        });
      }

      if (preAmountCents > 0 && shouldRequireTurnstile()) {
        const turnstileToken = String((req.body as any)?.turnstileToken || "").trim();
        const remoteip = getIp(req);

        const ts = await verifyTurnstile(turnstileToken, remoteip);
        if (!ts.ok) {
          await applyClaimTimingFloor();
          return res.status(400).json({
            error: "Verification failed",
            code: "TURNSTILE_FAILED",
            detail: ts.codes,
            version: VERSION,
          });
        }
      }

      const claimResult = await db.transaction(async (tx) => {
        const row = await tx
          .select({
            id: gifts.id,
            publicId: gifts.publicId,
            amount: gifts.amount,
            paymentStatus: gifts.paymentStatus,
            paidAt: gifts.paidAt,
            createdAt: gifts.createdAt,
            claimedAt: gifts.claimedAt,
            isClaimed: gifts.isClaimed,
          })
          .from(gifts)
          .where(eq(gifts.publicId, publicId))
          .limit(1);

        const g = row?.[0];
        if (!g) return { ok: false as const, status: 404, code: "NOT_FOUND" as const };

        if (g.isClaimed || g.claimedAt) {
          return { ok: false as const, status: 409, code: "ALREADY_CLAIMED" as const };
        }

        const amountCents = Number(g.amount || 0);
        const paid = Boolean(g.paidAt);

        if (amountCents > 0 && !paid) {
          return { ok: false as const, status: 409, code: "GIFT_NOT_PAID" as const };
        }

        const updated = await tx
          .update(gifts)
          .set({ isClaimed: true, claimedAt: now() })
          .where(and(eq(gifts.id, g.id), eq(gifts.isClaimed, false), isNull(gifts.claimedAt)))
          .returning({
            id: gifts.id,
            publicId: gifts.publicId,
          });

        if (!updated?.length) {
          return { ok: false as const, status: 409, code: "ALREADY_CLAIMED" as const };
        }

        return {
          ok: true as const,
          publicId: String(updated[0].publicId),
        };
      });

      if (!claimResult.ok) {
        await applyClaimTimingFloor();

        if (claimResult.code === "NOT_FOUND") {
          return res.status(404).json({
            error: "Not found",
            code: "NOT_FOUND",
            version: VERSION,
          });
        }

        if (claimResult.code === "ALREADY_CLAIMED") {
          return res.status(409).json({
            error: "Already claimed",
            code: "ALREADY_CLAIMED",
            version: VERSION,
          });
        }

        if (claimResult.code === "GIFT_NOT_PAID") {
          return res.status(409).json({
            error: "Gift not paid",
            code: "GIFT_NOT_PAID",
            version: VERSION,
          });
        }

        return res.status(409).json({
          error: "Claim failed",
          code: "CLAIM_FAILED",
          version: VERSION,
        });
      }

      try {
        await deliverGiftIfEligible(claimResult.publicId, "claim_success");
      } catch (e: any) {
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            event: "delivery_after_claim_error",
            publicId: claimResult.publicId,
            error: String(e?.message || e),
            version: VERSION,
          }),
        );
      }

      await applyClaimTimingFloor();
      return res.json({ ok: true, claimed: true, version: VERSION });
    } catch (err: any) {
      await applyClaimTimingFloor();
      return res.status(500).json({
        error: "Claim failed",
        code: "CLAIM_FAILED",
        detail: String(err?.message || err),
        version: VERSION,
      });
    }
  });

  /* -------------------- ADMIN: REMINDERS -------------------- */
  app.post("/api/admin/reminders/send", limiterAdmin, async (req, res) => {
    try {
      if (!ADMIN_TOKEN) {
        return res.status(503).json({
          error: "ADMIN_TOKEN not configured",
          code: "ADMIN_NOT_CONFIGURED",
          version: VERSION,
        });
      }
      if (!isAdmin(req)) {
        return res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED", version: VERSION });
      }
      if (!REMINDER_SENDING_ENABLED) {
        return res.json({ ok: true, sent: 0, skipped: 0, disabled: true, version: VERSION, attemptedPublicIds: [] });
      }

      const parsed = zAdminRemindersSend.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid request",
          code: "INVALID_REQUEST",
          issues: parsed.error.issues,
          version: VERSION,
        });
      }

      const limit = Math.max(1, Math.min(50, Number(parsed.data.limit ?? 20)));
      const targetPublicId = String(parsed.data.publicId || "").trim();
      const cutoff = new Date(Date.now() - REMINDER_GAP_MS);

      let rows: Array<{
        id: any;
        publicId: any;
        recipientEmail: any;
        senderEmail: any;
        amount: any;
        reminderCount: any;
        lastReminderSentAt: any;
      }> = [];
            if (targetPublicId) {
        const one = await db
          .select({
            id: gifts.id,
            publicId: gifts.publicId,
            recipientEmail: gifts.recipientEmail,
            senderEmail: gifts.senderEmail,
            amount: gifts.amount,
            reminderCount: gifts.reminderCount,
            lastReminderSentAt: gifts.lastReminderSentAt,
            isClaimed: gifts.isClaimed,
            claimedAt: gifts.claimedAt,
            returnedToSenderAt: gifts.returnedToSenderAt,
          })
          .from(gifts)
          .where(eq(gifts.publicId, targetPublicId))
          .limit(1);

        const g = one?.[0];
        if (!g) {
          return res
            .status(404)
            .json({ error: "Not found", code: "NOT_FOUND", version: VERSION, attemptedPublicIds: [] });
        }

        const eligible =
          g.isClaimed === false &&
          !g.claimedAt &&
          !g.returnedToSenderAt &&
          String(g.recipientEmail || "").trim() &&
          Number(g.reminderCount ?? 0) < REMINDER_MAX &&
          (!g.lastReminderSentAt || new Date(g.lastReminderSentAt).getTime() < cutoff.getTime());

        if (!eligible) {
          return res.json({
            ok: true,
            scanned: 1,
            sent: 0,
            updated: 0,
            skipped: 1,
            updatedButReadBackMismatch: 0,
            version: VERSION,
            attemptedPublicIds: [targetPublicId],
            note: "Target not eligible (claimed/returned/maxed/recently-reminded/no-email)",
          });
        }

        rows = [
          {
            id: g.id,
            publicId: g.publicId,
            recipientEmail: g.recipientEmail,
            senderEmail: g.senderEmail,
            amount: g.amount,
            reminderCount: g.reminderCount,
            lastReminderSentAt: g.lastReminderSentAt,
          },
        ];
      } else {
        rows = await db
          .select({
            id: gifts.id,
            publicId: gifts.publicId,
            recipientEmail: gifts.recipientEmail,
            senderEmail: gifts.senderEmail,
            amount: gifts.amount,
            reminderCount: gifts.reminderCount,
            lastReminderSentAt: gifts.lastReminderSentAt,
          })
          .from(gifts)
          .where(
            and(
              eq(gifts.isClaimed, false),
              isNull(gifts.claimedAt),
              isNull(gifts.returnedToSenderAt),
              lt(sql<number>`coalesce(${gifts.reminderCount}, 0)`, REMINDER_MAX),
              or(isNull(gifts.lastReminderSentAt), lt(gifts.lastReminderSentAt, cutoff)),
              sql`${gifts.recipientEmail} is not null`,
            ),
          )
          .orderBy(asc(gifts.lastReminderSentAt), asc(gifts.id))
          .limit(limit);
      }

      let sent = 0;
      let skipped = 0;
      let updated = 0;
      let updatedButReadBackMismatch = 0;

      const attemptedPublicIds: string[] = [];

      for (const g of rows) {
        const id = Number(g.id as any);
        const pid = String(g.publicId || "").trim();
        const to = String(g.recipientEmail || "").trim();

        if (pid) attemptedPublicIds.push(pid);

        if (!id || !pid || !to) {
          skipped++;
          continue;
        }

        const claimUrl = buildClaimUrl(pid);

        try {
          await sendReminderEmail({
            to,
            publicId: pid,
            claimUrl,
            amountCents: g.amount ?? null,
            senderEmail: g.senderEmail || undefined,
          } as any);

          sent += 1;

          const write = await db
            .update(gifts)
            .set({
              reminderCount: sql<number>`coalesce(${gifts.reminderCount}, 0) + 1`,
              lastReminderSentAt: now(),
            })
            .where(
              and(
                eq(gifts.id, id as any),
                eq(gifts.publicId, pid),
                eq(gifts.isClaimed, false),
                isNull(gifts.claimedAt),
                isNull(gifts.returnedToSenderAt),
                lt(sql<number>`coalesce(${gifts.reminderCount}, 0)`, REMINDER_MAX),
              ),
            )
            .returning({
              id: gifts.id,
              reminderCount: gifts.reminderCount,
              lastReminderSentAt: gifts.lastReminderSentAt,
            });

          if (!write?.length) {
            skipped++;
            continue;
          }

          updated += 1;

          const check = await db
            .select({
              reminderCount: gifts.reminderCount,
              lastReminderSentAt: gifts.lastReminderSentAt,
            })
            .from(gifts)
            .where(eq(gifts.id, id as any))
            .limit(1);

          const c = check?.[0];
          if (!c || !c.lastReminderSentAt || Number(c.reminderCount ?? 0) <= 0) {
            updatedButReadBackMismatch += 1;
          }
        } catch (e: any) {
          skipped++;
          console.log(
            JSON.stringify({
              ts: new Date().toISOString(),
              event: "reminder_send_or_persist_failed",
              publicId: pid,
              error: String(e?.message || e),
              version: VERSION,
            }),
          );
        }
      }

      return res.json({
        ok: true,
        scanned: rows.length,
        sent,
        updated,
        skipped,
        updatedButReadBackMismatch,
        version: VERSION,
        attemptedPublicIds,
      });
    } catch (err: any) {
      return res.status(500).json({
        error: "Reminders send failed",
        code: "REMINDERS_FAILED",
        detail: String(err?.message || err),
        version: VERSION,
      });
    }
  });

  /* -------------------- ADMIN: RETURN TO SENDER -------------------- */
  app.post("/api/admin/return-to-sender/send", limiterAdmin, async (req, res) => {
    try {
      if (!ADMIN_TOKEN) {
        return res.status(503).json({
          error: "ADMIN_TOKEN not configured",
          code: "ADMIN_NOT_CONFIGURED",
          version: VERSION,
        });
      }
      if (!isAdmin(req)) {
        return res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED", version: VERSION });
      }

      const publicId = String((req.body || {}).publicId || "").trim();
      const reason = String((req.body || {}).reason || "").trim() || undefined;

      if (!publicId) {
        return res.status(400).json({
          error: "publicId required",
          field: "publicId",
          code: "MISSING_PUBLIC_ID",
          version: VERSION,
        });
      }

      const row = await db
  .select({
    id: gifts.id,
    createdAt: gifts.createdAt,
    claimedAt: gifts.claimedAt,
    isClaimed: gifts.isClaimed,
    amount: gifts.amount,
    paymentStatus: gifts.paymentStatus,
  })
        .from(gifts)
        .where(eq(gifts.publicId, publicId))
        .limit(1);

      const g = row?.[0];
      if (!g) {
        return res.status(404).json({ error: "Not found", code: "NOT_FOUND", version: VERSION });
      }
      if (g.returnedToSenderAt) {
        return res.status(409).json({ error: "Already sent", code: "ALREADY_SENT", version: VERSION });
      }

      const to = String(g.senderEmail || "").trim();
      if (!to) {
        return res.status(400).json({ error: "Gift has no sender email", code: "NO_SENDER_EMAIL", version: VERSION });
      }

      await sendReturnToSenderEmail({
        to,
        publicId,
        amountCents: g.amount ?? null,
        reason,
      } as any);

      await db.update(gifts).set({ returnedToSenderAt: now() }).where(eq(gifts.id, g.id));

      return res.json({ ok: true, sent: true, version: VERSION });
    } catch (err: any) {
      return res.status(500).json({
        error: "Return-to-sender failed",
        code: "RETURN_TO_SENDER_FAILED",
        detail: String(err?.message || err),
        version: VERSION,
      });
    }
  });

  /* -------------------- FALLBACK 404 -------------------- */
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found", code: "NOT_FOUND", version: VERSION });
  });

  const httpServer = createServer(app);
  return httpServer;
}

/* -------------------- DRIZZLE HELPERS -------------------- */
function gtTime(col: any, d: Date) {
  return sql`${col} > ${d}`;
}