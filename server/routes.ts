// WHERE TO PASTE: server/routes.ts
// ACTION: Full file replacement (paste exactly)

import type { Express, Request } from "express";
import { createServer, type Server } from "http";
import crypto from "crypto";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { eq, and, gt } from "drizzle-orm";

import { db } from "./db";
import { gifts } from "@shared/schema";
import { sendGiftEmail } from "./email";
import { sendGiftSms } from "./sms";

/* -------------------- STRUCTURED LOGGING -------------------- */
function logEvent(event: string, fields: Record<string, any> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}
function safeStr(v: any) {
  return typeof v === "string" ? v : "";
}

/* -------------------- BASE URL -------------------- */
function getBaseUrl(req: Request) {
  const envBase = process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "";
  if (envBase) return envBase.replace(/\/+$/, "");

  const proto = (req.headers["x-forwarded-proto"] || "https").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return `${proto}://${host}`.replace(/\/+$/, "");
}

/* -------------------- TURNSTILE -------------------- */
async function verifyTurnstile(token: string, req: Request) {
  const secret = process.env.TURNSTILE_SECRET_KEY || "";
  const bypass = (process.env.TURNSTILE_BYPASS || "").toLowerCase() === "true";

  if (!secret) return { ok: true, mode: "not_configured" as const };
  if (bypass) return { ok: true, mode: "bypass" as const };
  if (!token) return { ok: false, mode: "enforced" as const, codes: ["missing-input-response"] as string[] };

  const ip =
    (req.headers["cf-connecting-ip"] as string) ||
    (req.headers["x-forwarded-for"] as string) ||
    (req.socket?.remoteAddress as string) ||
    "";

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
});

const ClaimSchema = z.object({
  turnstileToken: z.string().optional().or(z.literal("")),
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

/* -------------------- SMS DUPLICATE WINDOW -------------------- */
/**
 * Blocks accidental "retry spam" (e.g., user double-clicks / network retry).
 * If a matching unclaimed gift (same phone + message + amount) exists within this window,
 * we return the existing claim link and DO NOT resend SMS.
 */
const SMS_DUPLICATE_WINDOW_SEC = Math.max(10, Number(process.env.SMS_DUPLICATE_WINDOW_SEC || 90));

/* -------------------- ROUTES -------------------- */
export function registerRoutes(app: Express): Server {
  const VERSION = "routes_v2026-01-26_002";
  const COMMIT = process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || "";

  app.get("/api/health", (_req, res) => res.json({ ok: true, version: VERSION, commit: COMMIT }));

  app.get("/api/version", (_req, res) =>
    res.json({
      ok: true,
      version: VERSION,
      commit: COMMIT,
      env: process.env.NODE_ENV || "",
      minClaimDelaySec: Math.max(0, Number(process.env.MIN_CLAIM_DELAY_SEC || 60)),
      smsDuplicateWindowSec: SMS_DUPLICATE_WINDOW_SEC,
    }),
  );

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

    const senderEmail = safeStr(parsed.data.senderEmail).trim() || null;
    const recipientEmail = safeStr(parsed.data.recipientEmail).trim();
    const recipientPhone = safeStr(parsed.data.recipientPhone).trim();
    const message = safeStr(parsed.data.message);
    const amount = Number(parsed.data.amount);

    // REQUIRE: at least one delivery target
    if (!recipientEmail && !recipientPhone) {
      return res.status(400).json({
        error: "Provide a recipient email or phone",
        field: "recipient",
        version: VERSION,
        commit: COMMIT,
      });
    }

    // If present, phone must be valid
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
      logEvent("captcha_fail", { codes: (t as any).codes || [], mode: (t as any).mode });
      return res.status(400).json({
        error: "Missing CAPTCHA token",
        field: "turnstileToken",
        codes: (t as any).codes || [],
        code: "TURNSTILE_FAILED",
        version: VERSION,
        commit: COMMIT,
      });
    }

    // --- SMS duplicate retry protection (only applies if phone is present) ---
    if (recipientPhone) {
      const cutoff = new Date(Date.now() - SMS_DUPLICATE_WINDOW_SEC * 1000);
      try {
        const recent = await db
          .select()
          .from(gifts)
          .where(
            and(
              eq(gifts.recipientPhone, recipientPhone),
              eq(gifts.message, message),
              eq(gifts.amount, amount),
              eq(gifts.isClaimed, false),
              gt(gifts.createdAt as any, cutoff as any),
            ),
          );

        const existing = recent?.[0];
        if (existing?.publicId) {
          const existingClaimUrl = `${getBaseUrl(req)}/claim/${existing.publicId}`;

          logEvent("sms_duplicate_blocked", {
            matchedPublicId: existing.publicId,
            windowSec: SMS_DUPLICATE_WINDOW_SEC,
            amount,
          });

          // Return existing link and do NOT resend SMS
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
        // If duplicate check fails, we still proceed (fail-open)
        logEvent("sms_duplicate_check_error", { err: safeStr(e?.message) });
      }
    }

    const publicId = newPublicId();
    const claimUrl = `${getBaseUrl(req)}/claim/${publicId}`;

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
        captchaMode: (t as any).mode || "unknown",
      });

      // delivery results
      let deliveryOk = true;
      let deliveryError = "";
      let emailSent = false;
      let smsQueued = false;

      // Email (optional)
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
          logEvent("email_send_failed", { publicId, err: deliveryError });
        } else {
          emailSent = true;
          logEvent("email_send_ok", { publicId });
        }
      }

      // SMS (optional)
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

          // Prefer "sent" if the provider explicitly says so; otherwise treat as queued.
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
      return res.status(400).json({ error: "Invalid payload", issues: parsed.error.issues, version: VERSION, commit: COMMIT });
    }

    const minDelaySec = Math.max(0, Number(process.env.MIN_CLAIM_DELAY_SEC || 60));

    try {
      const rows = await db.select().from(gifts).where(eq(gifts.publicId, publicId));
      const gift = rows?.[0];
      if (!gift) return res.status(404).json({ error: "Not found", version: VERSION, commit: COMMIT });

      if (gift.isClaimed) {
        return res.status(409).json({ error: "Already claimed", code: "ALREADY_CLAIMED", version: VERSION, commit: COMMIT });
      }

      // enforce delay BEFORE consuming captcha token
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
        return res.status(400).json({
          error: "Missing CAPTCHA token",
          field: "turnstileToken",
          codes: (t as any).codes || [],
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
