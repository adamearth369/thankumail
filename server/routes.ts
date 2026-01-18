import type { Request, Response } from "express";
import { Router } from "express";
import crypto from "crypto";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { db } from "./db";
import { gifts } from "@shared/schema";
import { and, eq, lt } from "drizzle-orm";
import { sendGiftEmail, sendGiftReminderEmail } from "./email";

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

/* -------------------- LIMITS / CONFIG -------------------- */
const MIN_CLAIM_DELAY_SEC = Number(process.env.MIN_CLAIM_DELAY_SEC || "60");
const minClaimDelaySec = Number.isFinite(MIN_CLAIM_DELAY_SEC) ? MIN_CLAIM_DELAY_SEC : 60;

const giftCreateLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

const DEFAULT_REMINDER_HOURS = Number(process.env.REMINDER_OLDER_THAN_HOURS || "48");
const reminderOlderThanHours = Number.isFinite(DEFAULT_REMINDER_HOURS) ? DEFAULT_REMINDER_HOURS : 48;

const DEFAULT_REMINDER_LIMIT = Number(process.env.REMINDER_BATCH_SIZE || "50");
const reminderBatchSize = Number.isFinite(DEFAULT_REMINDER_LIMIT) ? DEFAULT_REMINDER_LIMIT : 50;

/* -------------------- VALIDATION -------------------- */
const CreateGiftSchema = z.object({
  recipientEmail: z.string().email(),
  message: z.string().min(1),
  amount: z.number().int().min(1000),
  turnstileToken: z.string().min(1).optional(),
});

const AdminReminderSchema = z.object({
  dryRun: z.boolean().optional(),
  olderThanHours: z.number().int().min(1).max(720).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

function requireAdmin(req: Request, res: Response) {
  const expected = safeStr(process.env.ADMIN_TOKEN);
  if (!expected) {
    res.status(500).json({ error: "Server missing ADMIN_TOKEN" });
    return true;
  }
  const got = safeStr(req.header("x-admin-token"));
  if (!got || got !== expected) {
    res.status(401).json({ error: "Unauthorized" });
    return true;
  }
  return false;
}

/* -------------------- ROUTER (DEFAULT EXPORT) -------------------- */
const router = Router();

/* -------------------- VERSION MARKER (DEPLOY PROOF) -------------------- */
router.get("/api/__version", (_req: Request, res: Response) => {
  // bump this string whenever we need to prove deploy updated
  return res.json({ ok: true, version: "reminders_v1_2026-01-18" });
});

/* -------------------- CREATE GIFT -------------------- */
router.post("/api/gifts", giftCreateLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = CreateGiftSchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues?.[0];
      return res.status(400).json({
        error: first?.message || "Invalid request",
        issues: parsed.error.issues,
        field: first?.path?.[0] ? String(first.path[0]) : undefined,
      });
    }

    const { recipientEmail, message, amount, turnstileToken } = parsed.data;

    const siteKey = safeStr(process.env.TURNSTILE_SITE_KEY || process.env.VITE_TURNSTILE_SITE_KEY);
    const secretKey = safeStr(process.env.TURNSTILE_SECRET_KEY);

    if (siteKey) {
      if (!turnstileToken) {
        return res.status(400).json({ error: "Missing CAPTCHA token", field: "turnstileToken" });
      }
      if (!secretKey) {
        return res.status(500).json({ error: "Server missing Turnstile secret key" });
      }

      const form = new URLSearchParams();
      form.set("secret", secretKey);
      form.set("response", turnstileToken);
      form.set("remoteip", safeStr(req.ip));

      const verify = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }).then((r) => r.json().catch(() => ({} as any)));

      if (!verify?.success) {
        return res.status(400).json({
          error: "CAPTCHA verification failed",
          field: "turnstileToken",
          codes: Array.isArray(verify?.["error-codes"]) ? verify["error-codes"] : undefined,
        });
      }
    }

    const publicId = crypto.randomBytes(12).toString("hex");
    logEvent("gift_created", { publicId });

    const inserted = await db
      .insert(gifts as any)
      .values({
        publicId,
        recipientEmail,
        message,
        amount,
        isClaimed: false,
        createdAt: new Date(),
      })
      .returning();

    const gift = inserted?.[0];
    const pid = (gift as any)?.publicId || publicId;

    const base = getBaseUrl(req);
    const claimUrl = `${base}/claim/${pid}`;

    logEvent("email_send_queued", { publicId: pid });

    const emailRes = await sendGiftEmail({
      to: recipientEmail,
      message,
      claimLink: claimUrl,
      amountCents: amount,
    });

    if (emailRes?.ok) logEvent("email_sent", { publicId: pid });
    else logEvent("email_send_failed", { publicId: pid, error: emailRes?.error || "unknown" });

    return res.json({
      publicId: pid,
      giftId: pid,
      claimUrl,
      claimLink: claimUrl,
      emailSent: emailRes?.ok ? true : false,
    });
  } catch (e: any) {
    logEvent("gift_create_failed", { error: String(e?.message || e) });
    return res.status(500).json({ error: "Server error" });
  }
});

/* -------------------- GET GIFT -------------------- */
router.get("/api/gifts/:publicId", async (req: Request, res: Response) => {
  const publicId = (req.params.publicId || "").toString().trim();

  try {
    const rows = await db
      .select()
      .from(gifts as any)
      .where(eq((gifts as any).publicId, publicId))
      .limit(1);

    const gift = rows?.[0];
    if (!gift) {
      logEvent("gift_get_not_found", { publicId });
      return res.status(404).json({ error: "Not found" });
    }

    return res.json({
      publicId: (gift as any).publicId,
      giftId: (gift as any).publicId,
      amount: (gift as any).amount,
      message: (gift as any).message,
      recipientEmail: (gift as any).recipientEmail,
      isClaimed: !!(gift as any).isClaimed,
      createdAt: (gift as any).createdAt,
      claimedAt: (gift as any).claimedAt,
    });
  } catch (e: any) {
    logEvent("gift_get_failed", { publicId, error: String(e?.message || e) });
    return res.status(500).json({ error: "Server error" });
  }
});

/* -------------------- CLAIM (delay enforced) -------------------- */
router.post("/api/gifts/:publicId/claim", async (req: Request, res: Response) => {
  const publicId = (req.params.publicId || "").toString().trim();
  const ip = safeStr(req.ip);

  logEvent("claim_attempted", { publicId, ip });

  try {
    const rows = await db
      .select()
      .from(gifts as any)
      .where(eq((gifts as any).publicId, publicId))
      .limit(1);

    const gift = rows?.[0];
    if (!gift) {
      logEvent("claim_not_found", { publicId });
      return res.status(404).json({ error: "Not found" });
    }

    if ((gift as any).isClaimed) {
      logEvent("claim_already_claimed", { publicId });
      return res.status(409).json({ error: "Already claimed", code: "ALREADY_CLAIMED" });
    }

    const createdAt = (gift as any).createdAt ? new Date((gift as any).createdAt) : null;
    if (createdAt) {
      const unlockAtMs = createdAt.getTime() + minClaimDelaySec * 1000;
      const nowMs = Date.now();
      if (nowMs < unlockAtMs) {
        const unlockInSec = Math.ceil((unlockAtMs - nowMs) / 1000);
        logEvent("claim_too_soon", { publicId, unlockInSec, minClaimDelaySec });
        return res.status(429).json({
          error: "Too soon",
          code: "TOO_SOON",
          retryAfterSec: unlockInSec,
        });
      }
    }

    const claimedAt = new Date();

    const updated = await db
      .update(gifts as any)
      .set({ isClaimed: true, claimedAt })
      .where(eq((gifts as any).publicId, publicId))
      .returning();

    if (!updated?.[0]) {
      logEvent("claim_update_failed", { publicId });
      return res.status(500).json({ error: "Failed to claim" });
    }

    logEvent("claim_completed", { publicId, claimedAt: claimedAt.toISOString() });

    return res.json({
      ok: true,
      publicId,
      claimedAt: claimedAt.toISOString(),
    });
  } catch (e: any) {
    logEvent("claim_failed", { publicId, ip, error: String(e?.message || e) });
    return res.status(500).json({ error: "Server error" });
  }
});

/* -------------------- ADMIN: SEND REMINDERS (manual trigger) -------------------- */
router.post("/api/admin/reminders/send", async (req: Request, res: Response) => {
  if (requireAdmin(req, res)) return;

  const parsed = AdminReminderSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", issues: parsed.error.issues });
  }

  const dryRun = !!parsed.data.dryRun;
  const olderThanHours = parsed.data.olderThanHours ?? reminderOlderThanHours;
  const limit = parsed.data.limit ?? reminderBatchSize;

  const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);

  logEvent("reminders_scan_start", {
    dryRun,
    olderThanHours,
    limit,
    cutoff: cutoff.toISOString(),
  });

  let scanned = 0;
  let eligible = 0;
  let sent = 0;
  let failed = 0;

  try {
    const rows = await db
      .select()
      .from(gifts as any)
      .where(and(eq((gifts as any).isClaimed, false), lt((gifts as any).createdAt, cutoff)))
      .limit(limit);

    scanned = rows?.length || 0;
    eligible = scanned;

    for (const g of rows || []) {
      const publicId = safeStr((g as any).publicId);
      const to = safeStr((g as any).recipientEmail);
      const claimUrl = `${getBaseUrl(req)}/claim/${encodeURIComponent(publicId)}`;

      if (dryRun) {
        logEvent("reminder_dryrun", { publicId });
        continue;
      }

      logEvent("reminder_send_queued", { publicId });

      const r = await sendGiftReminderEmail({
        to,
        claimLink: claimUrl,
      });

      if ((r as any)?.ok) {
        sent += 1;
        logEvent("reminder_sent", { publicId, messageId: (r as any).messageId });
      } else {
        failed += 1;
        logEvent("reminder_failed", { publicId, error: (r as any)?.error || "unknown" });
      }
    }

    logEvent("reminders_scan_done", { scanned, eligible, sent, failed });

    return res.json({
      ok: true,
      scanned,
      eligible,
      sent,
      failed,
      dryRun,
      olderThanHours,
      limit,
      cutoff: cutoff.toISOString(),
    });
  } catch (e: any) {
    logEvent("reminders_scan_failed", { error: String(e?.message || e) });
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
