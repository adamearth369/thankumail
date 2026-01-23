import { Router } from "express";
import type { Express, Request, Response } from "express";
import crypto from "crypto";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { eq, and } from "drizzle-orm";

import { db } from "./db";
import { gifts } from "@shared/schema";
import { sendGiftEmail } from "./email";
import { sendGiftSms } from "./sms";

/* -------------------- VERSION MARKER -------------------- */
const ROUTES_VERSION = "routes_v2026-01-22_002";

/* -------------------- LOG -------------------- */
function logEvent(event: string, fields: Record<string, any> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

/* -------------------- BASE URL -------------------- */
function getClaimSiteBaseUrl() {
  const env = process.env.PUBLIC_SITE_URL || process.env.PUBLIC_CLAIM_BASE_URL || "";
  if (env) return env.replace(/\/+$/, "");
  return "https://thankumail.com";
}

/* -------------------- PRICING -------------------- */
const MIN_AMOUNT_CENTS = 1000;

/* -------------------- TURNSTILE -------------------- */
function envTruthy(v: any) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

async function verifyTurnstileOrBypass(turnstileToken: string | undefined) {
  const secret = (process.env.TURNSTILE_SECRET_KEY || "").trim();
  const bypassEnabled = envTruthy(process.env.TURNSTILE_BYPASS);
  const bypassToken = (process.env.TURNSTILE_BYPASS_TOKEN || "BYPASS").trim();

  // If Turnstile is not configured, do not enforce.
  if (!secret) {
    return { ok: true as const, mode: "not_configured" as const };
  }

  // Bypass path (explicitly enabled)
  if (bypassEnabled && (turnstileToken || "").trim() === bypassToken) {
    return { ok: true as const, mode: "bypass" as const };
  }

  // Must have a real token if secret configured
  if (!turnstileToken || !String(turnstileToken).trim()) {
    return { ok: false as const, error: "Missing CAPTCHA token", field: "turnstileToken" };
  }

  // Verify with Cloudflare Turnstile
  try {
    const body = new URLSearchParams();
    body.set("secret", secret);
    body.set("response", String(turnstileToken));

    const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });

    const data: any = await resp.json().catch(() => ({}));

    if (data?.success) {
      return { ok: true as const, mode: "verified" as const };
    }

    return { ok: false as const, error: "Invalid CAPTCHA token", field: "turnstileToken", codes: data?.["error-codes"] || [] };
  } catch (e: any) {
    return { ok: false as const, error: "CAPTCHA verification failed", field: "turnstileToken" };
  }
}

/* -------------------- VALIDATION -------------------- */
const E164 = /^\+[1-9]\d{7,14}$/;

const CreateGiftSchema = z
  .object({
    senderEmail: z.string().email(),
    recipientEmail: z.string().optional().or(z.literal("")).transform((v) => v.trim()),
    recipientPhone: z
      .string()
      .optional()
      .or(z.literal(""))
      .transform((v) => v.trim())
      .refine((v) => !v || E164.test(v), { message: "Invalid phone number" }),
    message: z.string().max(2000).optional().default(""),
    amount: z.number().optional(), // ignored
    turnstileToken: z.string().optional(),
  })
  .refine((d) => !!d.recipientEmail || !!d.recipientPhone, {
    message: "Provide recipientEmail or recipientPhone",
    path: ["recipientEmail"],
  });

const ClaimSchema = z.object({});

const createLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false });
const claimLimiter = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false });

const router = Router();

/* -------------------- HEALTH (VERSION) -------------------- */
router.get("/api/version", (_req: Request, res: Response) => {
  return res.json({ ok: true, version: ROUTES_VERSION });
});

router.get("/api/health", (_req: Request, res: Response) => {
  return res.json({ ok: true, version: ROUTES_VERSION });
});

/* -------------------- CREATE -------------------- */
router.post("/api/gifts", createLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = CreateGiftSchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues?.[0];
      const field = Array.isArray(first?.path) && first?.path?.length ? String(first.path[0]) : undefined;
      return res.status(400).json({ error: first?.message || "Invalid request", field, issues: parsed.error.issues, version: ROUTES_VERSION });
    }

    const { senderEmail, recipientEmail, recipientPhone, message, turnstileToken } = parsed.data;

    // CAPTCHA verify/bypass
    const cap = await verifyTurnstileOrBypass(turnstileToken);
    if (!cap.ok) {
      logEvent("captcha_failed", { mode: "enforced", reason: cap.error, publicId: null });
      return res.status(400).json({ error: cap.error, field: cap.field, codes: (cap as any).codes || [], version: ROUTES_VERSION });
    }

    const amount = MIN_AMOUNT_CENTS;

    const publicId = crypto.randomBytes(16).toString("hex");
    const claimUrl = `${getClaimSiteBaseUrl()}/claim/${publicId}`;

    await db.insert(gifts).values({
      publicId,
      senderEmail,
      recipientEmail: recipientEmail || null,
      recipientPhone: recipientPhone || null,
      message: message || "",
      amount,
      isClaimed: false,
      createdAt: new Date(),
    });

    logEvent("gift_created", { publicId, amount, captchaMode: cap.mode });

    let deliveryOk = true;
    let deliveryError: string | undefined;

    try {
      if (recipientEmail) {
        const r: any = await sendGiftEmail({
          to: recipientEmail,
          publicId,
          claimUrl,
          amountCents: amount,
          senderEmail,
          message,
        });
        deliveryOk = !!r?.ok;
        deliveryError = r?.ok ? undefined : r?.error || "Email delivery failed";
      } else if (recipientPhone) {
        const r: any = await sendGiftSms({ to: recipientPhone, claimUrl, publicId });
        deliveryOk = !!r?.ok;
        deliveryError = r?.ok ? undefined : r?.error || "SMS delivery failed";
      }
    } catch (e: any) {
      deliveryOk = false;
      deliveryError = e?.message || "Delivery exception";
    }

    return res.json({ ok: true, publicId, claimUrl, amount, deliveryOk, deliveryError, version: ROUTES_VERSION });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Server error", version: ROUTES_VERSION });
  }
});

/* -------------------- GET -------------------- */
router.get("/api/gifts/:publicId", async (req: Request, res: Response) => {
  const publicId = String(req.params.publicId || "").trim();
  if (!publicId) return res.status(400).json({ error: "Missing id", version: ROUTES_VERSION });

  const rows = await db.select().from(gifts).where(eq(gifts.publicId, publicId)).limit(1);
  const g: any = rows?.[0];
  if (!g) return res.status(404).json({ error: "Not found", version: ROUTES_VERSION });

  return res.json({
    ok: true,
    publicId,
    message: g.message ?? "",
    amount: g.amount ?? 0,
    isClaimed: g.isClaimed ?? false,
    createdAt: g.createdAt ?? null,
    version: ROUTES_VERSION,
  });
});

/* -------------------- CLAIM (ATOMIC) -------------------- */
router.post("/api/gifts/:publicId/claim", claimLimiter, async (req: Request, res: Response) => {
  const publicId = String(req.params.publicId || "").trim();
  if (!publicId) return res.status(400).json({ error: "Missing id", version: ROUTES_VERSION });

  const parsed = ClaimSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", version: ROUTES_VERSION });

  const rows = await db.select().from(gifts).where(eq(gifts.publicId, publicId)).limit(1);
  const g: any = rows?.[0];
  if (!g) return res.status(404).json({ error: "Not found", version: ROUTES_VERSION });

  if (g.isClaimed) return res.status(400).json({ error: "Already claimed", code: "ALREADY_CLAIMED", version: ROUTES_VERSION });

  const minDelaySec = Number(process.env.MIN_CLAIM_DELAY_SEC || 0);
  if (minDelaySec > 0 && g.createdAt) {
    const ageSec = Math.floor((Date.now() - new Date(g.createdAt).getTime()) / 1000);
    if (ageSec < minDelaySec) {
      return res.status(400).json({
        error: "Please wait a moment before claiming.",
        code: "TOO_SOON",
        retryAfterSec: minDelaySec - ageSec,
        version: ROUTES_VERSION,
      });
    }
  }

  const result = await db
    .update(gifts)
    .set({ isClaimed: true, claimedAt: new Date() })
    .where(and(eq(gifts.publicId, publicId), eq(gifts.isClaimed, false)))
    .returning();

  if (!result || result.length === 0) {
    return res.status(400).json({ error: "Already claimed", code: "ALREADY_CLAIMED", version: ROUTES_VERSION });
  }

  logEvent("gift_claimed", { publicId });
  return res.json({ ok: true, version: ROUTES_VERSION });
});

export function registerRoutes(app: Express) {
  app.use(router);
}

export default router;
