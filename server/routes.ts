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
const VERSION = "routes_v2026-02-13_001";
const COMMIT = process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || "";

/* -------------------- ROUTES MARKER -------------------- */
const ROUTES_MARKER =
  "locked_scope_guest_preset_email_only_registered_custom_or_preset_min25_v1_hard_reject_guest_amount_and_message_preset7";

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

/* -------------------- AUTH (TEMP STUB FOR REGISTERED) -------------------- */
/**
 * TEMP: "registered" is indicated by header `x-user-id`.
 * Frontend does not send this yet. This allows deterministic backend gating now.
 */
function getUserId(req: Request) {
  const v = safeStr(req.headers["x-user-id"]).trim();
  return v || null;
}
function isRegistered(req: Request) {
  return !!getUserId(req);
}

/* -------------------- PRESET MESSAGES (LOCKED v1) -------------------- */
const PRESET_MESSAGES = [
  "I just wanted you to know how much you are appreciated. Thank you for being you.",
  "Your support made a bigger difference than you realize. I’m truly grateful.",
  "You showed up when it mattered most. That means everything. Thank you.",
  "Your kindness hasn’t gone unnoticed — I’m sincerely thankful for you.",
  "You mattered more in that moment than you probably realized. Thank you.",
  "What you did made a positive difference for those around you. I’m grateful. Thank you.",
  "What you did stayed with me. This is my way of saying thank you.",
];

function presetMessageById(id: number) {
  const i = Number(id);
  if (!Number.isInteger(i) || i < 1 || i > PRESET_MESSAGES.length) return null;
  return PRESET_MESSAGES[i - 1];
}

/* -------------------- CLAIM SITE BASE URL -------------------- */
function getClaimSiteBaseUrl(req: Request) {
  const env = process.env.PUBLIC_SITE_URL || process.env.PUBLIC_CLAIM_BASE_URL || "";
  if (env) return env.replace(/\/+$/, "");

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
function toInt(v: any) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
}

/* -------------------- BLOCKED EMAIL DOMAINS -------------------- */
const BLOCKED_EMAIL_DOMAINS = new Set(["domain.com", "example.com", "test.com", "mailinator.com", "10minutemail.com"]);

function isBlockedEmailDomain(email: string) {
  const e = String(email || "").trim().toLowerCase();
  const parts = e.split("@");
  if (parts.length !== 2) return false;
  const domain = parts[1].trim();
  return BLOCKED_EMAIL_DOMAINS.has(domain);
}

/* -------------------- RAW PAYLOAD GUARD (DEFENSE-IN-DEPTH) -------------------- */
function hasOwn(obj: any, key: string) {
  return !!obj && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
}
function rawContainsForbiddenGuestKeys(raw: any) {
  const hasAmount = hasOwn(raw, "amount");
  const hasMessage = hasOwn(raw, "message");
  return { hasAmount, hasMessage, forbidden: hasAmount || hasMessage };
}

/* -------------------- VALIDATION (LOCKED SCOPE) -------------------- */
const CreateGiftSchema = z
  .object({
    senderEmail: z.string().email().optional().or(z.literal("")),

    recipientEmail: z.string().email().optional().or(z.literal("")),
    recipientPhone: z
      .string()
      .optional()
      .or(z.literal(""))
      .refine((v) => !v || isE164(v), { message: "Phone must be E.164 like +14165551234" }),

    messageMode: z.enum(["preset", "custom"]).default("preset"),
    presetMessageId: z.union([z.number().int(), z.string(), z.null(), z.undefined()]).optional(),

    message: z.string().optional().or(z.literal("")).default(""),
    amount: z.union([z.number().int(), z.string(), z.null(), z.undefined()]).optional(),

    turnstileToken: z.string().optional().or(z.literal("")),
    debugBypassLimits: z.string().optional().or(z.literal("")),
  })
  .superRefine((val: any, ctx) => {
    const mode = String(val?.messageMode || "preset");

    const hasEmail = !!String(val?.recipientEmail || "").trim();
    const hasPhone = !!String(val?.recipientPhone || "").trim();

    if (!hasEmail && !hasPhone) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide a recipient email or phone",
        path: ["recipient"],
      });
    }

    if (mode === "preset") {
      const pid = toInt(val?.presetMessageId);
      if (!Number.isInteger(pid) || pid < 1 || pid > 7) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Choose a preset message (1–7)",
          path: ["presetMessageId"],
        });
      }
      return;
    }

    // custom (registered path; auth enforced in route)
    const msg = String(val?.message ?? "").trim();
    if (!msg) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Message is required",
        path: ["message"],
      });
    }
    if (msg.length > 280) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Message must be 280 characters or less",
        path: ["message"],
      });
    }

    const amtRaw = val?.amount;
    const amt = amtRaw === null || amtRaw === undefined || amtRaw === "" ? null : toInt(amtRaw);
    if (amt !== null) {
      if (!Number.isFinite(amt) || amt <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Amount must be a positive number of cents",
          path: ["amount"],
        });
      } else if (amt < 2500) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Minimum amount is $25",
          path: ["amount"],
        });
      } else if (amt > 100000) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Maximum amount is $1000",
          path: ["amount"],
        });
      }
    }
  });

const ClaimSchema = z.object({
  turnstileToken: z.string().optional().or(z.literal("")),
});

const AdminRemindersSchema = z.object({
  dryRun: z.boolean().optional().default(true),
  limit: z.number().int().min(1).max(500).optional().default(25),
  olderThanMinutes: z.number().int().min(1).max(24 * 365 * 60).optional(),
  olderThanHours: z.number().int().min(0).max(24 * 365).optional().default(24),
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

/* -------------------- ADMIN: TEST CREATE (NO TURNSTILE) -------------------- */
const AdminTestCreateGiftSchema = z.object({
  senderEmail: z.string().email().optional().or(z.literal("")),
  recipientEmail: z.string().email().optional().or(z.literal("")),
  recipientPhone: z
    .string()
    .optional()
    .or(z.literal(""))
    .refine((v) => !v || isE164(v), { message: "Phone must be E.164 like +14165551234" }),
  message: z.string().min(1).max(2000),
  amount: z.number().int().min(1000).max(100000),
  deliver: z.boolean().optional().default(false),
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

/* -------------------- CORS -------------------- */
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
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-token, x-user-id");
    res.setHeader("Access-Control-Max-Age", "600");
  }
}

/* -------------------- BACKGROUND DELIVERY -------------------- */
function queueGiftDelivery(opts: {
  req: Request;
  publicId: string;
  claimUrl: string;
  amountCents: number;
  senderEmail: string | null;
  recipientEmail: string;
  recipientPhone: string;
  message: string;
}) {
  const { req, publicId, claimUrl, amountCents, senderEmail, recipientEmail, recipientPhone, message } = opts;

  void (async () => {
    const start = Date.now();
    logEvent("gift_delivery_start", {
      publicId,
      hasEmail: !!recipientEmail,
      hasPhone: !!recipientPhone,
      toEmailDomain: recipientEmail ? recipientEmail.split("@")[1] || "" : "",
      toPhone: recipientPhone ? recipientPhone.slice(0, 4) + "…" : "",
      amountCents,
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
          amountCents,
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
          amountCents,
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
    logEvent("gift_delivery_fatal", { publicId, err: safeStr(e?.message), stack: safeStr(e?.stack) });
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
      registeredAuthMode: "x-user-id (temporary)",
    });
  });

  /* -------------------- ADMIN: TEST CREATE (NO TURNSTILE) -------------------- */
  app.post("/api/admin/test/create-gift", async (req, res) => {
    const auth = requireAdmin(req);
    if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error, version: VERSION, commit: COMMIT });

    const parsed = AdminTestCreateGiftSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: "Invalid payload", issues: parsed.error.issues, version: VERSION, commit: COMMIT });
    }

    const senderEmail = safeStr(parsed.data.senderEmail).trim() || null;
    const recipientEmail = safeStr(parsed.data.recipientEmail).trim();
    const recipientPhone = safeStr(parsed.data.recipientPhone).trim();
    const message = safeStr(parsed.data.message);
    const amount = Number(parsed.data.amount);
    const deliver = !!parsed.data.deliver;

    if (!recipientEmail && !recipientPhone) {
      return res.status(400).json({ ok: false, error: "Provide a recipient email or phone", field: "recipient", version: VERSION, commit: COMMIT });
    }
    if (recipientPhone && !isE164(recipientPhone)) {
      return res.status(400).json({ ok: false, error: "Phone must be E.164 like +14165551234", field: "recipientPhone", version: VERSION, commit: COMMIT });
    }
    if (recipientEmail && !isEmail(recipientEmail)) {
      return res.status(400).json({ ok: false, error: "Invalid recipient email", field: "recipientEmail", version: VERSION, commit: COMMIT });
    }
    if (recipientEmail && isBlockedEmailDomain(recipientEmail)) {
      return res.status(400).json({
        ok: false,
        error: "Recipient email domain not allowed",
        field: "recipientEmail",
        code: "BLOCKED_EMAIL_DOMAIN",
        version: VERSION,
        commit: COMMIT,
      });
    }

    const publicId = newPublicId();
    const claimUrl = `${getClaimSiteBaseUrl(req)}/claim/${publicId}`;

    try {
      await db.insert(gifts).values({
        publicId,
        senderEmail,
        recipientEmail: recipientEmail || null,
        recipientPhone: recipientPhone || null,
        messageMode: "custom",
        presetMessageId: null,
        message,
        amount,
        isClaimed: false,
        reminderCount: 0,
        lastReminderSentAt: null,
        returnedToSenderAt: null,
        claimedAt: null,
      } as any);

      logEvent("admin_test_create_gift_ok", { publicId, deliver });

      if (deliver) {
        queueGiftDelivery({
          req,
          publicId,
          claimUrl,
          amountCents: amount,
          senderEmail,
          recipientEmail,
          recipientPhone,
          message,
        });
      }

      return res.json({ ok: true, publicId, claimUrl, amount, deliver, version: VERSION, commit: COMMIT });
    } catch (e: any) {
      const detail = safeStr(e?.message) || "unknown";
      const stack = safeStr(e?.stack) || "";
      logEvent("admin_test_create_gift_error", { err: detail, stack });
      return res.status(500).json({ ok: false, error: "Server error", detail, version: VERSION, commit: COMMIT });
    }
  });

  /* -------------------- ADMIN: GIFTS RESET (FAST TESTING) -------------------- */
  app.post("/api/admin/gifts/reset", async (req, res) => {
    const auth = requireAdmin(req);
    if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error, version: VERSION, commit: COMMIT });

    const parsed = AdminGiftResetSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: "Invalid payload", issues: parsed.error.issues, version: VERSION, commit: COMMIT });
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
      logEvent("admin_gift_reset_error", { publicId, err: safeStr(e?.message), stack: safeStr(e?.stack) });
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
      return res.status(400).json({ ok: false, error: "Invalid payload", issues: parsed.error.issues, version: VERSION, commit: COMMIT });
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
        return res.status(409).json({ ok: false, error: "Already returned to sender", code: "ALREADY_RETURNED", version: VERSION, commit: COMMIT });
      }
      const reminderCount = Number(gift.reminderCount || 0);
      if (reminderCount >= REMINDER_MAX) {
        return res.status(409).json({ ok: false, error: "Reminder max already reached", code: "REMINDER_MAX_REACHED", version: VERSION, commit: COMMIT });
      }

      const gapMs = getReminderGapMs();
      const newLast = new Date(Date.now() - gapMs - 2_000);

      await db
        .update(gifts)
        .set({ lastReminderSentAt: newLast } as any)
        .where(and(eq(gifts.publicId, publicId), eq(gifts.isClaimed, false), isNull((gifts as any).returnedToSenderAt)));

      logEvent("admin_advance_reminder_time", { publicId, reminderCount, newLast: newLast.toISOString(), gapMs });

      return res.json({ ok: true, publicId, reminderCount, lastReminderSentAt: newLast.toISOString(), gapMs, version: VERSION, commit: COMMIT });
    } catch (e: any) {
      logEvent("admin_advance_reminder_time_error", { publicId, err: safeStr(e?.message), stack: safeStr(e?.stack) });
      return res.status(500).json({ ok: false, error: "Server error", version: VERSION, commit: COMMIT });
    }
  });

  /* -------------------- ADMIN: GIFTS SEED (FAST TESTING, NO TURNSTILE) -------------------- */
  app.post("/api/admin/gifts/seed", async (req, res) => {
    const auth = requireAdmin(req);
    if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error, version: VERSION, commit: COMMIT });

    const parsed = AdminGiftSeedSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: "Invalid payload", issues: parsed.error.issues, version: VERSION, commit: COMMIT });
    }

    const senderEmail = safeStr(parsed.data.senderEmail).trim() || null;
    const recipientEmail = safeStr(parsed.data.recipientEmail).trim();
    const recipientPhone = safeStr(parsed.data.recipientPhone).trim();
    const message = safeStr(parsed.data.message);
    const amount = Number(parsed.data.amount);
    const markClaimed = !!parsed.data.markClaimed;

    if (!recipientEmail && !recipientPhone) {
      return res.status(400).json({ ok: false, error: "Provide a recipient email or phone", field: "recipient", version: VERSION, commit: COMMIT });
    }
    if (recipientPhone && !isE164(recipientPhone)) {
      return res.status(400).json({ ok: false, error: "Phone must be E.164 like +14165551234", field: "recipientPhone", version: VERSION, commit: COMMIT });
    }
    if (recipientEmail && !isEmail(recipientEmail)) {
      return res.status(400).json({ ok: false, error: "Invalid recipient email", field: "recipientEmail", version: VERSION, commit: COMMIT });
    }
    if (recipientEmail && isBlockedEmailDomain(recipientEmail)) {
      return res.status(400).json({
        ok: false,
        error: "Recipient email domain not allowed",
        field: "recipientEmail",
        code: "BLOCKED_EMAIL_DOMAIN",
        version: VERSION,
        commit: COMMIT,
      });
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
        messageMode: "custom",
        presetMessageId: null,
        message,
        amount,
        isClaimed: markClaimed,
        reminderCount: 0,
        lastReminderSentAt: null,
        returnedToSenderAt: null,
        claimedAt: markClaimed ? now : null,
      } as any);

      logEvent("admin_gift_seeded", { publicId, markClaimed });

      return res.json({ ok: true, publicId, claimUrl, amount, seeded: true, markClaimed, version: VERSION, commit: COMMIT });
    } catch (e: any) {
      logEvent("gift_seed_error", { err: safeStr(e?.message), stack: safeStr(e?.stack) });
      return res.status(500).json({ ok: false, error: "Server error", version: VERSION, commit: COMMIT });
    }
  });

  /* -------------------- ADMIN: REMINDERS (TARGETABLE) -------------------- */
  app.post("/api/admin/reminders/send", async (req, res) => {
    const auth = requireAdmin(req);
    if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error, version: VERSION, commit: COMMIT });

    const parsed = AdminRemindersSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: "Invalid payload", issues: parsed.error.issues, version: VERSION, commit: COMMIT });
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
          skippedBlockedDomain: 0,
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
      let skippedBlockedDomain = 0;
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

        if (isBlockedEmailDomain(recipientEmail)) {
          skippedBlockedDomain += 1;
          logEvent("reminder_skipped_blocked_domain", { publicId, toDomain: recipientEmail.split("@")[1] || "" });
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
        skippedBlockedDomain,
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
      logEvent("reminders_error", { err: safeStr(e?.message), stack: safeStr(e?.stack) });
      return res.status(500).json({ ok: false, error: "Server error", version: VERSION, commit: COMMIT });
    }
  });

  /* -------------------- GIFTS: CREATE -------------------- */
  app.post("/api/gifts", createGiftLimiter, async (req, res) => {
    const rawBody: any = req.body || {};
    const registered = isRegistered(req);

    const parsed = CreateGiftSchema.safeParse(rawBody);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid payload", issues: parsed.error.issues, version: VERSION, commit: COMMIT });
    }

    const ip = getClientIp(req);

    const senderEmail = safeStr(parsed.data.senderEmail).trim() || null;

    const recipientEmail = safeStr(parsed.data.recipientEmail).trim();
    const recipientPhone = safeStr(parsed.data.recipientPhone).trim();

    const messageMode = (safeStr((parsed.data as any).messageMode) || "preset") as "preset" | "custom";
    const presetIdRaw = (parsed.data as any).presetMessageId;
    const presetId = presetIdRaw === null || presetIdRaw === undefined || presetIdRaw === "" ? null : toInt(presetIdRaw);

    const rawMessage = safeStr((parsed.data as any).message);

    const amtRaw = (parsed.data as any).amount;
    const amountCents = amtRaw === null || amtRaw === undefined || amtRaw === "" ? null : toInt(amtRaw);

    if (!recipientEmail && !recipientPhone) {
      return res.status(400).json({ error: "Provide a recipient email or phone", field: "recipient", version: VERSION, commit: COMMIT });
    }

    if (recipientEmail && !isEmail(recipientEmail)) {
      return res.status(400).json({ error: "Invalid recipient email", field: "recipientEmail", version: VERSION, commit: COMMIT });
    }

    if (recipientEmail && isBlockedEmailDomain(recipientEmail)) {
      return res.status(400).json({
        error: "Recipient email domain not allowed",
        field: "recipientEmail",
        code: "BLOCKED_EMAIL_DOMAIN",
        version: VERSION,
        commit: COMMIT,
      });
    }

    if (recipientPhone && !isE164(recipientPhone)) {
      return res.status(400).json({ error: "Phone must be E.164 like +14165551234", field: "recipientPhone", version: VERSION, commit: COMMIT });
    }

    // Locked scope for now: email-only delivery (guest + registered)
    if (recipientPhone) {
      return res.status(400).json({
        error: "SMS delivery is not enabled in the current scope",
        field: "recipientPhone",
        code: "SMS_DISABLED_SCOPE",
        version: VERSION,
        commit: COMMIT,
      });
    }

    // -------------------- GUEST MODE HARD LOCK --------------------
    // If not registered, ONLY preset mode is allowed (avoid confusing AUTH_REQUIRED for guests).
    if (!registered && messageMode !== "preset") {
      return res.status(400).json({
        error: "Guest Thankümail is preset-only",
        field: "messageMode",
        code: "GUEST_PRESET_ONLY",
        version: VERSION,
        commit: COMMIT,
      });
    }

    // -------------------- SERVER-AUTHORITATIVE MESSAGE --------------------
    let finalMessage = "";
    let finalPresetId: number | null = null;

    if (messageMode === "preset") {
      // Guest: hard reject forbidden keys (old cached clients)
      if (!registered) {
        const forbidden = rawContainsForbiddenGuestKeys(rawBody);
        if (forbidden.forbidden) {
          const issues: any[] = [];
          if (forbidden.hasAmount) {
            issues.push({ code: "custom", message: "Guest Thankümail does not include a gift amount", path: ["amount"] });
          }
          if (forbidden.hasMessage) {
            issues.push({ code: "custom", message: "Guest Thankümail message is preset-only", path: ["message"] });
          }
          return res.status(400).json({
            error: "Invalid payload",
            issues,
            code: "GUEST_FORBIDDEN_FIELDS",
            version: VERSION,
            commit: COMMIT,
          });
        }
      }

      const presetMsg = presetMessageById(Number(presetId));
      if (!presetMsg) {
        return res.status(400).json({
          error: "Choose a preset message (1–7)",
          field: "presetMessageId",
          code: "PRESET_REQUIRED",
          version: VERSION,
          commit: COMMIT,
        });
      }
      finalMessage = presetMsg;
      finalPresetId = Number(presetId);

      // Guest: email required + no amount
      if (!registered) {
        if (!recipientEmail) {
          return res.status(400).json({
            error: "Guest Thankümail requires recipient email",
            field: "recipientEmail",
            code: "GUEST_EMAIL_REQUIRED",
            version: VERSION,
            commit: COMMIT,
          });
        }
        if (amountCents !== null && Number.isFinite(amountCents) && amountCents > 0) {
          return res.status(400).json({
            error: "Guest Thankümail does not include a gift amount",
            field: "amount",
            code: "GUEST_NO_AMOUNT",
            version: VERSION,
            commit: COMMIT,
          });
        }
      } else {
        // Registered: if amount included, enforce auth + min $25
        if (amountCents !== null && Number.isFinite(amountCents) && amountCents > 0) {
          if (!registered) {
            return res.status(401).json({ error: "Authentication required", code: "AUTH_REQUIRED", version: VERSION, commit: COMMIT });
          }
          if (!Number.isFinite(amountCents) || amountCents <= 0) {
            return res.status(400).json({ error: "Amount must be positive", field: "amount", code: "AMOUNT_INVALID", version: VERSION, commit: COMMIT });
          }
          if (amountCents < 2500) {
            return res.status(400).json({ error: "Minimum amount is $25", field: "amount", code: "AMOUNT_MIN", version: VERSION, commit: COMMIT });
          }
          if (amountCents > 100000) {
            return res.status(400).json({ error: "Maximum amount is $1000", field: "amount", code: "AMOUNT_MAX", version: VERSION, commit: COMMIT });
          }
        }
      }
    } else {
      // custom (registered)
      if (!registered) {
        return res.status(401).json({
          error: "Authentication required",
          code: "AUTH_REQUIRED",
          version: VERSION,
          commit: COMMIT,
        });
      }

      finalMessage = String(rawMessage || "").trim();
      if (!finalMessage) {
        return res.status(400).json({ error: "Message is required", field: "message", code: "MESSAGE_REQUIRED", version: VERSION, commit: COMMIT });
      }
      if (finalMessage.length > 280) {
        return res.status(400).json({
          error: "Message must be 280 characters or less",
          field: "message",
          code: "MESSAGE_TOO_LONG",
          version: VERSION,
          commit: COMMIT,
        });
      }

      if (amountCents !== null) {
        if (!Number.isFinite(amountCents) || amountCents <= 0) {
          return res.status(400).json({ error: "Amount must be positive", field: "amount", code: "AMOUNT_INVALID", version: VERSION, commit: COMMIT });
        }
        if (amountCents < 2500) {
          return res.status(400).json({ error: "Minimum amount is $25", field: "amount", code: "AMOUNT_MIN", version: VERSION, commit: COMMIT });
        }
        if (amountCents > 100000) {
          return res.status(400).json({ error: "Maximum amount is $1000", field: "amount", code: "AMOUNT_MAX", version: VERSION, commit: COMMIT });
        }
      }
    }

    // -------------------- TURNSTILE --------------------
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

    // -------------------- LIMITS --------------------
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
        logEvent("rate_limit_check_error", { err: safeStr(e?.message), stack: safeStr(e?.stack) });
      }
    }

    // Duplicate suppression: only relevant for SMS (currently disabled), keep code inert
    if (recipientPhone) {
      const cutoffMs = Date.now() - SMS_DUPLICATE_WINDOW_SEC * 1000;

      try {
        let rows: any[] = [];

        try {
          rows = await db
            .select()
            .from(gifts)
            .where(and(eq((gifts as any).recipientPhone, recipientPhone), eq(gifts.message, finalMessage), eq(gifts.isClaimed, false)));
        } catch {
          rows = [];
        }

        if ((!rows || rows.length === 0) && senderEmail) {
          rows = await db
            .select()
            .from(gifts)
            .where(and(eq((gifts as any).senderEmail, senderEmail), eq(gifts.message, finalMessage), eq(gifts.isClaimed, false)));
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
            amount: existing.amount ?? null,
            messageMode: (existing as any).messageMode || "custom",
            presetMessageId: (existing as any).presetMessageId ?? null,
            deliveryOk: true,
            emailSent: false,
            smsQueued: false,
            version: VERSION,
            commit: COMMIT,
          });
        }
      } catch (e: any) {
        logEvent("sms_duplicate_check_error", { err: safeStr(e?.message), stack: safeStr(e?.stack) });
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

        messageMode,
        presetMessageId: finalPresetId,

        message: finalMessage,

        amount: amountCents && amountCents > 0 ? amountCents : null,

        isClaimed: false,
        reminderCount: 0,
        lastReminderSentAt: null,
        returnedToSenderAt: null,
        claimedAt: null,
      } as any);

      queueGiftDelivery({
        req,
        publicId,
        claimUrl,
        amountCents: amountCents && amountCents > 0 ? amountCents : 0,
        senderEmail,
        recipientEmail,
        recipientPhone,
        message: finalMessage,
      });

      return res.json({
        ok: true,
        publicId,
        claimUrl,
        amount: amountCents && amountCents > 0 ? amountCents : null,
        messageMode,
        presetMessageId: finalPresetId,
        deliveryOk: true,
        emailSent: !!recipientEmail,
        smsQueued: !!recipientPhone,
        version: VERSION,
        commit: COMMIT,
      });
    } catch (e: any) {
      logEvent("gift_create_error", { err: safeStr(e?.message), stack: safeStr(e?.stack) });
      return res.status(500).json({ error: "Server error", version: VERSION, commit: COMMIT });
    }
  });

  /* -------------------- GIFTS: GET -------------------- */
  app.get("/api/gifts/:publicId", async (req, res) => {
    const publicId = safeStr(req.params.publicId).trim();
    if (!publicId) return res.status(400).json({ error: "Invalid id", version: VERSION, commit: COMMIT });

    try {
      const rows = await db.select().from(gifts).where(eq(gifts.publicId, publicId));
      const gift: any = rows?.[0];
      if (!gift) return res.status(404).json({ error: "Not found", version: VERSION, commit: COMMIT });

      return res.json({
        ok: true,
        publicId: gift.publicId,
        messageMode: gift.messageMode || "custom",
        presetMessageId: gift.presetMessageId ?? null,
        message: gift.message,
        amount: gift.amount ?? null,
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
      logEvent("gift_get_error", { publicId, err: safeStr(e?.message), stack: safeStr(e?.stack) });
      return res.status(500).json({ error: "Server error", version: VERSION, commit: COMMIT });
    }
  });

  /* -------------------- GIFTS: CLAIM -------------------- */
  app.post("/api/gifts/:publicId/claim", claimLimiter, async (req, res) => {
    const publicId = safeStr(req.params.publicId).trim();
    if (!publicId) return res.status(400).json({ error: "Invalid id", version: VERSION, commit: COMMIT });

    const parsed = ClaimSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid payload", issues: parsed.error.issues, version: VERSION, commit: COMMIT });
    }

    const minDelaySec = Math.max(0, Number(process.env.MIN_CLAIM_DELAY_SEC || 60));

    try {
      const rows = await db.select().from(gifts).where(eq(gifts.publicId, publicId));
      const gift: any = rows?.[0];
      if (!gift) return res.status(404).json({ error: "Not found", version: VERSION, commit: COMMIT });

      if (gift.returnedToSenderAt) {
        return res.status(410).json({
          error: "This thankÜmail was returned to sender and can no longer be claimed",
          code: "RETURNED_TO_SENDER",
          returnedToSenderAt: gift.returnedToSenderAt,
          version: VERSION,
          commit: COMMIT,
        });
      }

      if (gift.isClaimed) {
        return res.status(409).json({ error: "Already claimed", code: "ALREADY_CLAIMED", version: VERSION, commit: COMMIT });
      }

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

      await db
        .update(gifts)
        .set({ isClaimed: true, claimedAt: new Date() })
        .where(and(eq(gifts.publicId, publicId), eq(gifts.isClaimed, false)));

      return res.json({ ok: true, version: VERSION, commit: COMMIT });
    } catch (e: any) {
      logEvent("claim_error", { publicId, err: safeStr(e?.message), stack: safeStr(e?.stack) });
      return res.status(500).json({ error: "Server error", version: VERSION, commit: COMMIT });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
