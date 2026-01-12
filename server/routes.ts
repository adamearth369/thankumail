import type { Express } from "express";
import type { Server } from "http";
import crypto from "crypto";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { db } from "./db";
import { gifts } from "@shared/schema";
import { eq } from "drizzle-orm";
import { sendGiftEmail } from "./email";

/* -------------------- STRUCTURED LOGGING -------------------- */
function logEvent(event: string, fields: Record<string, any> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}
function safeStr(v: any) {
  return typeof v === "string" ? v : "";
}

/* -------------------- BASE URL -------------------- */
function getBaseUrl(req: any) {
  const envBase = process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "";
  if (envBase) return envBase.replace(/\/+$/, "");
  const proto = (req.headers["x-forwarded-proto"] || "https").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return `${proto}://${host}`.replace(/\/+$/, "");
}

/* -------------------- TIMEOUT WRAPPER -------------------- */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout:${label}:${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/* -------------------- CLIENT KEY -------------------- */
function getClientKey(req: any) {
  const xff = safeStr(req.headers["x-forwarded-for"]);
  const firstXff = xff ? xff.split(",")[0].trim() : "";
  const ip = safeStr(req.ip);
  const host = safeStr(req.headers["x-forwarded-host"] || req.headers.host || "");
  return `${firstXff || ip || "unknown"}|${host || "unknown"}`;
}
function getClientIp(req: any) {
  const xff = safeStr(req.headers["x-forwarded-for"]);
  const firstXff = xff ? xff.split(",")[0].trim() : "";
  const ip = safeStr(req.ip);
  return firstXff || ip || "unknown";
}

/* -------------------- ENV HELPERS -------------------- */
function env(name: string, fallback = "") {
  const v = process.env[name];
  return (v ?? fallback).trim();
}
function envBool(name: string, fallback = false) {
  const v = env(name, "");
  if (!v) return fallback;
  return ["1", "true", "yes", "y", "on"].includes(v.toLowerCase());
}
function envInt(name: string, fallback: number) {
  const raw = env(name, "");
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

/* -------------------- DISPOSABLE EMAIL BLOCK -------------------- */
const BLOCKED_DOMAINS = new Set(
  [
    "mailinator.com",
    "guerrillamail.com",
    "10minutemail.com",
    "tempmail.com",
    "yopmail.com",
    "trashmail.com",
    "getnada.com",
    "dispostable.com",
    "minuteinbox.com",
    "maildrop.cc",
  ].map((d) => d.toLowerCase()),
);

function getEmailDomain(email: string) {
  const s = (email || "").trim().toLowerCase();
  const at = s.lastIndexOf("@");
  if (at < 0) return "";
  return s.slice(at + 1).trim();
}
function isDisposableEmail(email: string) {
  const domain = getEmailDomain(email);
  if (!domain) return false;
  return BLOCKED_DOMAINS.has(domain);
}

/* -------------------- DAILY LIMITS (IN-MEMORY) -------------------- */
/**
 * NOTE: In-memory counters reset on deploy/restart. Fine for v1 anti-abuse.
 * IMPORTANT: We ONLY increment counters after a successful DB insert (accepted request).
 */
function utcDayKey(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD UTC
}

const dailyIpCounts = new Map<string, number>(); // key: day|ip
const dailyRecipientCounts = new Map<string, number>(); // key: day|recipientEmail

function getCount(map: Map<string, number>, key: string) {
  return map.get(key) || 0;
}
function bump(map: Map<string, number>, key: string) {
  const next = (map.get(key) || 0) + 1;
  map.set(key, next);
  return next;
}

/* -------------------- TURNSTILE (CLOUDFLARE) -------------------- */
async function verifyTurnstile(token: string, remoteIp: string) {
  const secret = env("TURNSTILE_SECRET_KEY", "");
  if (!secret) return { ok: false as const, reason: "missing_secret" };

  try {
    const form = new URLSearchParams();
    form.set("secret", secret);
    form.set("response", token);
    if (remoteIp) form.set("remoteip", remoteIp);

    const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    const data: any = await resp.json().catch(() => null);

    const success = Boolean(data?.success);
    if (success) return { ok: true as const };

    const codes = Array.isArray(data?.["error-codes"]) ? data["error-codes"] : [];
    return { ok: false as const, reason: "failed", codes };
  } catch (e: any) {
    return { ok: false as const, reason: "exception", error: String(e?.message || e) };
  }
}

/* -------------------- RATE LIMITING (SHORT WINDOW / BURST) -------------------- */
const CREATE_BURST_MAX = envInt("CREATE_BURST_MAX_10MIN", 500); // set to 30 later
const CLAIM_BURST_MAX = envInt("CLAIM_BURST_MAX_10MIN", 120); // set to 30 later

const createGiftLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: CREATE_BURST_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientKey(req),
  handler: (req, res) => {
    logEvent("rate_limited_create_gift_burst", { key: getClientKey(req), max: CREATE_BURST_MAX });
    res.status(429).json({ error: "Too many requests", route: "POST /api/gifts" });
  },
});

const claimGiftLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: CLAIM_BURST_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientKey(req),
  handler: (req, res) => {
    logEvent("rate_limited_claim_gift_burst", { key: getClientKey(req), max: CLAIM_BURST_MAX });
    res.status(429).json({ error: "Too many requests", route: "POST /api/gifts/:publicId/claim" });
  },
});

/* -------------------- SEED -------------------- */
async function seed() {
  const existing = await db.select().from(gifts).limit(1);
  if (!existing || existing.length === 0) {
    await db.insert(gifts).values({
      publicId: "demo-gift",
      recipientEmail: "demo@example.com",
      message: "Welcome to ThanküMail 🎁",
      amount: 1000,
      isClaimed: false,
    });
    logEvent("seed_inserted");
  } else {
    logEvent("seed_noop");
  }
}

/* -------------------- SCHEMAS -------------------- */
const CreateGiftSchema = z.object({
  recipientEmail: z.string().email(),
  message: z.string().min(1).max(1000),
  amount: z.number().int().min(1000),
  // optional for now; we will enforce via TURNSTILE_ENFORCE later
  turnstileToken: z.string().min(1).optional(),
});

const AdminResetSchema = z.object({
  recipientEmail: z.string().email().optional(),
  resetAllForToday: z.boolean().optional(),
});

/* -------------------- ADMIN AUTH -------------------- */
function requireAdmin(req: any): { ok: true } | { ok: false; status: number; error: string } {
  const adminKey = env("ADMIN_KEY", "");
  if (!adminKey) return { ok: false, status: 503, error: "ADMIN_KEY not configured" };

  // Safety: only allow in prod if explicitly enabled
  const allow = envBool("ALLOW_ADMIN_RESET", false);
  const isProd = (process.env.NODE_ENV || "").toLowerCase() === "production";
  if (isProd && !allow) return { ok: false, status: 403, error: "Admin reset disabled" };

  const provided = safeStr(req.headers["x-admin-key"]);
  if (!provided || provided !== adminKey) return { ok: false, status: 401, error: "Unauthorized" };

  return { ok: true };
}

/* -------------------- HELPERS -------------------- */
function jsonNotFound(res: any) {
  return res.status(404).json({ error: "Not found" });
}

/* ==================== ROUTES ==================== */
export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  await seed();

  const DAILY_IP_LIMIT = envInt("DAILY_IP_LIMIT", 40);
  const DAILY_RECIPIENT_LIMIT = envInt("DAILY_RECIPIENT_LIMIT", 8);

  const TURNSTILE_ENFORCE = envBool("TURNSTILE_ENFORCE", false);
  const MIN_CLAIM_DELAY_SEC = envInt("MIN_CLAIM_DELAY_SEC", 0); // set to 60 later

  /* -------- HEALTH -------- */
  app.get(["/health", "/__health", "/api/health"], (_req, res) => {
    res.json({
      ok: true,
      routesMarker: "ROUTES_MARKER_v18_turnstile_optional_claim_delay_env",
      gitCommit: process.env.RENDER_GIT_COMMIT || "",
      serviceId: process.env.RENDER_SERVICE_ID || "",
    });
  });

  /* -------- ADMIN STATUS (NO SECRETS) -------- */
  app.get("/api/admin/status", (req, res) => {
    const today = utcDayKey();
    const ip = getClientIp(req);
    const ipKey = `${today}|${ip}`;

    const recipient = safeStr((req.query?.recipientEmail as any) || "").trim().toLowerCase();
    const recipKey = recipient ? `${today}|${recipient}` : "";

    res.json({
      ok: true,
      env: {
        NODE_ENV: process.env.NODE_ENV || "",
        PUBLIC_BASE_URL: Boolean(process.env.PUBLIC_BASE_URL),
        BASE_URL: Boolean(process.env.BASE_URL),
        FROM_EMAIL: Boolean(process.env.FROM_EMAIL),
        BREVO_API_KEY: Boolean(process.env.BREVO_API_KEY),
        ADMIN_KEY: Boolean(process.env.ADMIN_KEY),
        ALLOW_ADMIN_RESET: envBool("ALLOW_ADMIN_RESET", false),
        TURNSTILE_SECRET_KEY: Boolean(process.env.TURNSTILE_SECRET_KEY),
        TURNSTILE_ENFORCE,
        MIN_CLAIM_DELAY_SEC,
        CREATE_BURST_MAX_10MIN: CREATE_BURST_MAX,
        CLAIM_BURST_MAX_10MIN: CLAIM_BURST_MAX,
      },
      email: {
        provider: "brevo",
        configured: Boolean(process.env.FROM_EMAIL && process.env.BREVO_API_KEY),
        disposableBlockEnabled: true,
        blockedDomainsCount: BLOCKED_DOMAINS.size,
      },
      limits: {
        dailyIpLimit: DAILY_IP_LIMIT,
        dailyRecipientLimit: DAILY_RECIPIENT_LIMIT,
        todayUtc: today,
      },
      counters: {
        thisIpToday: getCount(dailyIpCounts, ipKey),
        recipientEmail: recipient || null,
        thisRecipientToday: recipient ? getCount(dailyRecipientCounts, recipKey) : null,
      },
      uptimeSec: Math.floor(process.uptime()),
    });
  });

  /* -------- ADMIN RESET LIMITS (PROTECTED) -------- */
  app.post("/api/admin/reset-limits", (req, res) => {
    const auth = requireAdmin(req);
    if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

    const parsed = AdminResetSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: "Invalid payload", issues: parsed.error.issues });
    }

    const today = utcDayKey();
    const ip = getClientIp(req);
    const ipKey = `${today}|${ip}`;

    if (parsed.data.resetAllForToday) {
      for (const k of Array.from(dailyIpCounts.keys())) {
        if (k.startsWith(`${today}|`)) dailyIpCounts.delete(k);
      }
      for (const k of Array.from(dailyRecipientCounts.keys())) {
        if (k.startsWith(`${today}|`)) dailyRecipientCounts.delete(k);
      }
      logEvent("admin_reset_limits_success", { scope: "all_for_today", today });
      return res.json({ ok: true, reset: "all_for_today", today });
    }

    dailyIpCounts.delete(ipKey);

    const recipient = (parsed.data.recipientEmail || "").trim().toLowerCase();
    if (recipient) {
      const recipKey = `${today}|${recipient}`;
      dailyRecipientCounts.delete(recipKey);
      logEvent("admin_reset_limits_success", { scope: "ip_and_recipient", today, ip, recipientEmail: recipient });
      return res.json({ ok: true, reset: "ip_and_recipient", today, ip, recipientEmail: recipient });
    }

    logEvent("admin_reset_limits_success", { scope: "ip_only", today, ip });
    return res.json({ ok: true, reset: "ip_only", today, ip });
  });

  /* -------- CREATE GIFT -------- */
  app.post("/api/gifts", createGiftLimiter, async (req, res) => {
    const parsed = CreateGiftSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid payload", issues: parsed.error.issues });
    }

    const { recipientEmail, message, amount, turnstileToken } = parsed.data;
    const recipientLower = recipientEmail.trim().toLowerCase();

    // Turnstile (optional now; enforced later via TURNSTILE_ENFORCE)
    if (TURNSTILE_ENFORCE) {
      if (!turnstileToken) {
        logEvent("turnstile_missing_token", { ip: getClientIp(req) });
        return res.status(400).json({ error: "Missing CAPTCHA token", field: "turnstileToken" });
      }
      const v = await verifyTurnstile(turnstileToken, getClientIp(req));
      if (!v.ok) {
        logEvent("turnstile_failed", { ip: getClientIp(req), ...v });
        return res.status(400).json({ error: "CAPTCHA verification failed" });
      }
      logEvent("turnstile_passed", { ip: getClientIp(req) });
    } else {
      // If token is provided, verify it and log, but do not block (safe rollout)
      if (turnstileToken && env("TURNSTILE_SECRET_KEY", "")) {
        const v = await verifyTurnstile(turnstileToken, getClientIp(req));
        logEvent(v.ok ? "turnstile_passed_soft" : "turnstile_failed_soft", { ip: getClientIp(req), ...v });
      }
    }

    if (isDisposableEmail(recipientLower)) {
      logEvent("blocked_disposable_email", { recipientDomain: getEmailDomain(recipientLower) });
      return res.status(400).json({ error: "Disposable email domains are not allowed", field: "recipientEmail" });
    }

    const today = utcDayKey();
    const ip = getClientIp(req);
    const ipKey = `${today}|${ip}`;
    const recipKey = `${today}|${recipientLower}`;

    const ipCount = getCount(dailyIpCounts, ipKey);
    if (ipCount >= DAILY_IP_LIMIT) {
      logEvent("daily_limit_ip_rejected", { today, ip, limit: DAILY_IP_LIMIT });
      return res.status(429).json({ error: "Daily limit reached for this IP", route: "POST /api/gifts" });
    }

    const recipCount = getCount(dailyRecipientCounts, recipKey);
    if (recipCount >= DAILY_RECIPIENT_LIMIT) {
      logEvent("daily_limit_recipient_rejected", { today, recipientEmail: recipientLower, limit: DAILY_RECIPIENT_LIMIT });
      return res.status(429).json({ error: "Daily limit reached for this recipient", route: "POST /api/gifts" });
    }

    const publicId = crypto.randomBytes(6).toString("hex");

    try {
      const inserted = await db
        .insert(gifts)
        .values({
          publicId,
          recipientEmail: recipientLower,
          message,
          amount,
          isClaimed: false,
        })
        .returning();

      bump(dailyIpCounts, ipKey);
      bump(dailyRecipientCounts, recipKey);

      const base = getBaseUrl(req);
      const claimPath = `/claim/${publicId}`;
      const claimUrl = `${base}${claimPath}`;

      logEvent("gift_created", {
        publicId,
        amount,
        recipientDomain: getEmailDomain(recipientLower),
        ip,
      });

      let emailSent = false;
      let emailError: string | null = null;

      const canEmail = Boolean(process.env.FROM_EMAIL && process.env.BREVO_API_KEY);
      if (canEmail) {
        try {
          await withTimeout(
            sendGiftEmail({
              to: recipientLower,
              claimUrl,
              message,
              amountCents: amount,
            } as any),
            12000,
            "sendGiftEmail",
          );
          emailSent = true;
          logEvent("email_sent_success", { publicId, toDomain: getEmailDomain(recipientLower) });
        } catch (e: any) {
          emailError = String(e?.message || e);
          logEvent("email_sent_fail", { publicId, error: emailError });
        }
      } else {
        logEvent("email_skipped_not_configured", { publicId });
      }

      return res.json({
        success: true,
        giftId: publicId,
        claimLink: claimPath,
        claimUrl,
        emailSent,
        emailError,
        dbId: inserted?.[0]?.id ?? null,
      });
    } catch (e: any) {
      logEvent("gift_create_error", { error: String(e?.message || e) });
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /* -------- GET GIFT -------- */
  app.get("/api/gifts/:publicId", async (req, res) => {
    const publicId = safeStr(req.params.publicId).trim();
    if (!publicId) return jsonNotFound(res);

    try {
      const rows = await db.select().from(gifts).where(eq(gifts.publicId, publicId)).limit(1);
      const gift = rows?.[0];
      if (!gift) return jsonNotFound(res);

      return res.json(gift);
    } catch (e: any) {
      logEvent("gift_get_error", { publicId, error: String(e?.message || e) });
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /* -------- CLAIM GIFT (API MUST BE JSON) -------- */
  app.post("/api/gifts/:publicId/claim", claimGiftLimiter, async (req, res) => {
    const publicId = safeStr(req.params.publicId).trim();
    if (!publicId) return jsonNotFound(res);

    try {
      logEvent("claim_attempted", { publicId, ip: getClientIp(req) });

      const rows = await db.select().from(gifts).where(eq(gifts.publicId, publicId)).limit(1);
      const gift = rows?.[0];
      if (!gift) {
        logEvent("claim_not_found", { publicId });
        return res.status(404).json({ error: "Gift not found" });
      }

      if (gift.isClaimed) {
        logEvent("claim_already_claimed", { publicId, claimedAt: gift.claimedAt || null });
        return res.status(409).json({ error: "Already claimed" });
      }

      // Minimum delay (optional; enable by setting MIN_CLAIM_DELAY_SEC=60)
      if (MIN_CLAIM_DELAY_SEC > 0 && gift.createdAt) {
        const created = new Date(gift.createdAt as any).getTime();
        const now = Date.now();
        const ageSec = Math.floor((now - created) / 1000);
        if (ageSec < MIN_CLAIM_DELAY_SEC) {
          logEvent("claim_too_soon_rejected", { publicId, ageSec, minSec: MIN_CLAIM_DELAY_SEC });
          return res.status(429).json({ error: "Please wait before claiming", retryAfterSec: MIN_CLAIM_DELAY_SEC - ageSec });
        }
      }

      const claimedAt = new Date();
      const updated = await db
        .update(gifts)
        .set({ isClaimed: true, claimedAt })
        .where(eq(gifts.publicId, publicId))
        .returning();

      logEvent("claim_completed", { publicId, claimedAt: claimedAt.toISOString() });

      return res.json({
        ok: true,
        publicId,
        claimedAt: claimedAt.toISOString(),
        gift: updated?.[0] ?? null,
      });
    } catch (e: any) {
      logEvent("claim_error", { publicId, error: String(e?.message || e) });
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /* -------- EMAIL TEST (JSON) -------- */
  app.post("/api/email/test", async (req, res) => {
    const to = safeStr(req.body?.to).trim().toLowerCase();
    if (!to) return res.status(400).json({ ok: false, error: "Missing 'to'" });
    if (!z.string().email().safeParse(to).success) return res.status(400).json({ ok: false, error: "Invalid email" });

    const base = getBaseUrl(req);
    const claimUrl = `${base}/claim/demo-gift`;

    const canEmail = Boolean(process.env.FROM_EMAIL && process.env.BREVO_API_KEY);
    if (!canEmail) return res.status(503).json({ ok: false, error: "Email not configured" });

    try {
      await withTimeout(
        sendGiftEmail({
          to,
          claimUrl,
          message: "Test email from ThankuMail",
          amountCents: 1000,
        } as any),
        12000,
        "sendGiftEmailTest",
      );

      logEvent("email_test_success", { toDomain: getEmailDomain(to) });
      return res.json({ ok: true });
    } catch (e: any) {
      const err = String(e?.message || e);
      logEvent("email_test_fail", { error: err, toDomain: getEmailDomain(to) });
      return res.status(500).json({ ok: false, error: err });
    }
  });

  /* -------- FALLBACK 404 FOR /api -------- */
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  return httpServer;
}
