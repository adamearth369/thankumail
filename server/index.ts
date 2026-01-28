// WHERE TO PASTE: server/routes.ts
// ACTION: Full file replacement (paste exactly)

import type { Express, Request } from "express";
import { createServer, type Server } from "http";
import crypto from "crypto";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { eq, and, gte, asc } from "drizzle-orm";

import { db } from "./db";
import { gifts } from "@shared/schema";
import { sendGiftEmail } from "./email";
import { sendGiftSms } from "./sms";

/* -------------------- VERSION -------------------- */
const VERSION = "routes_v2026-01-27_005";
const COMMIT = process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || "";

/* -------------------- STRUCTURED LOGGING -------------------- */
function logEvent(event: string, fields: Record<string, any> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}
function safeStr(v: any) {
  return typeof v === "string" ? v : "";
}

/* -------------------- CLAIM SITE BASE URL -------------------- */
function getClaimSiteBaseUrl(req: Request) {
  const env = process.env.PUBLIC_SITE_URL || process.env.PUBLIC_CLAIM_BASE_URL || "";
  if (env) return env.replace(/\/+$/, "");

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

  const ra = safeStr((req.socket as any)?.remoteAddress);
  return ra || "";
}

/* -------------------- TURNSTILE -------------------- */
async function verifyTurnstile(token: string, req: Request) {
  const secret = process.env.TURNSTILE_SECRET_KEY || "";
  const bypass = (process.env.TURNSTILE_BYPASS || "").toLowerCase() === "true";

  if (!secret) return { ok: true, mode: "not_configured" as const, codes: [] as string[] };
  if (bypass) return { ok: true, mode: "bypass" as const, codes: [] as string[] };

  if (!token) {
    return { ok: false, mode: "enforced" as const, codes: ["missing-input-response"] as string[] };
  }

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

function toMs(d: any) {
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime();
  return Number.isFinite(t) ? t : 0;
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
  // debug/testing only: allow skipping DAILY_LIMIT checks for one request (requires secret env)
  debugBypassLimits: z.string().optional().or(z.literal("")),
});

const ClaimSchema = z.object({
  turnstileToken: z.string().optional().or(z.literal("")),
});

const RemindersSchema = z.object({
  dryRun: z.boolean().optional().default(true),
  limit: z.number().int().min(1).max(200).optional().default(25),
  olderThanHours: z.number().int().min(0).max(24 * 365).optional().default(24),
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

const adminLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
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

  const oldest = rows?.[0]?.createdAt;
  const oldestMs = toMs(oldest);
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

function canBypassLimits(_req: any, parsedBody: any) {
  const secret = safeStr(process.env.DEBUG_BYPASS_LIMITS_SECRET || "");
  if (!secret) return false;
  const token = safeStr(parsedBody?.debugBypassLimits || "").trim();
  return token && token === secret;
}

/* -------------------- ADMIN AUTH -------------------- */
function requireAdmin(req: Request) {
  const configured = safeStr(process.env.ADMIN_TOKEN || "");
  if (!configured) return { ok: false as const, status: 501, error: "Admin not configured (missing ADMIN_TOKEN)" };

  const got = safeStr(req.headers["x-admin-token"] || "").trim();
  if (!got || got !== configured) return { ok: false as const, status: 401, error: "Unauthorized" };

  return { ok: true as const };
}

/* -------------------- ROUTES -------------------- */
export function registerRoutes(app: Express): Server {
  app.get("/api/health", (_req, res) => res.json({ ok: true, version: VERSION, commit: COMMIT }));

  app.get("/api/version", (_req, res) => {
    const bypass = (process.env.TURNSTILE_BYPASS || "").toLowerCase() === "true";
    const configured = !!(process.env.TURNSTILE_SECRET_KEY || "");
    const mode = !configured ? "not_configured" : bypass ? "bypass" : "enforced";

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
      adminConfigured: !!process.env.ADMIN_TOKEN,
    });
  });

  /* -------------------- ADMIN: REMINDERS SEND -------------------- */
  app.post("/api/admin/reminders/send", adminLimiter, async (req, res) => {
    const auth = requireAdmin(req);
    if (!auth.ok) {
      return res.status(auth.status).json({ ok: false, error: auth.error, version: VERSION, commit: COMMIT });
    }

    const parsed = RemindersSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: "Invalid payload", issues: parsed.error.issues, version: VERSION, commit: COMMIT });
    }

    const dryRun = !!parsed.data.dryRun;
    const limit = Number(parsed.data.limit || 25);
    const olderThanHours = Number(parsed.data.olderThanHours || 24);

    const now = Date.now();
    const cutoff = new Date(now - olderThanHours * 3600 * 1000);

    // Requirements:
    // - Only unclaimed gifts
    // - Up to 3 reminders total
    // - 48h gap between reminders by default
    const MAX_REMINDERS = Math.max(1, Number(process.env.REMINDER_MAX_COUNT || 3));
    const GAP_HOURS = Math.max(1, Number(process.env.REMINDER_GAP_HOURS || 48));

    const gapMs = GAP_HOURS * 3600 * 1000;

    let rows: any[] = [];
    try {
      rows = await db
        .select()
        .from(gifts)
        .where(and(eq(gifts.isClaimed, false), gte(gifts.createdAt, new Date(0))))
        .orderBy(asc(gifts.createdAt));
    } catch (e: any) {
      logEvent("reminders_query_error", { err: safeStr(e?.message) });
      return res.status(500).json({ ok: false, error: "Server error", version: VERSION, commit: COMMIT });
    }

    // Filter in app code to stay compatible even if schema fields differ slightly.
    const eligible = (rows || [])
      .filter((g: any) => {
        if (!g) return false;
        if (g.isClaimed) return false;
        if (!g.createdAt) return false;

        const createdMs = toMs(g.createdAt);
        if (!createdMs || createdMs > now) return false;

        if (createdMs > toMs(cutoff)) return false;

        const rc = Number(g.reminderCount || 0);
        if (rc >= MAX_REMINDERS) return false;

        const lastSentMs = g.lastReminderSentAt ? toMs(g.lastReminderSentAt) : 0;

        // reminder schedule: first reminder >= olderThanHours; subsequent reminders spaced by GAP_HOURS
        if (rc === 0) return true;
        if (!lastSentMs) return true;

        return now - lastSentMs >= gapMs;
      })
      .slice(0, limit);

    let sent = 0;
    let failed = 0;
    const failures: any[] = [];

    for (const g of eligible) {
      const publicId = safeStr(g.publicId);
      const recipientEmail = safeStr(g.recipientEmail);
      const recipientPhone = safeStr(g.recipientPhone);
      const senderEmail = safeStr(g.senderEmail);
      const amount = Number(g.amount || 0);
      const message = safeStr(g.message);

      const claimUrl = `${getClaimSiteBaseUrl(req)}/claim/${publicId}`;

      if (!publicId) continue;

      // If no recipient channel, skip
      if (!recipientEmail && !recipientPhone) continue;

      if (dryRun) {
        sent += 1;
        continue;
      }

      try {
        let ok = true;

        if (recipientEmail) {
          const r = await sendGiftEmail({
            to: recipientEmail,
            publicId,
            claimUrl,
            amountCents: amount,
            senderEmail: senderEmail || undefined,
            message,
          } as any);
          if (!r?.ok) ok = false;
        }

        if (recipientPhone) {
          const r: any = await sendGiftSms({
            to: recipientPhone,
            publicId,
            claimUrl,
            amountCents: amount,
            senderEmail: senderEmail || undefined,
            message,
          } as any);
          if (!r?.ok) ok = false;
        }

        if (!ok) {
          failed += 1;
          failures.push({ publicId, error: "Delivery failed" });
          logEvent("reminder_delivery_failed", { publicId });
          continue;
        }

        sent += 1;

        // Increment reminder count + timestamp
        const rc = Number(g.reminderCount || 0);
        await db
          .update(gifts)
          .set({
            reminderCount: rc + 1,
            lastReminderSentAt: new Date(),
          } as any)
          .where(eq(gifts.publicId, publicId));

        logEvent("reminder_sent", { publicId, reminderCount: rc + 1 });

        // If that was the last reminder, mark returnedToSenderAt (no further sends here)
        if (rc + 1 >= MAX_REMINDERS) {
          await db
            .update(gifts)
            .set({
              returnedToSenderAt: new Date(),
            } as any)
            .where(eq(gifts.publicId, publicId));

          logEvent("reminder_returned_to_sender_marked", { publicId, senderEmail: senderEmail || null });
        }
      } catch (e: any) {
        failed += 1;
        const err = safeStr(e?.message) || "Unknown error";
        failures.push({ publicId, error: err });
        logEvent("reminder_send_error", { publicId, err });
      }
    }

    return res.json({
      ok: true,
      dryRun,
      scanned: rows.length,
      eligible: eligible.length,
      sent,
      failed,
      failures: failures.slice(0, 25),
      limit,
      olderThanHours,
      version: VERSION,
      commit: COMMIT,
    });
  });

  app.post("/api/gifts", createGiftLimiter, async (req, res) => {
    const parsed = CreateGiftSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid payload",
        issues: parsed.error.issues,
        version: VERSION,
        commit: COMMIT,
      });
    }

    const ip = getClientIp(req);

    const senderEmail = safeStr(parsed.data.senderEmail).trim() || null;
    const recipientEmail = safeStr(parsed.data.recipientEmail).trim();
    const recipientPhone = safeStr(parsed.data.recipientPhone).trim();
    const message = safeStr(parsed.data.message);
    const amount = Number(parsed.data.amount);

    if (!recipientEmail && !recipientPhone) {
      return res.status(400).json({
        error: "Provide a recipient email or phone",
        field: "recipient",
        version: VERSION,
        commit: COMMIT,
      });
    }

    if (recipientPhone && !isE164(recipientPhone)) {
      return res.status(400).json({
        error: "Phone must be E.164 like +14165551234",
        field: "recipientPhone",
        version: VERSION,
        commit: COMMIT,
      });
    }

    const t = await verifyTurnstile(safeStr(parsed.data.turnstileToken), req);
    if (!t.ok) {
      logEvent("captcha_fail", { codes: t.codes || [], mode: t.mode });

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

    const bypassLimits = canBypassLimits(req, parsed.data);
    if (bypassLimits) {
      logEvent("debug_bypass_limits", { ip, senderEmail, hasPhone: !!recipientPhone, hasEmail: !!recipientEmail });
    }

    if (!bypassLimits) {
      const ipLim = enforceIpDailyLimit(ip, DAILY_LIMIT_IP);
      if (!ipLim.ok) {
        logEvent("rate_limit_ip_blocked", {
          ip,
          limit: ipLim.limit,
          count: ipLim.count,
          retryAfterSec: ipLim.retryAfterSec,
        });
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
            logEvent("rate_limit_sender_blocked", {
              senderEmail,
              limit: lim.limit,
              count: lim.count,
              retryAfterSec: lim.retryAfterSec,
            });
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
            logEvent("rate_limit_recipient_blocked", {
              recipientPhone,
              limit: lim.limit,
              count: lim.count,
              retryAfterSec: lim.retryAfterSec,
            });
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
            .where(
              and(
                eq((gifts as any).recipientPhone, recipientPhone),
                eq(gifts.message, message),
                eq(gifts.amount, amount),
                eq(gifts.isClaimed, false),
              ),
            );
        } catch {
          rows = [];
        }

        if ((!rows || rows.length === 0) && senderEmail) {
          rows = await db
            .select()
            .from(gifts)
            .where(
              and(
                eq((gifts as any).senderEmail, senderEmail),
                eq(gifts.message, message),
                eq(gifts.amount, amount),
                eq(gifts.isClaimed, false),
              ),
            );
        }

        const recent = (rows || [])
          .map((r: any) => ({ r, ms: toMs(r?.createdAt) }))
          .filter((x) => x.ms && x.ms >= cutoffMs)
          .sort((a, b) => b.ms - a.ms);

        const existing = recent?.[0]?.r;
        if (existing?.publicId) {
          const existingClaimUrl = `${getClaimSiteBaseUrl(req)}/claim/${existing.publicId}`;

          logEvent("sms_duplicate_blocked", {
            matchedPublicId: existing.publicId,
            windowSec: SMS_DUPLICATE_WINDOW_SEC,
            amount,
          });

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

      logEvent("gift_created", {
        publicId,
        amount,
        hasEmail: !!recipientEmail,
        hasPhone: !!recipientPhone,
        captchaMode: t.mode || "unknown",
        ip,
      });

      let deliveryOk = true;
      let deliveryError = "";
      let emailSent = false;
      let smsQueued = false;

      if (recipientEmail) {
        const emailRes = await sendGiftEmail({
          to: recipientEmail,
          publicId,
          claimUrl,
          amountCents: amount,
          senderEmail: senderEmail || undefined,
          message,
        } as any);

        if (!emailRes.ok) {
          deliveryOk = false;
          deliveryError = safeStr((emailRes as any).error) || "Email failed";
          logEvent("email_failed", { publicId, err: deliveryError });
        } else {
          emailSent = true;
          logEvent("email_sent", { publicId });
        }
      }

      if (recipientPhone) {
        const smsRes: any = await sendGiftSms({
          to: recipientPhone,
          publicId,
          claimUrl,
          amountCents: amount,
          senderEmail: senderEmail || undefined,
          message,
        } as any);

        if (!smsRes.ok) {
          deliveryOk = false;
          const err = safeStr(smsRes?.error) || "SMS failed";
          deliveryError = deliveryError ? `${deliveryError}; ${err}` : err;
          logEvent("sms_failed", { publicId, err });
        } else {
          smsQueued = true;

          const providerStatus = safeStr(smsRes?.status).toLowerCase();
          if (providerStatus === "sent" || smsRes?.sent === true) {
            logEvent("sms_sent", { publicId });
          } else {
            logEvent("sms_queued", { publicId });
          }
        }
      }

      return res.json({
        ok: true,
        publicId,
        claimUrl,
        amount,
        deliveryOk,
        emailSent,
        smsQueued,
        deliveryError: deliveryOk ? undefined : deliveryError,
        version: VERSION,
        commit: COMMIT,
      });
    } catch (e: any) {
      logEvent("gift_create_error", { err: safeStr(e?.message) });
      return res.status(500).json({ error: "Server error", version: VERSION, commit: COMMIT });
    }
  });

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

  app.post("/api/gifts/:publicId/claim", claimLimiter, async (req, res) => {
    const publicId = safeStr(req.params.publicId).trim();
    if (!publicId) return res.status(400).json({ error: "Invalid id", version: VERSION, commit: COMMIT });

    const parsed = ClaimSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "Invalid payload", issues: parsed.error.issues, version: VERSION, commit: COMMIT });
    }

    const minDelaySec = Math.max(0, Number(process.env.MIN_CLAIM_DELAY_SEC || 60));

    try {
      const rows = await db.select().from(gifts).where(eq(gifts.publicId, publicId));
      const gift = rows?.[0];
      if (!gift) return res.status(404).json({ error: "Not found", version: VERSION, commit: COMMIT });

      if (gift.isClaimed) {
        return res
          .status(409)
          .json({ error: "Already claimed", code: "ALREADY_CLAIMED", version: VERSION, commit: COMMIT });
      }

      if (gift.createdAt && minDelaySec > 0) {
        const ageMs = Date.now() - new Date(gift.createdAt).getTime();
        if (ageMs < minDelaySec * 1000) {
          const retryAfterSec = Math.ceil((minDelaySec * 1000 - ageMs) / 1000);
          return res.status(429).json({
            error: "Please wait before claiming",
            code: "MIN_DELAY",
            retryAfterSec,
            version: VERSION,
            commit: COMMIT,
          });
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
      logEvent("claim_error", { publicId, err: safeStr(e?.message) });
      return res.status(500).json({ error: "Server error", version: VERSION, commit: COMMIT });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
