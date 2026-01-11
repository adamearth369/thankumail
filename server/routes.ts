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

/* -------------------- RATE LIMITING -------------------- */
const createGiftLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientKey(req),
  handler: (req, res) => {
    logEvent("rate_limited_create_gift", { key: getClientKey(req) });
    res.status(429).json({ error: "Too many requests", route: "POST /api/gifts" });
  },
});

const claimGiftLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientKey(req),
  handler: (req, res) => {
    logEvent("rate_limited_claim_gift", { key: getClientKey(req) });
    res.status(429).json({ error: "Too many requests", route: "POST /api/gifts/:publicId/claim" });
  },
});

/* -------------------- DAILY LIMITS (IN-MEMORY) -------------------- */
/**
 * NOTE: This is per-instance memory. On Render with multiple instances, limits are per-instance.
 * For MVP, WEB_CONCURRENCY=1 is already set; this is acceptable.
 */
type DailyBucket = {
  dayKey: string; // YYYY-MM-DD (UTC)
  count: number;
};

const dailyByIp = new Map<string, DailyBucket>();
const dailyByRecipient = new Map<string, DailyBucket>();

function utcDayKey(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function bumpDaily(map: Map<string, DailyBucket>, key: string, limit: number) {
  const today = utcDayKey();
  const existing = map.get(key);

  if (!existing || existing.dayKey !== today) {
    const next: DailyBucket = { dayKey: today, count: 1 };
    map.set(key, next);
    return { ok: true as const, count: next.count, limit, dayKey: today };
  }

  if (existing.count >= limit) {
    return { ok: false as const, count: existing.count, limit, dayKey: today };
  }

  existing.count += 1;
  return { ok: true as const, count: existing.count, limit, dayKey: today };
}

function getDailyCount(map: Map<string, DailyBucket>, key: string) {
  const today = utcDayKey();
  const b = map.get(key);
  if (!b || b.dayKey !== today) return 0;
  return b.count;
}

const DAILY_IP_LIMIT = Number(process.env.DAILY_IP_LIMIT || "40") || 40;
const DAILY_RECIPIENT_LIMIT = Number(process.env.DAILY_RECIPIENT_LIMIT || "8") || 8;

/* -------------------- DISPOSABLE EMAIL BLOCK -------------------- */
const DISPOSABLE_BLOCK_ENABLED = (process.env.DISPOSABLE_BLOCK_ENABLED || "true").toLowerCase() !== "false";
const BLOCKED_DOMAINS = new Set<string>([
  "mailinator.com",
  "guerrillamail.com",
  "10minutemail.com",
  "tempmail.com",
  "yopmail.com",
  "trashmail.com",
  "getnada.com",
  "maildrop.cc",
  "minuteinbox.com",
  "dispostable.com",
]);

function getEmailDomain(email: string) {
  const s = (email || "").trim().toLowerCase();
  const at = s.lastIndexOf("@");
  if (at < 0) return "";
  return s.slice(at + 1);
}

function isDisposableEmail(email: string) {
  if (!DISPOSABLE_BLOCK_ENABLED) return false;
  const d = getEmailDomain(email);
  if (!d) return false;
  return BLOCKED_DOMAINS.has(d);
}

/* -------------------- SEED -------------------- */
async function seed() {
  try {
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
  } catch (e: any) {
    logEvent("seed_error", { error: safeStr(e?.message || e) });
  }
}

/* -------------------- SCHEMAS -------------------- */
const CreateGiftSchema = z.object({
  recipientEmail: z.string().email(),
  message: z.string().min(1).max(1000),
  amount: z.number().int().min(1000),
});

/* ==================== ROUTES ==================== */
export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  await seed();

  /* -------- HEALTH -------- */
  app.get(["/health", "/__health", "/api/health"], (_req, res) => {
    res.json({
      ok: true,
      routesMarker: "ROUTES_MARKER_v14_daily_limits_admin_status",
      gitCommit: process.env.RENDER_GIT_COMMIT || "",
      serviceId: process.env.RENDER_SERVICE_ID || "",
    });
  });

  /* -------- ADMIN STATUS (NO SECRETS) -------- */
  app.get("/api/admin/status", (req, res) => {
    const key = getClientKey(req);
    const ipCount = getDailyCount(dailyByIp, key);

    res.json({
      ok: true,
      env: {
        NODE_ENV: process.env.NODE_ENV || "",
        PUBLIC_BASE_URL: Boolean(process.env.PUBLIC_BASE_URL),
        BASE_URL: Boolean(process.env.BASE_URL),
        FROM_EMAIL: Boolean(process.env.FROM_EMAIL),
        BREVO_API_KEY: Boolean(process.env.BREVO_API_KEY),
      },
      email: {
        provider: "brevo",
        configured: Boolean(process.env.FROM_EMAIL && process.env.BREVO_API_KEY),
        disposableBlockEnabled: DISPOSABLE_BLOCK_ENABLED,
        blockedDomainsCount: BLOCKED_DOMAINS.size,
      },
      limits: {
        dailyIpLimit: DAILY_IP_LIMIT,
        dailyRecipientLimit: DAILY_RECIPIENT_LIMIT,
        todayUtc: utcDayKey(),
      },
      counters: {
        thisIpToday: ipCount,
      },
      uptimeSec: Math.floor(process.uptime()),
    });
  });

  /* -------- CREATE GIFT -------- */
  app.post("/api/gifts", createGiftLimiter, async (req, res) => {
    const requestId = safeStr(req.headers["x-request-id"] || req.headers["cf-ray"] || "");
    const started = Date.now();

    logEvent("gift_create_start", { requestId, key: getClientKey(req) });

    const parsed = CreateGiftSchema.safeParse(req.body);
    if (!parsed.success) {
      logEvent("gift_create_validation_failed", { requestId, issues: parsed.error.issues });
      return res.status(400).json({ error: "Invalid payload", issues: parsed.error.issues });
    }

    const { recipientEmail, message, amount } = parsed.data;

    // Disposable email block
    if (isDisposableEmail(recipientEmail)) {
      logEvent("gift_create_disposable_blocked", { requestId, recipientEmail });
      return res.status(400).json({ error: "Disposable email addresses are not allowed", field: "recipientEmail" });
    }

    // Daily limits: per-IP
    const ipKey = getClientKey(req);
    const ipBump = bumpDaily(dailyByIp, ipKey, DAILY_IP_LIMIT);
    if (!ipBump.ok) {
      logEvent("daily_limit_ip_hit", { requestId, key: ipKey, count: ipBump.count, limit: ipBump.limit });
      return res.status(429).json({ error: "Daily limit reached", field: "ip" });
    }

    // Daily limits: per-recipient email
    const recipientKey = recipientEmail.trim().toLowerCase();
    const recBump = bumpDaily(dailyByRecipient, recipientKey, DAILY_RECIPIENT_LIMIT);
    if (!recBump.ok) {
      logEvent("daily_limit_recipient_hit", {
        requestId,
        recipientEmail: recipientKey,
        count: recBump.count,
        limit: recBump.limit,
      });
      return res.status(429).json({ error: "Daily limit reached", field: "recipientEmail" });
    }

    const publicId = crypto.randomBytes(6).toString("hex");
    const claimAbs = `${getBaseUrl(req)}/claim/${publicId}`;

    await db.insert(gifts).values({
      publicId,
      recipientEmail,
      message,
      amount,
      isClaimed: false,
    });

    logEvent("gift_create_db_insert_ok", { requestId, publicId, ms: Date.now() - started });

    // Respond immediately
    res.json({
      success: true,
      giftId: publicId,
      claimLink: `/claim/${publicId}`,
      email: { ok: true },
    });

    // Email in background with timeout
    (async () => {
      const emailStarted = Date.now();
      try {
        const info = await withTimeout(
          sendGiftEmail({
            to: recipientEmail,
            claimLink: claimAbs,
            message,
            amountCents: amount,
          }),
          10_000,
          "sendGiftEmail",
        );

        if ((info as any)?.ok) {
          logEvent("email_send_ok", {
            requestId,
            publicId,
            to: recipientEmail,
            messageId: safeStr((info as any)?.messageId),
            ms: Date.now() - emailStarted,
          });
        } else {
          logEvent("email_send_failed", {
            requestId,
            publicId,
            to: recipientEmail,
            error: safeStr((info as any)?.error || "unknown_email_error"),
            ms: Date.now() - emailStarted,
          });
        }
      } catch (e: any) {
        logEvent("email_send_failed", {
          requestId,
          publicId,
          to: recipientEmail,
          error: safeStr(e?.message || e),
          ms: Date.now() - emailStarted,
        });
      }
    })().catch((e) => logEvent("email_bg_task_crash", { requestId, publicId, error: safeStr(e?.message || e) }));

    return;
  });

  /* -------- GET GIFT -------- */
  app.get("/api/gifts/:publicId", async (req, res) => {
    const requestId = safeStr(req.headers["x-request-id"] || req.headers["cf-ray"] || "");
    const publicId = req.params.publicId;

    try {
      const row = (
        await db.select().from(gifts).where(eq(gifts.publicId, publicId)).limit(1)
      )[0] as any;

      if (!row) {
        logEvent("gift_get_not_found", { requestId, publicId });
        return res.status(404).json({ error: "Not found" });
      }

      logEvent("gift_get_ok", { requestId, publicId, isClaimed: row.isClaimed });

      res.json({
        id: row.id,
        publicId: row.publicId,
        recipientEmail: row.recipientEmail,
        message: row.message,
        amount: row.amount,
        isClaimed: row.isClaimed,
        createdAt: row.createdAt,
        claimedAt: row.claimedAt,
      });
    } catch (e: any) {
      logEvent("gift_get_error", { requestId, publicId, error: safeStr(e?.message || e) });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  /* -------- CLAIM -------- */
  app.post("/api/gifts/:publicId/claim", claimGiftLimiter, async (req, res) => {
    const requestId = safeStr(req.headers["x-request-id"] || req.headers["cf-ray"] || "");
    const publicId = req.params.publicId;

    logEvent("claim_attempt", { requestId, publicId, key: getClientKey(req) });

    try {
      const row = (
        await db.select().from(gifts).where(eq(gifts.publicId, publicId)).limit(1)
      )[0] as any;

      if (!row) {
        logEvent("claim_not_found", { requestId, publicId });
        return res.status(404).json({ error: "Not found" });
      }
      if (row.isClaimed) {
        logEvent("claim_already_claimed", { requestId, publicId });
        return res.status(409).json({ error: "Already claimed" });
      }

      const claimedAt = new Date();
      await db
        .update(gifts)
        .set({ isClaimed: true, claimedAt: claimedAt as any })
        .where(eq(gifts.publicId, publicId));

      logEvent("claim_success", { requestId, publicId, amount: row.amount });

      res.json({ success: true, publicId: row.publicId, claimedAt: claimedAt.toISOString() });
    } catch (e: any) {
      logEvent("claim_error", { requestId, publicId, error: safeStr(e?.message || e) });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return httpServer;
}
