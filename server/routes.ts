// WHERE TO PASTE: server/routes.ts
// ACTION: Full file replacement (paste exactly)

import type { Express, Request } from "express";
import { createServer, type Server } from "http";
import crypto from "crypto";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { eq, and, gte, asc, lte, isNull } from "drizzle-orm";

import { db } from "./db";
import { gifts } from "@shared/schema";
import { sendGiftEmail, sendReminderEmail, sendReturnToSenderEmail } from "./email";
import { sendGiftSms } from "./sms";

/* -------------------- VERSION -------------------- */
const VERSION = "routes_v2026-02-02_003";
const COMMIT = process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || "";

/* -------------------- ROUTES MARKER -------------------- */
const ROUTES_MARKER = "locked_gap_no_override_v1_plus_timewarp";

/* -------------------- REMINDER SENDING -------------------- */
const REMINDER_SENDING_ENABLED = (process.env.REMINDER_SENDING_ENABLED || "true").toLowerCase() !== "false";

/* -------------------- TESTING ADMIN TOOLS -------------------- */
const ENABLE_TESTING_ADMIN_TOOLS = (process.env.ENABLE_TESTING_ADMIN_TOOLS || "").toLowerCase() === "true";

/* -------------------- STRUCTURED LOGGING -------------------- */
function logEvent(event: string, fields: Record<string, any> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}
function safeStr(v: any) {
  return typeof v === "string" ? v : "";
}
function toMs(d: any) {
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime();
  return Number.isFinite(t) ? t : 0;
}

/* -------------------- CLAIM SITE BASE URL -------------------- */
function getClaimSiteBaseUrl(req: Request) {
  const env = process.env.PUBLIC_SITE_URL || process.env.PUBLIC_CLAIM_BASE_URL || "";
  if (env) return env.replace(/\/+$/, "");

  // hard fallback to the real public site (prevents api.thankumail.com/claim links)
  const hard = "https://thankumail.com";
  if (hard) return hard.replace(/\/+$/, "");

  const proto = (req.headers["x-forwarded-proto"] || "https").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return `${proto}://${host}`.replace(/\/+$/, "");
}

/* -------------------- IP -------------------- */
function getClientIp(req: Request) {
  const cf = safeStr(req.headers["cf-connecting-ip"]);
  if (cf) return cf;
  const xff = safeStr(req.headers["x-forwarded-for"]);
  if (xff) return xff.split(",")[0].trim();
  return safeStr((req.socket as any)?.remoteAddress);
}

/* -------------------- TURNSTILE -------------------- */
async function verifyTurnstile(token: string, req: Request) {
  const secret = process.env.TURNSTILE_SECRET_KEY || "";
  const bypass = (process.env.TURNSTILE_BYPASS || "").toLowerCase() === "true";

  if (!secret) return { ok: true, mode: "not_configured" as const, codes: [] as string[] };
  if (bypass) return { ok: true, mode: "bypass" as const, codes: [] as string[] };
  if (!token) return { ok: false, mode: "enforced" as const, codes: ["missing-input-response"] as string[] };

  const ip = getClientIp(req);

  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", token);
  if (ip) form.set("remoteip", ip);

  const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  const json: any = await resp.json().catch(() => ({}));
  const ok = !!json?.success;
  const codes: string[] = Array.isArray(json?.["error-codes"]) ? json["error-codes"] : [];
  return { ok, mode: "enforced" as const, codes };
}

/* -------------------- HELPERS -------------------- */
function newPublicId() {
  return crypto.randomBytes(16).toString("hex");
}
function isE164(s: string) {
  return /^\+[1-9]\d{7,14}$/.test(String(s || "").trim());
}
function isEmail(s: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
}

/* -------------------- VALIDATION -------------------- */
const CreateGiftSchema = z.object({
  senderEmail: z.string().email().optional().or(z.literal("")),
  recipientEmail: z.string().email().optional().or(z.literal("")),
  recipientPhone: z
    .string()
    .optional()
    .or(z.literal(""))
    .refine((v) => !v || isE164(v), { message: "Phone must be E.164 like +14165551234" }),
  message: z.string().min(1).max(2000),
  amount: z.number().int().min(1000).max(100000),
  turnstileToken: z.string().optional().or(z.literal("")),
  debugBypassLimits: z.string().optional().or(z.literal("")),
});

const ClaimSchema = z.object({
  turnstileToken: z.string().optional().or(z.literal("")),
});

const AdminRemindersSchema = z.object({
  dryRun: z.boolean().optional().default(true),
  limit: z.number().int().min(1).max(500).optional().default(25),

  // locked behavior: >= 1 minute only
  olderThanMinutes: z.number().int().min(1).max(24 * 365 * 60).optional(),
  olderThanHours: z.number().int().min(0).max(24 * 365).optional().default(24),

  // NOTE: gap override intentionally removed/ignored in this locked version
  publicId: z.string().optional(),
});

const AdminGiftResetSchema = z.object({
  publicId: z.string().min(1),
});

const AdminGiftSeedSchema = z.object({
  senderEmail: z.string().email().optional().or(z.literal("")),
  recipientEmail: z.string().email().optional().or(z.literal("")),
  recipientPhone: z
    .string()
    .optional()
    .or(z.literal(""))
    .refine((v) => !v || isE164(v), { message: "Phone must be E.164 like +14165551234" }),
  message: z.string().min(1).max(2000),
  amount: z.number().int().min(1000).max(100000),
  markClaimed: z.boolean().optional().default(false),
});

const AdminAdvanceReminderTimeSchema = z.object({
  publicId: z.string().min(1),
});

/* -------------------- LIMITERS -------------------- */
const createGiftLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});
const claimLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

/* -------------------- DUPLICATE WINDOW -------------------- */
const SMS_DUPLICATE_WINDOW_SEC = Math.max(10, Number(process.env.SMS_DUPLICATE_WINDOW_SEC || 90));

/* -------------------- DAILY LIMITS (24h) -------------------- */
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DAILY_LIMIT_IP = Math.max(0, Number(process.env.DAILY_LIMIT_IP || 10));
const DAILY_LIMIT_SENDER = Math.max(0, Number(process.env.DAILY_LIMIT_SENDER || 5));
const DAILY_LIMIT_PHONE = Math.max(0, Number(process.env.DAILY_LIMIT_PHONE || 3));

async function enforceDailyLimit(opts: { kind: "sender" | "phone"; value: string; limit: number }) {
  const { kind, value, limit } = opts;
  if (!limit || limit <= 0) return { ok: true as const };

  const cutoff = new Date(Date.now() - DAILY_WINDOW_MS);

  let col: any = null;
  if (kind === "sender") col = (gifts as any).senderEmail;
  if (kind === "phone") col = (gifts as any).recipientPhone;
  if (!col) return { ok: true as const };

  const rows = await db
    .select({ createdAt: gifts.createdAt })
    .from(gifts)
    .where(and(eq(col, value), gte(gifts.createdAt, cutoff)))
    .orderBy(asc(gifts.createdAt));

  const count = rows?.length || 0;
  if (count < limit) return { ok: true as const, count };

  const oldestMs = toMs(rows?.[0]?.createdAt);
  const retryAfterSec = oldestMs ? Math.max(1, Math.ceil((oldestMs + DAILY_WINDOW_MS - Date.now()) / 1000)) : 24 * 3600;
  return { ok: false as const, count, limit, retryAfterSec };
}

type Bucket = { count: number; windowStartMs: number };
const ipBucket = new Map<string, Bucket>();

function enforceIpDailyLimit(ip: string, limit: number) {
  if (!limit || limit <= 0) return { ok: true as const };

  const key = ip || "unknown";
  const now = Date.now();
  const b = ipBucket.get(key);

  if (!b || now - b.windowStartMs >= DAILY_WINDOW_MS) {
    ipBucket.set(key, { count: 1, windowStartMs: now });
    return { ok: true as const, count: 1 };
  }

  if (b.count >= limit) {
    const retryAfterSec = Math.max(1, Math.ceil((b.windowStartMs + DAILY_WINDOW_MS - now) / 1000));
    return { ok: false as const, count: b.count, limit, retryAfterSec };
  }

  b.count += 1;
  ipBucket.set(key, b);
  return { ok: true as const, count: b.count };
}

function canBypassLimits(parsedBody: any) {
  const secret = safeStr(process.env.DEBUG_BYPASS_LIMITS_SECRET || "");
  if (!secret) return false;
  const token = safeStr(parsedBody?.debugBypassLimits || "").trim();
  return token && token === secret;
}

/* -------------------- ADMIN AUTH -------------------- */
function requireAdmin(req: Request) {
  const expected = safeStr(process.env.ADMIN_TOKEN || "");
  if (!expected) return { ok: false as const, status: 500, error: "ADMIN_TOKEN not configured" };

  const got = safeStr(req.headers["x-admin-token"]).trim();
  if (!got || got !== expected) return { ok: false as const, status: 401, error: "Unauthorized" };

  return { ok: true as const };
}

/* -------------------- REMINDERS POLICY -------------------- */
const DEFAULT_REMINDER_GAP_MS = 2 * 24 * 60 * 60 * 1000; // 48h
const REMINDER_MAX = 3;

function getReminderGapMs() {
  const raw = Number(process.env.REMINDER_INTERVAL_MS || 0);
  return raw > 0 ? raw : DEFAULT_REMINDER_GAP_MS;
}

/* -------------------- CORS (thankumail.com -> api.thankumail.com) -------------------- */
function isAllowedOrigin(origin: string) {
  if (!origin) return false;
  if (origin === "https://thankumail.com") return true;
  if (origin === "https://www.thankumail.com") return true;
  if (/^https?:\/\/localhost:\d+$/.test(origin)) return true;
  if (/^https?:\/\/127\.0\.0\.1:\d+$/.test(origin)) return true;
  return false;
}

function corsForApi(req: Request, res: any) {
  const origin = safeStr(req.headers.origin);
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-token");
    res.setHeader("Access-Control-Max-Age", "600");
  }
}

/* -------------------- BACKGROUND DELIVERY -------------------- */
function queueGiftDelivery(opts: {
  req: Request;
  publicId: string;
  claimUrl: string;
  amount: number;
  senderEmail: string | null;
  recipientEmail: string;
  recipientPhone: string;
  message: string;
}) {
  const { req, publicId, claimUrl, amount, senderEmail, recipientEmail, recipientPhone, message } = opts;

  void (async () => {
    const start = Date.now();
    logEvent("gift_delivery_start", {
      publicId,
      hasEmail: !!recipientEmail,
      hasPhone: !!recipientPhone,
      toEmailDomain: recipientEmail ? recipientEmail.split("@")[1] || "" : "",
      toPhone: recipientPhone ? recipientPhone.slice(0, 4) + "…" : "",
    });

    let emailOk: boolean | null = null;
    let smsOk: boolean | null = null;
    let emailErr = "";
    let smsErr = "";

    if (recipientEmail) {
      try {
        const emailRes = await sendGiftEmail({
          to: recipientEmail,
          publicId,
          claimUrl,
          amountCents: amount,
          senderEmail: senderEmail || undefined,
          message,
        } as any);

        if (!emailRes.ok) {
          emailOk = false;
          emailErr = safeStr((emailRes as any).error) || "Email failed";
          logEvent("gift_email_send_failed", { publicId, err: emailErr });
        } else {
          emailOk = true;
          logEvent("gift_email_send_ok", { publicId, toDomain: recipientEmail.split("@")[1] || "" });
        }
      } catch (e: any) {
        emailOk = false;
        emailErr = safeStr(e?.message) || "Email failed";
        logEvent("gift_email_send_error", { publicId, err: emailErr });
      }
    }

    if (recipientPhone) {
      try {
        const smsRes: any = await sendGiftSms({
          to: recipientPhone,
          publicId,
          claimUrl,
          amountCents: amount,
          senderEmail: senderEmail || undefined,
          message,
        } as any);

        if (!smsRes.ok) {
          smsOk = false;
          smsErr = safeStr(smsRes?.error) || "SMS failed";
          logEvent("gift_sms_send_failed", { publicId, err: smsErr });
        } else {
          smsOk = true;
          logEvent("gift_sms_send_ok", { publicId });
        }
      } catch (e: any) {
        smsOk = false;
        smsErr = safeStr(e?.message) || "SMS failed";
        logEvent("gift_sms_send_error", { publicId, err: smsErr });
      }
    }

    logEvent("gift_delivery_done", {
      publicId,
      emailOk,
      smsOk,
      tookMs: Date.now() - start,
      origin: safeStr(req.headers.origin),
    });
  })().catch((e: any) => {
    logEvent("gift_delivery_fatal", { publicId, err: safeStr(e?.message) });
  });
}

/* -------------------- ROUTES -------------------- */
export function registerRoutes(app: Express): Server {
  app.use("/api", (req: Request, res: any, next: any) => {
    corsForApi(req, res);
    if (req.method === "OPTIONS") return res.status(204).end();
    return next();
  });

  app.get("/api/health", (_req, res) => res.json({ ok: true, version: VERSION, commit: COMMIT }));

  app.get("/api/version", (_req, res) => {
    const bypass = (process.env.TURNSTILE_BYPASS || "").toLowerCase() === "true";
    const configured = !!(process.env.TURNSTILE_SECRET_KEY || "");
    const mode = !configured ? "not_configured" : bypass ? "bypass" : "enforced";
    const gapMs = getReminderGapMs();

    return res.json({
      ok: true,
      version: VERSION,
      commit: COMMIT,
      env: process.env.NODE_ENV || "",
      minClaimDelaySec: Math.max(0, Number(process.env.MIN_CLAIM_DELAY_SEC || 60)),
      smsDuplicateWindowSec: SMS_DUPLICATE_WINDOW_SEC,
      dailyLimitIp: DAILY_LIMIT_IP,
      dailyLimitSender: DAILY_LIMIT_SENDER,
      dailyLimitPhone: DAILY_LIMIT_PHONE,
      turnstileMode: mode,
      turnstileBypass: bypass,
      turnstileConfigured: configured,
      debugBypassLimitsConfigured: !!process.env.DEBUG_BYPASS_LIMITS_SECRET,
      remindersRoute: true,
      reminderGapMs: gapMs,
      reminderGapConfigured: !!process.env.REMINDER_INTERVAL_MS,
      reminderMax: REMINDER_MAX,
      getGiftRoute: true,
      reminderSendingEnabled: REMINDER_SENDING_ENABLED,
      routesMarker: ROUTES_MARKER,
      testingAdminToolsEnabled: ENABLE_TESTING_ADMIN_TOOLS,
    });
  });

  /* -------------------- ADMIN: GIFTS RESET (FAST TESTING) -------------------- */
  app.post("/api/admin/gifts/reset", async (req, res) => {
    const auth = requireAdmin(req);
    if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error, version: VERSION, commit: COMMIT });

    const parsed = AdminGiftResetSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ ok: false, error: "Invalid payload", issues: parsed.error.issues, version: VERSION, commit: COMMIT });
    }

    const publicId = safeStr(parsed.data.publicId).trim();
    try {
      const rows: any[] = await db.select().from(gifts).where(eq(gifts.publicId, publicId));
      const gift = rows?.[0];
      if (!gift) return res.status(404).json({ ok: false, error: "Not found", version: VERSION, commit: COMMIT });

      await db
        .update(gifts)
        .set({
          isClaimed: false,
          claimedAt: null,
          reminderCount: 0,
          lastReminderSentAt: null,
          returnedToSenderAt: null,
        } as any)
        .where(eq(gifts.publicId, publicId));

      logEvent("admin_gift_reset", { publicId });

      return res.json({ ok: true, publicId, version: VERSION, commit: COMMIT });
    } catch (e: any) {
      logEvent("admin_gift_reset_error", { publicId, err: safeStr(e?.message) });
      return res.status(500).json({ ok: false, error: "Server error", version: VERSION, commit: COMMIT });
    }
  });

  /* -------------------- ADMIN: ADVANCE lastReminderSentAt BACKWARDS (SAFE TESTING-ONLY) -------------------- */
  app.post("/api/admin/gifts/advance-reminder-time", async (req, res) => {
    const auth = requireAdmin(req);
    if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error, version: VERSION, commit: COMMIT });

    if (!ENABLE_TESTING_ADMIN_TOOLS) {
      return res.status(403).json({
        ok: false,
        error: "Testing admin tools disabled",
        code: "TESTING_TOOLS_DISABLED",
        version: VERSION,
        commit: COMMIT,
      });
    }

    const parsed = AdminAdvanceReminderTimeSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ ok: false, error: "Invalid payload", issues: parsed.error.issues, version: VERSION, commit: COMMIT });
    }

    const publicId = safeStr(parsed.data.publicId).trim();
    try {
      const rows: any[] = await db.select().from(gifts).where(eq(gifts.publicId, publicId));
      const gift = rows?.[0];
      if (!gift) return res.status(404).json({ ok: false, error: "Not found", version: VERSION, commit: COMMIT });

      if (gift.isClaimed) {
        return res.status(409).json({ ok: false, error: "Already claimed", code: "ALREADY_CLAIMED", version: VERSION, commit: COMMIT });
      }
      if (gift.returnedToSenderAt) {
        return res.status(409).json({
          ok: false,
          error: "Already returned to sender",
          code: "ALREADY_RETURNED",
          version: VERSION,
          commit: COMMIT,
        });
      }
      const reminderCount = Number(gift.reminderCount || 0);
      if (reminderCount >= REMINDER_MAX) {
        return res.status(409).json({
          ok: false,
          error: "Reminder max already reached",
          code: "REMINDER_MAX_REACHED",
          version: VERSION,
          commit: COMMIT,
        });
      }

      // Move lastReminderSentAt far enough into the past so the NEXT reminder is eligible immediately,
      // without changing/overriding the configured gap.
      const gapMs = getReminderGapMs();
      const newLast = new Date(Date.now() - gapMs - 2_000);

      await db
        .update(gifts)
        .set({ lastReminderSentAt: newLast } as any)
        .where(and(eq(gifts.publicId, publicId), eq(gifts.isClaimed, false), isNull((gifts as any).returnedToSenderAt)));

      logEvent("admin_advance_reminder_time", { publicId, reminderCount, newLast: newLast.toISOString(), gapMs });

      return res.json({
        ok: true,
        publicId,
        reminderCount,
        lastReminderSentAt: newLast.toISOString(),
        gapMs,
        version: VERSION,
        commit: COMMIT,
      });
    } catch (e: any) {
      logEvent("admin_advance_reminder_time_error", { publicId, err: safeStr(e?.message) });
      return res.status(500).json({ ok: false, error: "Server error", version: VERSION, commit: COMMIT });
    }
  });

  /* -------------------- ADMIN: GIFTS SEED (FAST TESTING, NO TURNSTILE) -------------------- */
  app.post("/api/admin/gifts/seed", async (req, res) => {
    const auth = requireAdmin(req);
    if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error, version: VERSION, commit: COMMIT });

    const parsed = AdminGiftSeedSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ ok: false, error: "Invalid payload", issues: parsed.error.issues, version: VERSION, commit: COMMIT });
    }

    const senderEmail = safeStr(parsed.data.senderEmail).trim() || null;
    const recipientEmail = safeStr(parsed.data.recipientEmail).trim();
    const recipientPhone = safeStr(parsed.data.recipientPhone).trim();
    const message = safeStr(parsed.data.message);
    const amount = Number(parsed.data.amount);
    const markClaimed = !!parsed.data.markClaimed;

    if (!recipientEmail && !recipientPhone) {
      return res
        .status(400)
        .json({ ok: false, error: "Provide a recipient email or phone", field: "recipient", version: VERSION, commit: COMMIT });
    }
    if (recipientPhone && !isE164(recipientPhone)) {
      return res.status(400).json({
        ok: false,
        error: "Phone must be E.164 like +14165551234",
        field: "recipientPhone",
        version: VERSION,
        commit: COMMIT,
      });
    }
    if (recipientEmail && !isEmail(recipientEmail)) {
      return res
        .status(400)
        .json({ ok: false, error: "Invalid recipient email", field: "recipientEmail", version: VERSION, commit: COMMIT });
    }

    const publicId = newPublicId();
    const claimUrl = `${getClaimSiteBaseUrl(req)}/claim/${publicId}`;
    const now = new Date();

    try {
      await db.insert(gifts).values({
        publicId,
        senderEmail,
        recipientEmail: recipientEmail || null,
        recipientPhone: recipientPhone || null,
        message,
        amount,
        isClaimed: markClaimed,
        reminderCount: 0,
        lastReminderSentAt: null,
        returnedToSenderAt: null,
        claimedAt: markClaimed ? now : null,
      } as any);

      logEvent("admin_gift_seeded", { publicId, markClaimed });

      return res.json({
        ok: true,
        publicId,
        claimUrl,
        amount,
        seeded: true,
        markClaimed,
        version: VERSION,
        commit: COMMIT,
      });
    } catch (e: any) {
      logEvent("gift_seed_error", { err: safeStr(e?.message) });
      return res.status(500).json({ ok: false, error: "Server error", version: VERSION, commit: COMMIT });
    }
  });

  /* -------------------- ADMIN: REMINDERS (TARGETABLE) -------------------- */
  app.post("/api/admin/reminders/send", async (req, res) => {
    const auth = requireAdmin(req);
    if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error, version: VERSION, commit: COMMIT });

    const parsed = AdminRemindersSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ ok: false, error: "Invalid payload", issues: parsed.error.issues, version: VERSION, commit: COMMIT });
    }

    const dryRun = !!parsed.data.dryRun;
    const limit = Number(parsed.data.limit) || 25;

    const olderThanMinutesRaw = typeof parsed.data.olderThanMinutes === "number" ? Number(parsed.data.olderThanMinutes) : null;
    const olderThanHoursRaw = typeof parsed.data.olderThanHours === "number" ? Number(parsed.data.olderThanHours) : 24;

    const olderThanMs =
      olderThanMinutesRaw !== null ? Math.max(0, olderThanMinutesRaw) * 60_000 : Math.max(0, olderThanHoursRaw) * 3600_000;

    const targetPublicId = safeStr(parsed.data.publicId).trim();

    const now = Date.now();
    const cutoff = new Date(now - olderThanMs);

    const gapMs = getReminderGapMs();

    try {
      let candidates: any[] = [];

      if (targetPublicId) {
        const rows: any[] = await db
          .select()
          .from(gifts)
          .where(and(eq(gifts.publicId, targetPublicId), eq(gifts.isClaimed, false), isNull((gifts as any).returnedToSenderAt)));
        candidates = rows || [];
      } else {
        const rows: any[] = await db
          .select()
          .from(gifts)
          .where(and(eq(gifts.isClaimed, false), isNull((gifts as any).returnedToSenderAt), lte(gifts.createdAt, cutoff)))
          .orderBy(asc(gifts.createdAt))
          .limit(limit);
        candidates = rows || [];
      }

      const scanned = candidates.length;

      let eligible = 0;
      let willRemind = 0;
      let willReturn = 0;

      const toRemind: any[] = [];
      const toReturn: any[] = [];

      for (const g of candidates) {
        const publicId = safeStr(g?.publicId);
        if (!publicId) continue;

        const reminderCount = Number(g?.reminderCount || 0);
        const lastSentMs = toMs(g?.lastReminderSentAt);
        const gapOk = !lastSentMs || now - lastSentMs >= gapMs;

        if (reminderCount >= REMINDER_MAX) {
          willReturn += 1;
          toReturn.push(g);
          continue;
        }

        if (gapOk) {
          eligible += 1;
          willRemind += 1;
          toRemind.push(g);
        }
      }

      logEvent("reminders_scan", {
        dryRun,
        scanned,
        eligible,
        willRemind,
        willReturn,
        cutoff: cutoff.toISOString(),
        olderThanMs,
        gapMs,
        olderThanMinutes: olderThanMinutesRaw !== null ? olderThanMinutesRaw : undefined,
        olderThanHours: olderThanMinutesRaw === null ? olderThanHoursRaw : undefined,
        targetPublicId: targetPublicId || undefined,
        sendingEnabled: REMINDER_SENDING_ENABLED,
      });

      if (dryRun) {
        return res.json({
          ok: true,
          dryRun: true,
          scanned,
          eligible,
          willRemind,
          willReturn,
          sendFailed: 0,
          skippedNoRecipientEmail: 0,
          skippedSendingDisabled: REMINDER_SENDING_ENABLED ? 0 : willRemind,
          cutoff: cutoff.toISOString(),
          olderThanMs,
          gapMs,
          reminderMax: REMINDER_MAX,
          targetPublicId: targetPublicId || undefined,
          version: VERSION,
          commit: COMMIT,
        });
      }

      let reminded = 0;
      let returned = 0;
      let sendFailed = 0;
      let skippedNoRecipientEmail = 0;
      let skippedSendingDisabled = 0;

      for (const g of toRemind) {
        const publicId = safeStr(g?.publicId);
        if (!publicId) continue;

        const recipientEmail = safeStr(g?.recipientEmail).trim();
        const senderEmail = safeStr(g?.senderEmail).trim();
        const amount = Number(g?.amount || 0);
        const claimUrl = `${getClaimSiteBaseUrl(req)}/claim/${publicId}`;

        if (!isEmail(recipientEmail)) {
          skippedNoRecipientEmail += 1;
          logEvent("reminder_skipped_no_recipient_email", { publicId });
          continue;
        }

        if (!REMINDER_SENDING_ENABLED) {
          skippedSendingDisabled += 1;
          logEvent("reminder_skipped_sending_disabled", { publicId });
          continue;
        }

        const r = await sendReminderEmail({
          to: recipientEmail,
          publicId,
          claimUrl,
          amountCents: amount,
          senderEmail: isEmail(senderEmail) ? senderEmail : undefined,
        });

        if (!r.ok) {
          sendFailed += 1;
          logEvent("reminder_send_failed", { publicId, err: safeStr((r as any)?.error) });
          continue;
        }

        logEvent("reminder_send_ok", { publicId, toDomain: recipientEmail.split("@")[1] || "" });

        const nextCount = Number(g?.reminderCount || 0) + 1;

        await db
          .update(gifts)
          .set({ reminderCount: nextCount, lastReminderSentAt: new Date() } as any)
          .where(and(eq(gifts.publicId, publicId), eq(gifts.isClaimed, false), isNull((gifts as any).returnedToSenderAt)));

        reminded += 1;
        logEvent("reminder_marked", { publicId, reminderCount: nextCount });

        if (nextCount >= REMINDER_MAX) {
          await db
            .update(gifts)
            .set({ returnedToSenderAt: new Date() } as any)
            .where(and(eq(gifts.publicId, publicId), eq(gifts.isClaimed, false), isNull((gifts as any).returnedToSenderAt)));

          returned += 1;
          logEvent("returned_to_sender_marked_after_final_reminder", { publicId });

          if (isEmail(senderEmail)) {
            const rr = await sendReturnToSenderEmail({
              to: senderEmail,
              publicId,
              amountCents: amount,
              reason: "Unclaimed after 3 reminders",
            });

            if (!rr.ok) {
              sendFailed += 1;
              logEvent("return_to_sender_email_failed", { publicId, err: safeStr((rr as any)?.error) });
            } else {
              logEvent("return_to_sender_email_ok", { publicId, toDomain: senderEmail.split("@")[1] || "" });
            }
          }
        }
      }

      for (const g of toReturn) {
        const publicId = safeStr(g?.publicId);
        if (!publicId) continue;

        const senderEmail = safeStr(g?.senderEmail).trim();
        const amount = Number(g?.amount || 0);

        await db
          .update(gifts)
          .set({ returnedToSenderAt: new Date() } as any)
          .where(and(eq(gifts.publicId, publicId), eq(gifts.isClaimed, false), isNull((gifts as any).returnedToSenderAt)));

        returned += 1;
        logEvent("returned_to_sender_marked", { publicId });

        if (REMINDER_SENDING_ENABLED && isEmail(senderEmail)) {
          const r = await sendReturnToSenderEmail({
            to: senderEmail,
            publicId,
            amountCents: amount,
            reason: "Unclaimed after 3 reminders",
          });

          if (!r.ok) {
            sendFailed += 1;
            logEvent("return_to_sender_email_failed", { publicId, err: safeStr((r as any)?.error) });
          } else {
            logEvent("return_to_sender_email_ok", { publicId, toDomain: senderEmail.split("@")[1] || "" });
          }
        }
      }

      return res.json({
        ok: true,
        dryRun: false,
        scanned,
        eligible,
        reminded,
        returned,
        sendFailed,
        skippedNoRecipientEmail,
        skippedSendingDisabled,
        cutoff: cutoff.toISOString(),
        olderThanMs,
        gapMs,
        reminderMax: REMINDER_MAX,
        targetPublicId: targetPublicId || undefined,
        version: VERSION,
        commit: COMMIT,
      });
    } catch (e: any) {
      logEvent("reminders_error", { err: safeStr(e?.message) });
      return res.status(500).json({ ok: false, error: "Server error", version: VERSION, commit: COMMIT });
    }
  });

  /* -------------------- GIFTS: CREATE -------------------- */
  app.post("/api/gifts", createGiftLimiter, async (req, res) => {
    const parsed = CreateGiftSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid payload", issues: parsed.error.issues, version: VERSION, commit: COMMIT });
    }

    const ip = getClientIp(req);

    const senderEmail = safeStr(parsed.data.senderEmail).trim() || null;
    const recipientEmail = safeStr(parsed.data.recipientEmail).trim();
    const recipientPhone = safeStr(parsed.data.recipientPhone).trim();
    const message = safeStr(parsed.data.message);
    const amount = Number(parsed.data.amount);

    if (!recipientEmail && !recipientPhone) {
      return res.status(400).json({ error: "Provide a recipient email or phone", field: "recipient", version: VERSION, commit: COMMIT });
    }

    if (recipientPhone && !isE164(recipientPhone)) {
      return res.status(400).json({ error: "Phone must be E.164 like +14165551234", field: "recipientPhone", version: VERSION, commit: COMMIT });
    }

    const t = await verifyTurnstile(safeStr(parsed.data.turnstileToken), req);
    if (!t.ok) {
      const codes = t.codes || [];
      const missing = codes.includes("missing-input-response");
      return res.status(400).json({
        error: missing ? "Missing CAPTCHA token" : "CAPTCHA failed",
        field: "turnstileToken",
        codes,
        code: "TURNSTILE_FAILED",
        version: VERSION,
        commit: COMMIT,
      });
    }

    const bypassLimits = canBypassLimits(parsed.data);
    if (!bypassLimits) {
      const ipLim = enforceIpDailyLimit(ip, DAILY_LIMIT_IP);
      if (!ipLim.ok) {
        return res.status(429).json({
          error: "Daily limit reached for IP",
          code: "DAILY_LIMIT_IP",
          field: "ip",
          retryAfterSec: ipLim.retryAfterSec,
          version: VERSION,
          commit: COMMIT,
        });
      }

      try {
        if (senderEmail) {
          const lim = await enforceDailyLimit({ kind: "sender", value: senderEmail, limit: DAILY_LIMIT_SENDER });
          if (!lim.ok) {
            return res.status(429).json({
              error: "Daily limit reached for sender",
              code: "DAILY_LIMIT_SENDER",
              field: "senderEmail",
              retryAfterSec: lim.retryAfterSec,
              version: VERSION,
              commit: COMMIT,
            });
          }
        }

        if (recipientPhone) {
          const lim = await enforceDailyLimit({ kind: "phone", value: recipientPhone, limit: DAILY_LIMIT_PHONE });
          if (!lim.ok) {
            return res.status(429).json({
              error: "Daily limit reached for recipient phone",
              code: "DAILY_LIMIT_PHONE",
              field: "recipientPhone",
              retryAfterSec: lim.retryAfterSec,
              version: VERSION,
              commit: COMMIT,
            });
          }
        }
      } catch (e: any) {
        logEvent("rate_limit_check_error", { err: safeStr(e?.message) });
      }
    }

    if (recipientPhone) {
      const cutoffMs = Date.now() - SMS_DUPLICATE_WINDOW_SEC * 1000;

      try {
        let rows: any[] = [];

        try {
          rows = await db
            .select()
            .from(gifts)
            .where(and(eq((gifts as any).recipientPhone, recipientPhone), eq(gifts.message, message), eq(gifts.amount, amount), eq(gifts.isClaimed, false)));
        } catch {
          rows = [];
        }

        if ((!rows || rows.length === 0) && senderEmail) {
          rows = await db
            .select()
            .from(gifts)
            .where(and(eq((gifts as any).senderEmail, senderEmail), eq(gifts.message, message), eq(gifts.amount, amount), eq(gifts.isClaimed, false)));
        }

        const recent = (rows || [])
          .map((r: any) => ({ r, ms: toMs(r?.createdAt) }))
          .filter((x) => x.ms && x.ms >= cutoffMs)
          .sort((a, b) => b.ms - a.ms);

        const existing = recent?.[0]?.r;
        if (existing?.publicId) {
          const existingClaimUrl = `${getClaimSiteBaseUrl(req)}/claim/${existing.publicId}`;
          return res.json({
            ok: true,
            publicId: existing.publicId,
            claimUrl: existingClaimUrl,
            amount,
            deliveryOk: true,
            emailSent: false,
            smsQueued: false,
            version: VERSION,
            commit: COMMIT,
          });
        }
      } catch (e: any) {
        logEvent("sms_duplicate_check_error", { err: safeStr(e?.message) });
      }
    }

    const publicId = newPublicId();
    const claimUrl = `${getClaimSiteBaseUrl(req)}/claim/${publicId}`;

    try {
      await db.insert(gifts).values({
        publicId,
        senderEmail,
        recipientEmail: recipientEmail || null,
        recipientPhone: recipientPhone || null,
        message,
        amount,
        isClaimed: false,
        reminderCount: 0,
        lastReminderSentAt: null,
        returnedToSenderAt: null,
        claimedAt: null,
      } as any);

      const deliveryOk = true;
      const emailSent = !!recipientEmail;
      const smsQueued = !!recipientPhone;

      queueGiftDelivery({
        req,
        publicId,
        claimUrl,
        amount,
        senderEmail,
        recipientEmail,
        recipientPhone,
        message,
      });

      return res.json({
        ok: true,
        publicId,
        claimUrl,
        amount,
        deliveryOk,
        emailSent,
        smsQueued,
        version: VERSION,
        commit: COMMIT,
      });
    } catch (e: any) {
      logEvent("gift_create_error", { err: safeStr(e?.message) });
      return res.status(500).json({ error: "Server error", version: VERSION, commit: COMMIT });
    }
  });

  /* -------------------- GIFTS: GET -------------------- */
  app.get("/api/gifts/:publicId", async (req, res) => {
    const publicId = safeStr(req.params.publicId).trim();
    if (!publicId) return res.status(400).json({ error: "Invalid id", version: VERSION, commit: COMMIT });

    try {
      const rows = await db.select().from(gifts).where(eq(gifts.publicId, publicId));
      const gift = rows?.[0];
      if (!gift) return res.status(404).json({ error: "Not found", version: VERSION, commit: COMMIT });

      return res.json({
        ok: true,
        publicId: gift.publicId,
        message: gift.message,
        amount: gift.amount,
        isClaimed: gift.isClaimed,
        createdAt: gift.createdAt,
        claimedAt: gift.claimedAt,
        reminderCount: gift.reminderCount,
        lastReminderSentAt: gift.lastReminderSentAt,
        returnedToSenderAt: gift.returnedToSenderAt,
        version: VERSION,
        commit: COMMIT,
      });
    } catch (e: any) {
      logEvent("gift_get_error", { publicId, err: safeStr(e?.message) });
      return res.status(500).json({ error: "Server error", version: VERSION, commit: COMMIT });
    }
  });

  /* -------------------- GIFTS: CLAIM -------------------- */
  app.post("/api/gifts/:publicId/claim", claimLimiter, async (req, res) => {
    const publicId = safeStr(req.params.publicId).trim();
    if (!publicId) return res.status(400).json({ error: "Invalid id", version: VERSION, commit: COMMIT });

    const parsed = ClaimSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: "Invalid payload", issues: parsed.error.issues, version: VERSION, commit: COMMIT });

    const minDelaySec = Math.max(0, Number(process.env.MIN_CLAIM_DELAY_SEC || 60));

    try {
      const rows = await db.select().from(gifts).where(eq(gifts.publicId, publicId));
      const gift = rows?.[0];
      if (!gift) return res.status(404).json({ error: "Not found", version: VERSION, commit: COMMIT });

      if (gift.isClaimed) return res.status(409).json({ error: "Already claimed", code: "ALREADY_CLAIMED", version: VERSION, commit: COMMIT });

      if (gift.createdAt && minDelaySec > 0) {
        const ageMs = Date.now() - new Date(gift.createdAt).getTime();
        if (ageMs < minDelaySec * 1000) {
          const retryAfterSec = Math.ceil((minDelaySec * 1000 - ageMs) / 1000);
          return res.status(429).json({ error: "Please wait before claiming", code: "MIN_DELAY", retryAfterSec, version: VERSION, commit: COMMIT });
        }
      }

      const t = await verifyTurnstile(safeStr(parsed.data.turnstileToken), req);
      if (!t.ok) {
        const codes = t.codes || [];
        const missing = codes.includes("missing-input-response");
        return res.status(400).json({
          error: missing ? "Missing CAPTCHA token" : "CAPTCHA failed",
          field: "turnstileToken",
          codes,
          code: "TURNSTILE_FAILED",
          version: VERSION,
          commit: COMMIT,
        });
      }

      await db.update(gifts).set({ isClaimed: true, claimedAt: new Date() }).where(and(eq(gifts.publicId, publicId), eq(gifts.isClaimed, false)));
      return res.json({ ok: true, version: VERSION, commit: COMMIT });
    } catch (e: any) {
      logEvent("claim_error", { publicId, err: safeStr(e?.message) });
      return res.status(500).json({ error: "Server error", version: VERSION, commit: COMMIT });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
