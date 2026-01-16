import type { Request, Response } from "express";
import { Router } from "express";
import crypto from "crypto";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { db } from "./db";
import { gifts } from "@shared/schema";
import { eq, or } from "drizzle-orm";
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

/* -------------------- LIMITS / CONFIG -------------------- */
const MIN_CLAIM_DELAY_SEC = Number(process.env.MIN_CLAIM_DELAY_SEC || "60");
const minClaimDelaySec = Number.isFinite(MIN_CLAIM_DELAY_SEC) ? MIN_CLAIM_DELAY_SEC : 60;

const giftCreateLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

/* -------------------- VALIDATION -------------------- */
const CreateGiftSchema = z.object({
  recipientEmail: z.string().email(),
  message: z.string().min(1),
  amount: z.number().int().min(1000),
  turnstileToken: z.string().min(1).optional(),
});

/* -------------------- ROUTER (DEFAULT EXPORT) -------------------- */
/**
 * IMPORTANT:
 * src/index.ts imports this as a default export:
 *   import apiRouter from "../server/routes";
 */
const router = Router();

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

    // Enforce CAPTCHA if site key configured
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
    const claimToken = crypto.randomBytes(12).toString("hex");

    logEvent("gift_created", { publicId, amount, toDomain: recipientEmail.split("@")[1] || "" });

    const inserted = await db
      .insert(gifts as any)
      .values({
        publicId,
        claimToken,
        recipientEmail,
        message,
        amount,
        isClaimed: false,
        createdAt: new Date(),
      })
      .returning();

    const gift = inserted?.[0];

    const base = getBaseUrl(req);
    const claimUrl = `${base}/claim/${claimToken}`;

    const pid = (gift as any)?.publicId || publicId;
    logEvent("email_send_queued", { publicId: pid });

    const emailRes = await sendGiftEmail({
      to: recipientEmail,
      message,
      claimLink: claimUrl,
    });

    if (emailRes?.ok) {
      logEvent("email_sent", { publicId: pid, toDomain: recipientEmail.split("@")[1] || "" });
    } else {
      logEvent("email_send_failed", { publicId: pid, error: emailRes?.error || "unknown" });
    }

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

/* -------------------- GET GIFT (publicId OR claimToken) -------------------- */
router.get("/api/gifts/:id", async (req: Request, res: Response) => {
  const id = (req.params.id || "").toString().trim();

  try {
    const rows = await db
      .select()
      .from(gifts as any)
      .where(or(eq((gifts as any).publicId, id), eq((gifts as any).claimToken, id)))
      .limit(1);

    const gift = rows?.[0];
    if (!gift) {
      logEvent("gift_get_not_found", { id });
      return res.status(404).json({ error: "Not found" });
    }

    return res.json({
      publicId: (gift as any).publicId,
      giftId: (gift as any).publicId,
      claimToken: (gift as any).claimToken,
      amount: (gift as any).amount,
      message: (gift as any).message,
      recipientEmail: (gift as any).recipientEmail,
      isClaimed: !!(gift as any).isClaimed,
      createdAt: (gift as any).createdAt,
      claimedAt: (gift as any).claimedAt,
    });
  } catch (e: any) {
    logEvent("gift_get_failed", { id, error: String(e?.message || e) });
    return res.status(500).json({ error: "Server error" });
  }
});

/* -------------------- CLAIM (publicId OR claimToken) -------------------- */
router.post("/api/gifts/:id/claim", async (req: Request, res: Response) => {
  const id = (req.params.id || "").toString().trim();
  const ip = safeStr(req.ip);

  logEvent("claim_attempted", { id, ip });

  try {
    const rows = await db
      .select()
      .from(gifts as any)
      .where(or(eq((gifts as any).publicId, id), eq((gifts as any).claimToken, id)))
      .limit(1);

    const gift = rows?.[0];
    if (!gift) {
      logEvent("claim_not_found", { id });
      return res.status(404).json({ error: "Not found" });
    }

    if ((gift as any).isClaimed) {
      logEvent("claim_already_claimed", { publicId: (gift as any).publicId });
      return res.status(409).json({ error: "Already claimed", code: "ALREADY_CLAIMED" });
    }

    const createdAt = (gift as any).createdAt ? new Date((gift as any).createdAt) : null;
    if (createdAt) {
      const unlockAtMs = createdAt.getTime() + minClaimDelaySec * 1000;
      const nowMs = Date.now();
      if (nowMs < unlockAtMs) {
        const unlockInSec = Math.ceil((unlockAtMs - nowMs) / 1000);
        logEvent("claim_too_soon", {
          publicId: (gift as any).publicId,
          unlockInSec,
          minClaimDelaySec: minClaimDelaySec,
        });
        return res.status(429).json({
          error: "Too soon",
          code: "TOO_SOON",
          retryAfterSec: unlockInSec,
        });
      }
    }

    const claimedAt = new Date();
    const publicId = (gift as any).publicId;

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
    logEvent("claim_failed", { id, ip, error: String(e?.message || e) });
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
