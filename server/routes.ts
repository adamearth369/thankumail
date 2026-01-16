// ===============================
// FILE TO REPLACE (FULL FILE)
// WHERE TO PASTE: server/routes.ts
//
// PURPOSE (THIS STEP):
// - Enforce NON-KYC users can ONLY send preset messages (no custom text)
// - Keep existing endpoints:
//    POST /api/gifts
//    GET  /api/gifts/:publicId
//    POST /api/gifts/:publicId/claim
// - Keep Turnstile verification (+ optional dev bypass)
// - Use db.select (NOT db.query) to avoid runtime crashes
// - Make server response compatible with BOTH client UIs (publicId + giftId + claimUrl + claimLink)
// ===============================

import type { Express } from "express";
import type { Server } from "http";
import { Router } from "express";
import crypto from "crypto";
import { db } from "./db";
import { gifts } from "@shared/schema";
import { eq } from "drizzle-orm";
import { sendGiftEmail } from "./email";

/* -------------------- PRESET MESSAGES (NON-KYC ONLY) -------------------- */
const PRESET_MESSAGES = [
  "Someone wanted you to know they’re genuinely grateful for you. Thank you.",
  "What you did made a real difference — you matter to someone. Thank you.",
  "This message is a simple expression of appreciation from someone who noticed. Thank you.",
  "Someone wanted to send you encouragement, because you deserve it. Thank you.",
  "You matter to people in a meaningful way. Your presence and actions had a positive impact. Thank you.",
  "Someone thought of you today and decided to send you a message of gratitude and kindness. Thank you.",
] as const;

/* -------------------- CONFIG -------------------- */
const MIN_AMOUNT_CENTS = 1000;
const MIN_CLAIM_DELAY_SEC = Number(process.env.MIN_CLAIM_DELAY_SEC || 60);

const TURNSTILE_SECRET =
  process.env.TURNSTILE_SECRET_KEY ||
  process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY ||
  "";

// DEV/TEST bypass (ONLY for testing)
const TURNSTILE_BYPASS = (process.env.TURNSTILE_BYPASS || "").toString() === "1";

// Optional allowlist for bypass
// Example: TURNSTILE_BYPASS_IPS="208.114.128.15,1.2.3.4"
const TURNSTILE_BYPASS_IPS = (process.env.TURNSTILE_BYPASS_IPS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/* -------------------- HELPERS -------------------- */
function nowIso() {
  return new Date().toISOString();
}

function logEvent(event: string, fields: Record<string, any> = {}) {
  console.log(JSON.stringify({ ts: nowIso(), event, ...fields }));
}

function getIp(req: any) {
  const xf = (req.headers["x-forwarded-for"] || "").toString();
  const ip = xf.split(",")[0]?.trim();
  return ip || req.ip || "";
}

function secondsBetween(a: Date, b: Date) {
  return Math.floor((b.getTime() - a.getTime()) / 1000);
}

function clampInt(n: number) {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : Math.floor(n);
}

function baseUrlFromReq(req: any) {
  const envBase = process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "";
  if (envBase) return envBase.replace(/\/+$/, "");
  const proto = (req.headers["x-forwarded-proto"] || "https").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return `${proto}://${host}`.replace(/\/+$/, "");
}

function computeUnlockInSec(createdAt: Date) {
  const elapsed = secondsBetween(createdAt, new Date());
  const remaining = MIN_CLAIM_DELAY_SEC - elapsed;
  return clampInt(remaining);
}

/* -------------------- TURNSTILE -------------------- */
function bypassAllowed(ip: string) {
  if (!TURNSTILE_BYPASS) return false;
  if (TURNSTILE_BYPASS_IPS.length === 0) return true;
  return TURNSTILE_BYPASS_IPS.includes(ip);
}

async function verifyTurnstile(turnstileToken: string, ip: string) {
  // DEV/TEST bypass
  if (bypassAllowed(ip)) {
    logEvent("turnstile_bypassed", { ip });
    return { ok: true as const };
  }

  if (!turnstileToken) {
    return { ok: false as const, codes: ["missing-input-response"] };
  }

  if (!TURNSTILE_SECRET) {
    logEvent("turnstile_secret_missing");
    return { ok: false as const, codes: ["missing-secret"] };
  }

  try {
    const form = new URLSearchParams();
    form.set("secret", TURNSTILE_SECRET);
    form.set("response", turnstileToken);
    if (ip) form.set("remoteip", ip);

    const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    const json: any = await resp.json().catch(() => null);
    const success = !!json?.success;

    if (!success) {
      logEvent("turnstile_failed", { ip, codes: json?.["error-codes"] || [] });
      return { ok: false as const, codes: json?.["error-codes"] || [] };
    }

    logEvent("turnstile_passed", { ip });
    return { ok: true as const };
  } catch (e: any) {
    logEvent("turnstile_error", { ip, error: String(e?.message || e) });
    return { ok: false as const, codes: ["turnstile_unreachable"] };
  }
}

/* -------------------- ROUTES -------------------- */
const router = Router();

/* ==================================================
   POST /api/gifts
   - NON-KYC: preset messages only (locked)
================================================== */
router.post("/api/gifts", async (req, res) => {
  const ip = getIp(req);

  const recipientEmail = (req.body?.recipientEmail || "").toString().trim();
  const message = (req.body?.message || "").toString();
  const amount = Number(req.body?.amount);

  const turnstileToken = (req.body?.turnstileToken || "").toString().trim();

  // Verify Turnstile (unless bypass enabled)
  const ts = await verifyTurnstile(turnstileToken, ip);
  if (!ts.ok) {
    return res.status(400).json({
      error: "Missing CAPTCHA token",
      field: "turnstileToken",
      codes: (ts as any).codes || [],
    });
  }

  if (!recipientEmail || !recipientEmail.includes("@")) {
    return res.status(400).json({ error: "Invalid recipient email", field: "recipientEmail" });
  }

  if (!Number.isFinite(amount) || amount < MIN_AMOUNT_CENTS) {
    return res.status(400).json({ error: "Minimum amount is $10", field: "amount" });
  }

  // -------------------- NON-KYC MESSAGE LOCK --------------------
  // Step-1 implementation: treat ALL senders as NON-KYC.
  // Later you will replace this with real KYC verification.
  const isKycVerified = false;

  const msg = message.trim();
  if (!isKycVerified) {
    const allowed = (PRESET_MESSAGES as readonly string[]).includes(msg);
    if (!allowed) {
      return res.status(403).json({
        error: "Custom messages require identity verification.",
        field: "message",
        code: "KYC_REQUIRED",
      });
    }
  }
  // --------------------------------------------------------------

  // Generate IDs
  const publicId = crypto.randomBytes(12).toString("hex");
  const claimToken = crypto.randomBytes(12).toString("hex");

  try {
    const [gift] = await db
      .insert(gifts)
      .values({
        publicId,
        recipientEmail,
        message: msg,
        amount,
        isClaimed: false,
        claimToken,
      } as any)
      .returning();

    const base = baseUrlFromReq(req);
    const claimUrl = `${base}/claim/${claimToken}`;

    logEvent("gift_created", {
      publicId: (gift as any).publicId || publicId,
      amount,
      recipientDomain: recipientEmail.split("@")[1] || "",
      ip,
      minClaimDelaySec: MIN_CLAIM_DELAY_SEC,
      claimUrl,
    });

    // Email send (best effort)
    const pid = (gift as any).publicId || publicId;
    logEvent("email_send_queued", { publicId: pid });

    const emailRes = await sendGiftEmail({
      to: recipientEmail,
      claimLink: claimUrl,
      message: msg,
      amountCents: amount,
    });

    if (emailRes.ok) {
      logEvent("email_sent", { publicId: pid, toDomain: recipientEmail.split("@")[1] || "" });
    } else {
      logEvent("email_send_failed", { publicId: pid, error: emailRes.error });
    }

    // IMPORTANT: respond with multiple aliases for compatibility across client variants
    return res.json({
      success: true,

      // new/legacy client compatibility
      publicId: pid,
      giftId: pid,

      claimUrl,
      claimLink: claimUrl,

      emailSent: emailRes.ok,
      email: { ok: emailRes.ok },
    });
  } catch (e: any) {
    logEvent("gift_create_failed", { ip, error: String(e?.message || e) });
    return res.status(500).json({ error: "Failed to create gift" });
  }
});

/* ==================================================
   GET /api/gifts/:publicId
================================================== */
router.get("/api/gifts/:publicId", async (req, res) => {
  const publicId = (req.params.publicId || "").toString().trim();

  try {
    const rows = await db
      .select()
      .from(gifts as any)
      .where(eq((gifts as any).publicId, publicId))
      .limit(1);

    const gift = rows?.[0];
    if (!gift) return res.status(404).json({ error: "Not found" });

    const createdAt = new Date((gift as any).createdAt);
    const unlockInSec = computeUnlockInSec(createdAt);

    return res.json({
      publicId: (gift as any).publicId,
      amount: (gift as any).amount,
      message: (gift as any).message,
      isClaimed: (gift as any).isClaimed,
      createdAt: (gift as any).createdAt,
      claimedAt: (gift as any).claimedAt,
      minClaimDelaySec: MIN_CLAIM_DELAY_SEC,
      unlockInSec,
    });
  } catch (e: any) {
    logEvent("gift_get_failed", { publicId, error: String(e?.message || e) });
    return res.status(500).json({ error: "Failed to load gift" });
  }
});

/* ==================================================
   POST /api/gifts/:publicId/claim  (delay enforced)
================================================== */
router.post("/api/gifts/:publicId/claim", async (req, res) => {
  const ip = getIp(req);
  const publicId = (req.params.publicId || "").toString().trim();

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
      return res.status(404).json({ error: "Gift not found" });
    }

    if ((gift as any).isClaimed) {
      logEvent("claim_already_claimed", { publicId });
      return res.status(409).json({ error: "Already claimed" });
    }

    const createdAt = new Date((gift as any).createdAt);
    const unlockInSec = computeUnlockInSec(createdAt);

    if (unlockInSec > 0) {
      logEvent("claim_too_soon", { publicId, unlockInSec, minClaimDelaySec: MIN_CLAIM_DELAY_SEC });
      return res.status(429).json({
        error: "Please wait before claiming",
        retryAfterSec: unlockInSec,
      });
    }

    const claimedAt = new Date();

    const updated = await db
      .update(gifts as any)
      .set({ isClaimed: true, claimedAt } as any)
      .where(eq((gifts as any).publicId, publicId))
      .returning();

    if (!updated || updated.length === 0) {
      logEvent("claim_update_failed", { publicId });
      return res.status(409).json({ error: "Already claimed" });
    }

    logEvent("claim_completed", { publicId, claimedAt: claimedAt.toISOString() });

    return res.json({
      ok: true,
      publicId,
      claimedAt: claimedAt.toISOString(),
      gift: updated[0],
    });
  } catch (e: any) {
    logEvent("claim_failed", { publicId, ip, error: String(e?.message || e) });
    return res.status(500).json({ error: "Claim failed" });
  }
});

/* -------------------- REGISTER ROUTES -------------------- */
export function registerRoutes(httpServer: Server, app: Express) {
  app.use(router);
  return httpServer;
}

export default router;
