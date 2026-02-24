// WHERE TO PASTE: server/routes.ts
// ACTION: Full file replacement (paste exactly)

import express from "express";
import type { Express, Request } from "express";
import { createServer, type Server } from "http";
import crypto from "crypto";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { and, asc, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import dns from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";

import { db } from "./db";
import { gifts, users, authMagicLinks, authSessions } from "@shared/schema";
import {
  sendGiftEmail,
  sendReminderEmail,
  sendReturnToSenderEmail,
  sendAuthMagicLinkEmail,
} from "./email";
import { sendGiftSms } from "./sms";

/* -------------------- VERSION -------------------- */
const VERSION = "routes_v2026-02-24_002";
const COMMIT = process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || "";

/* -------------------- ROUTES MARKER -------------------- */
const ROUTES_MARKER =
  "locked_scope_guest_preset_email_only_no_amount_no_sms_registered_google_only_preset_or_custom_280_optional_sms_fixed_amounts_25_50_100_250_500_1000_google_oauth_redirect_v3_add_api_auth_google_alias_plus_stripe_checkout_webhook_persist_v3_alias_routes_fix_paywall_delivery_v1_stripe_webhook_rawbody_fix_v1_stripe_webhook_route_no_route_raw_v1";

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
const AUTH_RETURN_TOKEN = String(process.env.AUTH_RETURN_TOKEN ?? "true").toLowerCase() === "true";
const AUTH_MX_VALIDATE_ENABLED =
  String(process.env.AUTH_MX_VALIDATE_ENABLED ?? "false").toLowerCase() === "true";
const AUTH_MAGIC_LINK_ENABLED =
  String(process.env.AUTH_MAGIC_LINK_ENABLED ?? "false").toLowerCase() === "true";

/* -------------------- GOOGLE OAUTH -------------------- */
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || "").trim();
const GOOGLE_CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || "").trim();
const GOOGLE_REDIRECT_URI = `${API_URL}/api/auth/google/callback`;

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

/* -------------------- GOOGLE OAUTH STATE STORE -------------------- */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const oauthStateStore = new Map<string, { exp: number; ip: string; ua: string }>();
function pruneOauthState() {
  const nowMs = Date.now();
  for (const [k, v] of oauthStateStore.entries()) {
    if (!v || v.exp <= nowMs) oauthStateStore.delete(k);
  }
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

const REMINDER_GAP_MS = Math.max(1_000, Number(process.env.REMINDER_GAP_MS ?? 172800000));
const REMINDER_MAX = Math.max(0, Number(process.env.REMINDER_MAX ?? 3));
const REMINDER_SENDING_ENABLED =
  String(process.env.REMINDER_SENDING_ENABLED ?? "true").toLowerCase() === "true";

/* -------------------- ADMIN -------------------- */
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || "").trim();

/* -------------------- HELPERS -------------------- */
function now() {
  return new Date();
}

function getIp(req: Request) {
  const xf = (req.headers["x-forwarded-for"] || "") as string;
  return (xf.split(",")[0] || "").trim() || req.socket.remoteAddress || "";
}

function sha256Hex(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

function moneyToCents(dollars: number) {
  const cents = Math.round((Number(dollars) || 0) * 100);
  return Number.isFinite(cents) ? cents : 0;
}

function normalizeEmail(e: string) {
  return String(e || "").trim().toLowerCase();
}

function extractDomain(email: string) {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "";
  return email.slice(at + 1).trim().toLowerCase();
}

function isDisposableEmail(email: string) {
  const d = extractDomain(email);
  if (!d) return false;
  if (!DISPOSABLE_EMAIL_DOMAINS.size) return false;
  return DISPOSABLE_EMAIL_DOMAINS.has(d);
}

function isE164(s: string) {
  return /^\+[1-9]\d{7,14}$/.test(String(s || "").trim());
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
  const auth = String(req.headers.authorization || "");
  if (auth.toLowerCase().startsWith("bearer ")) {
    const t = auth.slice("bearer ".length).trim();
    if (t && t === ADMIN_TOKEN) return true;
  }
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

function buildGoogleConsumeUrl(sessionToken: string, email: string) {
  const token = encodeURIComponent(sessionToken);
  const e = encodeURIComponent(email || "");
  return `${publicSiteBase()}/auth/google#token=${token}${e ? `&email=${e}` : ""}`;
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
  if (!senderEmail) return 0;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const rows = await db
    .select({ c: sql<number>`count(*)` })
    .from(gifts)
    .where(and(eq(gifts.senderEmail, senderEmail), gte(gifts.createdAt, start)));
  return Number(rows?.[0]?.c || 0);
}

/* -------------------- AUTH -------------------- */
type Authed = { isAuthed: true; userId: string; sessionToken: string } | { isAuthed: false };

async function getAuth(req: Request): Promise<Authed> {
  const auth = String(req.headers.authorization || "");
  if (!auth.toLowerCase().startsWith("bearer ")) return { isAuthed: false };
  const sessionToken = auth.slice("bearer ".length).trim();
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

  return { isAuthed: true, userId: String(s.userId), sessionToken };
}

async function issueSessionForEmail(email: string, req: Request) {
  const norm = normalizeEmail(email);
  const domain = extractDomain(norm);

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
  const mx = await mxLooksValid(domain);
  if (!mx.ok) {
    return {
      ok: false as const,
      code: "MX_INVALID" as const,
      error: "Email domain not deliverable",
      reason: mx.reason,
    };
  }

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, norm)).limit(1);

  let userId = String(existing?.[0]?.id || "");
  if (!userId) {
    userId = crypto.randomBytes(16).toString("hex");
    await db.insert(users).values({
      id: userId,
      email: norm,
      createdAt: now(),
      lastLoginAt: null,
    });
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

    await tx.update(users).set({ lastLoginAt: now() }).where(eq(users.id, userId));
  });

  return { ok: true as const, userId, sessionToken, expiresAt };
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

const limiterStripe = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

/* -------------------- STRIPE CORE HANDLERS -------------------- */
async function handleCreateCheckoutSession(req: Request, res: any) {
  try {
    const a = await getAuth(req);
    if (!a.isAuthed) {
      return res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED", version: VERSION });
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

    const successUrl =
      String(parsed.data.successUrl || "").trim() ||
      `${FRONTEND_URL}/pay/success?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = String(parsed.data.cancelUrl || "").trim() || `${FRONTEND_URL}/pay/cancel`;

    const params = new URLSearchParams();
    params.set("mode", "payment");
    params.set("success_url", successUrl);
    params.set("cancel_url", cancelUrl);

    params.set("line_items[0][quantity]", "1");
    params.set("line_items[0][price_data][currency]", STRIPE_CURRENCY);
    params.set("line_items[0][price_data][unit_amount]", String(amountCents));
    params.set("line_items[0][price_data][product_data][name]", "ThankuMail Gift");
    params.set("line_items[0][price_data][product_data][description]", "A ThankuMail gift certificate payment");

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
      await db
        .update(gifts)
        .set({
          stripeCheckoutSessionId: sessionId,
          paymentStatus: "created",
        })
        .where(and(eq(gifts.publicId, publicId), eq(gifts.senderUserId, a.userId)));
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
    const type = String(event?.type || "");
    const obj = event?.data?.object || null;

    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: "stripe_webhook_received",
        stripeType: type,
        stripeId: String(event?.id || ""),
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

          const alreadyPaid = Boolean(g.paidAt) || String(g.paymentStatus || "").toLowerCase() === "paid";
          if (alreadyPaid) {
            await tx
              .update(gifts)
              .set({
                stripeCheckoutSessionId: sessionId || null,
                stripePaymentIntentId: paymentIntentId || null,
                paymentStatus: "paid",
              })
              .where(eq(gifts.id, g.id));
            return;
          }

          const setAmount =
            g.amount == null && amountCents != null && Number.isFinite(amountCents) ? amountCents : undefined;

          await tx
            .update(gifts)
            .set({
              paymentStatus: stripeIsPaid(paymentStatus) ? "paid" : paymentStatus,
              stripeCheckoutSessionId: sessionId || null,
              stripePaymentIntentId: paymentIntentId || null,
              paidAt: stripeIsPaid(paymentStatus) ? now() : null,
              amount: setAmount as any,
            })
            .where(eq(gifts.id, g.id));
        });
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
      },

      google: {
        configured: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
        redirectUri: GOOGLE_REDIRECT_URI,
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
          auth: "google-only",
        },
      },

      presetIds: { min: PRESET_MIN_ID, max: PRESET_MAX_ID },
    });
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
  // NOTE: DO NOT add express.json() here (index.ts already parsed JSON for non-webhook routes)
  app.post("/api/stripe/checkout/session", limiterStripe, handleCreateCheckoutSession);
  app.post("/api/stripe/create-checkout-session", limiterStripe, handleCreateCheckoutSession);

  /* -------------------- STRIPE: WEBHOOK (CANONICAL + ALIAS) -------------------- */
  // NOTE: DO NOT add express.raw() here (index.ts handles raw parsing; req.rawBody is populated)
  app.post("/api/webhooks/stripe", limiterStripe, handleStripeWebhook);
  app.post("/api/stripe/webhook", limiterStripe, handleStripeWebhook);

  /* -------------------- AUTH: GOOGLE OAUTH -------------------- */
  app.get("/api/auth/google", limiterGoogle, async (req, res) => {
    pruneOauthState();

    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return res
        .status(503)
        .json({ error: "Google auth not configured", code: "GOOGLE_NOT_CONFIGURED", version: VERSION });
    }

    const ip = getIp(req);
    const ua = String(req.headers["user-agent"] || "").slice(0, 200);

    const state = randomToken(16);
    oauthStateStore.set(state, { exp: Date.now() + OAUTH_STATE_TTL_MS, ip, ua });

    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set("client_id", GOOGLE_CLIENT_ID);
    url.searchParams.set("redirect_uri", GOOGLE_REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state);
    url.searchParams.set("access_type", "online");
    url.searchParams.set("prompt", "select_account");

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

    const state = randomToken(16);
    oauthStateStore.set(state, { exp: Date.now() + OAUTH_STATE_TTL_MS, ip, ua });

    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set("client_id", GOOGLE_CLIENT_ID);
    url.searchParams.set("redirect_uri", GOOGLE_REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state);
    url.searchParams.set("access_type", "online");
    url.searchParams.set("prompt", "select_account");

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
      return res.status(400).json({
        error: "Google auth failed",
        code: "GOOGLE_OAUTH_ERROR",
        detail: err,
        version: VERSION,
      });
    }
    if (!code || !state) {
      return res.status(400).json({ error: "Invalid callback", code: "GOOGLE_CALLBACK_INVALID", version: VERSION });
    }

    const saved = oauthStateStore.get(state);
    oauthStateStore.delete(state);

    if (!saved || saved.exp <= Date.now()) {
      return res.status(400).json({ error: "Invalid state", code: "OAUTH_STATE_INVALID", version: VERSION });
    }

    const ip = getIp(req);
    const ua = String(req.headers["user-agent"] || "").slice(0, 200);
    if (saved.ip && saved.ip !== ip) {
      return res.status(400).json({ error: "State mismatch", code: "OAUTH_STATE_MISMATCH", version: VERSION });
    }
    if (saved.ua && saved.ua !== ua) {
      return res.status(400).json({ error: "State mismatch", code: "OAUTH_STATE_MISMATCH", version: VERSION });
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
      return res.status(400).json({
        error: "Token exchange failed",
        code: "GOOGLE_TOKEN_EXCHANGE_FAILED",
        detail: tokenJson,
        version: VERSION,
      });
    }

    const infoResp = await fetch(GOOGLE_USERINFO_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const infoJson: any = await infoResp.json().catch(() => ({}));

    const email = normalizeEmail(String(infoJson?.email || ""));
    const emailVerified = infoJson?.email_verified;

    if (!email) {
      return res.status(400).json({ error: "Google did not return email", code: "GOOGLE_NO_EMAIL", version: VERSION });
    }
    if (emailVerified === false) {
      return res.status(400).json({ error: "Email not verified", code: "EMAIL_NOT_VERIFIED", version: VERSION });
    }

    const issued = await issueSessionForEmail(email, req);
    if (!issued.ok) {
      return res.status(400).json({
        error: issued.error,
        code: issued.code,
        reason: (issued as any).reason,
        version: VERSION,
      });
    }

    return res.redirect(302, buildGoogleConsumeUrl(issued.sessionToken, email));
  });

  /* -------------------- AUTH: MAGIC LINK (DISABLED BY DEFAULT) -------------------- */
  app.post("/api/auth/request", limiterAuthRequest, async (req, res) => {
    if (!AUTH_MAGIC_LINK_ENABLED) {
      return res.status(403).json({
        error: "Magic link login is disabled",
        code: "MAGIC_LINK_DISABLED",
        version: VERSION,
      });
    }

    try {
      const ip = getIp(req);
      const parsed = zAuthRequest.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid request",
          code: "INVALID_REQUEST",
          issues: parsed.error.issues,
          version: VERSION,
        });
      }

      const email = normalizeEmail(parsed.data.email);
      const domain = extractDomain(email);
      const turnstileToken = String(parsed.data.turnstileToken || "").trim();

      if (!domain) {
        return res.status(400).json({
          error: "Invalid email",
          field: "email",
          code: "INVALID_EMAIL",
          version: VERSION,
        });
      }

      if (shouldRequireTurnstile()) {
        if (!turnstileToken) {
          return res.status(400).json({
            error: "Missing CAPTCHA token",
            field: "turnstileToken",
            code: "TURNSTILE_REQUIRED",
            version: VERSION,
          });
        }
      }

      const v = await verifyTurnstile(turnstileToken, ip);
      if (!v.ok) {
        return res.status(400).json({
          error: "Missing or invalid CAPTCHA token",
          field: "turnstileToken",
          code: "TURNSTILE_FAILED",
          codes: v.codes,
          version: VERSION,
        });
      }

      if (isDisposableEmail(email)) {
        return res.status(400).json({
          error: "Email provider not supported",
          field: "email",
          code: "DISPOSABLE_EMAIL_BLOCKED",
          version: VERSION,
        });
      }

      const mx = await mxLooksValid(domain);
      if (!mx.ok) {
        return res.status(400).json({
          error: "Email domain not deliverable",
          field: "email",
          code: "MX_INVALID",
          reason: mx.reason,
          version: VERSION,
        });
      }

      const rawToken = randomToken(24);
      const tokenHash = sha256Hex(rawToken);
      const expiresAt = new Date(Date.now() + AUTH_MAGIC_LINK_TTL_MS);
      const ua = String(req.headers["user-agent"] || "").slice(0, 500);

      await db.insert(authMagicLinks).values({
        email,
        tokenHash,
        expiresAt,
        consumedAt: null,
        ip,
        userAgent: ua || null,
        createdAt: now(),
      });

      const loginUrl = buildAuthConsumeUrl(rawToken);

      let emailSent = false;
      let emailError: string | null = null;
      try {
        logAuth("auth_magiclink_email_send_start", { toDomain: domain });
        const r = await sendAuthMagicLinkEmail({ to: email, loginUrl });
        emailSent = Boolean(r.ok);
        if (!r.ok) emailError = String(r.error || "unknown");
        logAuth("auth_magiclink_email_send_result", {
          toDomain: domain,
          ok: emailSent,
          error: emailError || undefined,
        });
      } catch (e: any) {
        emailSent = false;
        emailError = String(e?.message || e);
        logAuth("auth_magiclink_email_send_crash", { toDomain: domain, error: emailError });
      }

      if (AUTH_RETURN_TOKEN) {
        return res.json({
          ok: true,
          token: rawToken,
          loginUrl,
          expiresAt: expiresAt.toISOString(),
          emailSent,
          emailError: emailError || undefined,
          version: VERSION,
        });
      }

      return res.json({
        ok: true,
        sent: true,
        loginUrl,
        expiresAt: expiresAt.toISOString(),
        emailSent,
        emailError: emailError || undefined,
        version: VERSION,
      });
    } catch (err: any) {
      return res.status(500).json({
        error: "Auth request failed",
        code: "AUTH_REQUEST_FAILED",
        detail: String(err?.message || err),
        version: VERSION,
      });
    }
  });

  app.post("/api/auth/consume", limiterAuthConsume, async (req, res) => {
    if (!AUTH_MAGIC_LINK_ENABLED) {
      return res.status(403).json({
        error: "Magic link login is disabled",
        code: "MAGIC_LINK_DISABLED",
        version: VERSION,
      });
    }

    try {
      const parsed = zAuthConsume.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid request",
          code: "INVALID_REQUEST",
          issues: parsed.error.issues,
          version: VERSION,
        });
      }

      const tokenHash = sha256Hex(parsed.data.token);

      const consumed = await db.transaction(async (tx) => {
        const updated = await tx
          .update(authMagicLinks)
          .set({ consumedAt: now() })
          .where(
            and(
              eq(authMagicLinks.tokenHash, tokenHash),
              isNull(authMagicLinks.consumedAt),
              gtTime(authMagicLinks.expiresAt, new Date()),
            ),
          )
          .returning({
            id: authMagicLinks.id,
            email: authMagicLinks.email,
            expiresAt: authMagicLinks.expiresAt,
          });

        if (updated?.length) {
          return { ok: true as const, email: String(updated[0].email || "").trim().toLowerCase() };
        }

        const row = await tx
          .select({
            consumedAt: authMagicLinks.consumedAt,
            expiresAt: authMagicLinks.expiresAt,
          })
          .from(authMagicLinks)
          .where(eq(authMagicLinks.tokenHash, tokenHash))
          .limit(1);

        const link = row?.[0];
        if (!link) return { ok: false as const, code: "MAGIC_LINK_INVALID" as const };
        if (link.consumedAt) return { ok: false as const, code: "MAGIC_LINK_USED" as const };
        if (link.expiresAt && new Date(link.expiresAt).getTime() <= Date.now())
          return { ok: false as const, code: "MAGIC_LINK_EXPIRED" as const };

        return { ok: false as const, code: "MAGIC_LINK_INVALID" as const };
      });

      if (!consumed.ok) {
        const msg =
          consumed.code === "MAGIC_LINK_USED"
            ? "Link already used"
            : consumed.code === "MAGIC_LINK_EXPIRED"
              ? "Link expired"
              : "Invalid or expired link";

        return res.status(400).json({
          error: msg,
          code: consumed.code,
          version: VERSION,
        });
      }

      const email = normalizeEmail(consumed.email);
      const issued = await issueSessionForEmail(email, req);
      if (!issued.ok) {
        return res.status(400).json({
          error: issued.error,
          code: issued.code,
          reason: (issued as any).reason,
          version: VERSION,
        });
      }

      return res.json({
        ok: true,
        sessionToken: issued.sessionToken,
        expiresAt: issued.expiresAt.toISOString(),
        version: VERSION,
      });
    } catch (err: any) {
      return res.status(500).json({
        error: "Auth consume failed",
        code: "AUTH_CONSUME_FAILED",
        detail: String(err?.message || err),
        version: VERSION,
      });
    }
  });

  app.get("/api/auth/me", async (req, res) => {
    const a = await getAuth(req);
    if (!a.isAuthed) {
      return res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED", version: VERSION });
    }

    const row = await db
      .select({
        id: users.id,
        email: users.email,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
      })
      .from(users)
      .where(eq(users.id, a.userId))
      .limit(1);

    return res.json({ ok: true, user: row?.[0] || null, version: VERSION });
  });

  app.get("/api/me", async (req, res) => {
    const a = await getAuth(req);
    if (!a.isAuthed) {
      return res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED", version: VERSION });
    }

    const row = await db
      .select({
        id: users.id,
        email: users.email,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
      })
      .from(users)
      .where(eq(users.id, a.userId))
      .limit(1);

    return res.json({ ok: true, user: row?.[0] || null, version: VERSION });
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

      const normSenderEmail = senderEmail ? String(senderEmail).trim().toLowerCase() : "";
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

      const toEmail = String(recipientEmail || "").trim().toLowerCase();
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
      const claimUrl =
        (process.env.PUBLIC_CLAIM_BASE_URL || `${FRONTEND_URL}/claim`).replace(/\/+$/, "") + "/" + publicId;

      const deliveryMethod = isRegistered ? (toPhone ? (toEmail ? "email+sms" : "sms") : "email") : "email";

      await db.insert(gifts).values({
        publicId,
        senderUserId: isRegistered ? a.userId : null,
        senderEmail: normSenderEmail || null,
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

        isClaimed: false,
        createdAt: now(),
        claimedAt: null,

        reminderCount: 0,
        lastReminderSentAt: null,
        returnedToSenderAt: null,
      });

      let emailSent = false;
      let smsQueued = false;
      let deliveryError: string | null = null;

      /**
       * IMPORTANT:
       * If gift has an amount, DO NOT deliver yet.
       * Delivery will happen after Stripe webhook confirms payment.
       */
      const requiresPayment = finalAmountCents != null;

      if (!requiresPayment) {
        if (toEmail) {
          try {
            await sendGiftEmail({
              to: toEmail,
              publicId,
              claimUrl,
              amountCents: finalAmountCents,
              senderEmail: normSenderEmail || undefined,
              message: finalMessageMode === "custom" ? (finalMessage || undefined) : undefined,
            } as any);
            emailSent = true;
          } catch (e: any) {
            deliveryError = String(e?.message || e);
          }
        }

        if (isRegistered && toPhone) {
          try {
            await sendGiftSms({
              toPhone,
              publicId,
              claimUrl,
            } as any);
            smsQueued = true;
          } catch (e: any) {
            const msg = String(e?.message || e);
            deliveryError = deliveryError ? `${deliveryError}; ${msg}` : msg;
          }
        }
      }

      return res.json({
        ok: true,
        publicId,
        claimUrl,
        deliveryOk: Boolean((toEmail ? emailSent : true) && (toPhone ? smsQueued : true)),
        emailSent,
        smsQueued,
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

  /* -------------------- GIFTS: GET -------------------- */
  app.get("/api/gifts/:publicId", async (req, res) => {
    try {
      const publicId = String(req.params.publicId || "").trim();
      if (!publicId) {
        return res.status(400).json({ error: "Missing id", code: "MISSING_ID", version: VERSION });
      }

      const row = await db
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
          stripeCheckoutSessionId: gifts.stripeCheckoutSessionId,
          stripePaymentIntentId: gifts.stripePaymentIntentId,
          paidAt: gifts.paidAt,
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

      return res.json({
        ok: true,
        gift: {
          publicId: g.publicId,
          senderEmail: g.senderEmail || null,
          deliveryMethod: (g.deliveryMethod as any) || null,
          messageMode: (g.messageMode as any) || "preset",
          presetMessageId: g.presetMessageId ?? null,
          message: (g.messageMode as any) === "custom" ? g.message || "" : "",
          amount: g.amount ?? null,
          paymentStatus: g.paymentStatus ?? null,
          stripeCheckoutSessionId: g.stripeCheckoutSessionId ?? null,
          stripePaymentIntentId: g.stripePaymentIntentId ?? null,
          paidAt: g.paidAt ?? null,
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
  app.post("/api/gifts/:publicId/claim", async (req, res) => {
    try {
      const publicId = String(req.params.publicId || "").trim();
      if (!publicId) {
        return res.status(400).json({ error: "Missing id", code: "MISSING_ID", version: VERSION });
      }

      const row = await db
        .select({
          id: gifts.id,
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
      if (g.isClaimed || g.claimedAt) {
        return res.status(409).json({ error: "Already claimed", code: "ALREADY_CLAIMED", version: VERSION });
      }

      const createdAtMs = g.createdAt ? new Date(g.createdAt).getTime() : 0;
      const minDelayMs = MIN_CLAIM_DELAY_SEC * 1000;
      if (createdAtMs && Date.now() - createdAtMs < minDelayMs) {
        const waitMs = minDelayMs - (Date.now() - createdAtMs);
        return res.status(429).json({
          error: "Please wait a moment before claiming",
          code: "CLAIM_TOO_SOON",
          retryAfterSec: Math.ceil(waitMs / 1000),
          version: VERSION,
        });
      }

      const updated = await db
        .update(gifts)
        .set({ isClaimed: true, claimedAt: now() })
        .where(and(eq(gifts.id, g.id), eq(gifts.isClaimed, false), isNull(gifts.claimedAt)))
        .returning({ id: gifts.id });

      if (!updated?.length) {
        return res.status(409).json({ error: "Already claimed", code: "ALREADY_CLAIMED", version: VERSION });
      }

      return res.json({ ok: true, claimed: true, version: VERSION });
    } catch (err: any) {
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
        return res.json({ ok: true, sent: 0, skipped: 0, disabled: true, version: VERSION });
      }

      const limit = Math.max(1, Math.min(50, Number((req.body || {}).limit ?? 20)));
      const cutoff = new Date(Date.now() - REMINDER_GAP_MS);

      const rows = await db
        .select({
          id: gifts.id,
          publicId: gifts.publicId,
          recipientEmail: gifts.recipientEmail,
          senderEmail: gifts.senderEmail,
          amount: gifts.amount,
          isClaimed: gifts.isClaimed,
          claimedAt: gifts.claimedAt,
          reminderCount: gifts.reminderCount,
          lastReminderSentAt: gifts.lastReminderSentAt,
          returnedToSenderAt: gifts.returnedToSenderAt,
        })
        .from(gifts)
        .where(
          and(
            eq(gifts.isClaimed, false),
            isNull(gifts.claimedAt),
            isNull(gifts.returnedToSenderAt),
            lt(gifts.reminderCount, REMINDER_MAX),
            or(isNull(gifts.lastReminderSentAt), lt(gifts.lastReminderSentAt, cutoff)),
            sql`${gifts.recipientEmail} is not null`,
          ),
        )
        .orderBy(asc(gifts.lastReminderSentAt), asc(gifts.id))
        .limit(limit);

      let sent = 0;
      let skipped = 0;

      for (const g of rows) {
        const pid = String(g.publicId || "");
        const to = String(g.recipientEmail || "").trim();
        if (!pid || !to) {
          skipped++;
          continue;
        }

        const claimUrl =
          (process.env.PUBLIC_CLAIM_BASE_URL || `${FRONTEND_URL}/claim`).replace(/\/+$/, "") + "/" + pid;

        try {
          await sendReminderEmail({
            to,
            publicId: pid,
            claimUrl,
            amountCents: g.amount ?? null,
            senderEmail: g.senderEmail || undefined,
          } as any);

          await db
            .update(gifts)
            .set({
              reminderCount: Number(g.reminderCount || 0) + 1,
              lastReminderSentAt: now(),
            })
            .where(eq(gifts.id, g.id));

          sent++;
        } catch {
          skipped++;
        }
      }

      return res.json({ ok: true, sent, skipped, scanned: rows.length, version: VERSION });
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
          senderEmail: gifts.senderEmail,
          amount: gifts.amount,
          returnedToSenderAt: gifts.returnedToSenderAt,
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