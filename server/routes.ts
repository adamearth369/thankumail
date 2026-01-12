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

/* -------------------- RATE LIMITING (SHORT WINDOW / BURST) -------------------- */
const createGiftLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientKey(req),
  handler: (req, res) => {
    logEvent("rate_limited_create_gift_burst", { key: getClientKey(req) });
    res.status(429).json({ error: "Too many requests", route: "POST /api/gifts" });
  },
});

const claimGiftLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientKey(req),
  handler: (req, res) => {
    logEvent("rate_limited_claim_gift_burst", { key: getClientKey(req) });
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

/* ==================== ROUTES ==================== */
export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  await seed();

  const DAILY_IP_LIMIT = envInt("DAILY_IP_LIMIT", 40);
  const DAILY_RECIPIENT_LIMIT = envInt("DAILY_RECIPIENT_LIMIT", 8);

  /* -------- HEALTH -------- */
  app.get(["/health", "/__health", "/api/health"], (_req, res) => {
    res.json({
      ok: true,
      routesMarker: "ROUTES_MARKER_v16_admin_reset_success_only_counters",
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

    const recipientEmail = (parsed.data.recipientEmail || "").trim().toLowerCase();
    const recipKey = recipientEmail ? `${today}|${recipientEmail}` : "";

    const resetAll = Boolean(parsed.data.resetAllForToday);

    let clearedIp = 0;
    let clearedRecipients = 0;

    if (resetAll) {
      // Reset all counters for TODAY only (still protected by ADMIN_KEY + ALLOW_ADMIN_RESET)
      for (const k of Array.from(dailyIpCounts.keys())) {
        if (k.startsWith(`${today}|`)) {
          dailyIpCounts.delete(k);
          clearedIp++;
        }
      }
      for (const k of Array.from(dailyRecipientCounts.keys())) {
        if (k.startsWith(`${today}|`)) {
          dailyRecipientCounts.delete(k);
          clearedRecipients++;
        }
      }
      logEvent("admin_reset_limits_all_today", { today, clearedIp, clearedRecipients });
      return res.json({ ok: true, todayUtc: today, clearedIp, clearedRecipients });
    }

    // Default: reset just THIS CALLER IP, and optional single recipient
    if (dailyIpCounts.has(ipKey)) {
      dailyIpCounts.delete(ipKey);
      clearedIp = 1;
    }
    if (recipKey && dailyRecipientCounts.has(recipKey)) {
      dailyRecipientCounts.delete(recipKey);
      clearedRecipients = 1;
    }

    logEvent("admin_reset_limits_scoped", {
      today,
      ip,
      recipientEmail: recipientEmail || undefined,
      clearedIp,
      clearedRecipients,
    });

    return res.json({
      ok: true,
      todayUtc: today,
      scope: "ip(+optional recipient)",
      ip,
      recipientEmail: recipientEmail || null,
      clearedIp,
      clearedRecipients,
    });
  });

  /* -------- CREATE GIFT -------- */
  app.post("/api/gifts", createGiftLimiter, async (req, res) => {
    const requestId = safeStr(req.headers["x-request-id"] || req.headers["cf-ray"] || "");
    const started = Date.now();

    const parsed = CreateGiftSchema.safeParse(req.body);
    if (!parsed.success) {
      logEvent("gift_create_validation_failed", { requestId, issues: parsed.error.issues });
      return res.status(400).json({ error: "Invalid payload", issues: parsed.error.issues });
    }

    const { recipientEmail, message, amount } = parsed.data;

    // Disposable block
    if (isDisposableEmail(recipientEmail)) {
      logEvent("gift_create_disposable_blocked", { requestId, domain: getEmailDomain(recipientEmail) });
      return res.status(400).json({ error: "Disposable email addresses are not allowed", field: "recipientEmail" });
    }

    // Daily limits (CHECK ONLY — do NOT bump until successful DB insert)
    const today = utcDayKey();
    const ip = getClientIp(req);
    const ipKey = `${today}|${ip}`;
    const recipKey = `${today}|${recipientEmail.trim().toLowerCase()}`;

    const ipWouldBe = getCount(dailyIpCounts, ipKey) + 1;
    if (ipWouldBe > DAILY_IP_LIMIT) {
      logEvent("gift_create_daily_ip_limit", {
        requestId,
        ip,
        countWouldBe: ipWouldBe,
        limit: DAILY_IP_LIMIT,
        ms: Date.now() - started,
      });
      return res.status(429).json({
        error: "Daily IP limit reached",
        field: "ip",
        limit: DAILY_IP_LIMIT,
        todayUtc: today,
      });
    }

    const recipWouldBe = getCount(dailyRecipientCounts, recipKey) + 1;
    if (recipWouldBe > DAILY_RECIPIENT_LIMIT) {
      logEvent("gift_create_daily_recipient_limit", {
        requestId,
        recipientEmail,
        countWouldBe: recipWouldBe,
        limit: DAILY_RECIPIENT_LIMIT,
        ms: Date.now() - started,
      });
      return res.status(429).json({
        error: "Daily recipient limit reached",
        field: "recipientEmail",
        limit: DAILY_RECIPIENT_LIMIT,
        todayUtc: today,
      });
    }

    const publicId = crypto.randomBytes(6).toString("hex");
    const claimAbs = `${getBaseUrl(req)}/claim/${publicId}`;

    try {
      await db.insert(gifts).values({
        publicId,
        recipientEmail,
        message,
        amount,
        isClaimed: false,
      });
    } catch (e: any) {
      logEvent("gift_create_db_insert_failed", { requestId, error: safeStr(e?.message || e), ms: Date.now() - started });
      return res.status(500).json({ error: "Internal server error" });
    }

    // Bump counters ONLY after successful insert
    const ipCount = bump(dailyIpCounts, ipKey);
    const recipientCount = bump(dailyRecipientCounts, recipKey);

    logEvent("gift_create_ok", {
      requestId,
      publicId,
      ip,
      ipCount,
      recipientCount,
      ms: Date.now() - started,
    });

    res.json({ success: true, giftId: publicId, claimLink: `/claim/${publicId}` });

    withTimeout(
      sendGiftEmail({ to: recipientEmail, claimLink: claimAbs, message, amountCents: amount }),
      10_000,
      "sendGiftEmail",
    )
      .then((r: any) => {
        logEvent(r.ok ? "email_send_ok" : "email_send_failed", {
          requestId,
          publicId,
          to: recipientEmail,
          messageId: r.ok ? safeStr(r.messageId) : undefined,
          error: r.ok ? undefined : safeStr(r.error),
        });
      })
      .catch((e) => {
        logEvent("email_send_failed", { requestId, publicId, to: recipientEmail, error: safeStr(e?.message || e) });
      });
  });

  /* -------- GET GIFT -------- */
  app.get("/api/gifts/:publicId", async (req, res) => {
    const publicId = req.params.publicId;
    const row = (await db.select().from(gifts).where(eq(gifts.publicId, publicId)).limit(1))[0];
    if (!row) return res.status(404).json({ error: "Not found" });

    res.json({
      publicId: row.publicId,
      recipientEmail: row.recipientEmail,
      message: row.message,
      amount: row.amount,
      isClaimed: row.isClaimed,
      createdAt: row.createdAt,
      claimedAt: row.claimedAt,
    });
  });

  /* -------- CLAIM -------- */
  app.post("/api/gifts/:publicId/claim", claimGiftLimiter, async (req, res) => {
    const publicId = req.params.publicId;
    const row = (await db.select().from(gifts).where(eq(gifts.publicId, publicId)).limit(1))[0];

    if (!row) return res.status(404).json({ error: "Not found" });
    if (row.isClaimed) return res.status(409).json({ error: "Already claimed" });

    const claimedAt = new Date();
    await db.update(gifts).set({ isClaimed: true, claimedAt: claimedAt as any }).where(eq(gifts.publicId, publicId));

    res.json({ success: true, publicId: row.publicId, claimedAt: claimedAt.toISOString() });
  });

  return httpServer;
}
