import type { Server } from "http";
import type { Express } from "express";
import { Router } from "express";
import crypto from "crypto";
import { db } from "./db";
import { gifts } from "@shared/schema";
import { eq } from "drizzle-orm";
import { sendGiftEmail } from "./email";

const router = Router();

/* -------------------- CONFIG -------------------- */
const MIN_AMOUNT_CENTS = 1000;
const MIN_CLAIM_DELAY_SEC = Number(process.env.MIN_CLAIM_DELAY_SEC || 60);

const TURNSTILE_SECRET =
  process.env.TURNSTILE_SECRET_KEY ||
  process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY ||
  "";

const TURNSTILE_BYPASS = (process.env.TURNSTILE_BYPASS || "").toString() === "1";

const TURNSTILE_BYPASS_IPS = (process.env.TURNSTILE_BYPASS_IPS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// hard timeout for email send so we always log something
const EMAIL_SEND_TIMEOUT_MS = Number(process.env.EMAIL_SEND_TIMEOUT_MS || 12000);

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

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: any;
  const timeout = new Promise<T>((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label}_timeout_${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

/* -------------------- DB HELPERS -------------------- */
async function getGiftByPublicId(publicId: string) {
  const rows = await db
    .select()
    .from(gifts as any)
    .where(eq((gifts as any).publicId, publicId))
    .limit(1);
  return rows?.[0] || null;
}

/* -------------------- TURNSTILE -------------------- */
function bypassAllowed(ip: string) {
  if (!TURNSTILE_BYPASS) return false;
  if (TURNSTILE_BYPASS_IPS.length === 0) return true;
  return TURNSTILE_BYPASS_IPS.includes(ip);
}

async function verifyTurnstile(turnstileToken: string, ip: string) {
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

/* ==================================================
   POST /api/gifts
================================================== */
router.post("/api/gifts", async (req, res) => {
  const ip = getIp(req);

  const recipientEmail = (req.body?.recipientEmail || "").toString().trim();
  const message = (req.body?.message || "").toString();
  const amount = Number(req.body?.amount);

  const turnstileToken = (req.body?.turnstileToken || "").toString().trim();

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

  const publicId = crypto.randomBytes(12).toString("hex");
  const claimToken = crypto.randomBytes(12).toString("hex");

  try {
    const [gift] = await db
      .insert(gifts as any)
      .values({
        publicId,
        recipientEmail,
        message,
        amount,
        isClaimed: false,
        claimToken,
      } as any)
      .returning();

    const base = baseUrlFromReq(req);
    const claimUrl = `${base}/claim/${claimToken}`;

    logEvent("gift_created", {
      publicId: (gift as any).publicId,
      amount,
      recipientDomain: recipientEmail.split("@")[1] || "",
      ip,
      minClaimDelaySec: MIN_CLAIM_DELAY_SEC,
      claimUrl,
    });

    // Non-blocking email send: always logs queued + sent/failed
    logEvent("email_send_queued", { publicId: (gift as any).publicId });

    (async () => {
      try {
        await withTimeout(
          sendGiftEmail({
            to: recipientEmail,
            claimUrl,
            message,
            amountCents: amount,
          } as any),
          EMAIL_SEND_TIMEOUT_MS,
          "sendGiftEmail"
        );

        logEvent("email_sent", {
          publicId: (gift as any).publicId,
          toDomain: recipientEmail.split("@")[1] || "",
        });
      } catch (e: any) {
        logEvent("email_failed", {
          publicId: (gift as any).publicId,
          error: String(e?.message || e),
        });
      }
    })();

    return res.json({ publicId: (gift as any).publicId });
  } catch (e: any) {
    logEvent("gift_create_error", { ip, error: String(e?.message || e) });
    return res.status(500).json({ error: "Failed to create gift" });
  }
});

/* ==================================================
   GET /api/gifts/:publicId
================================================== */
router.get("/api/gifts/:publicId", async (req, res) => {
  const publicId = (req.params.publicId || "").toString().trim();

  try {
    const gift = await getGiftByPublicId(publicId);
    if (!gift) return res.status(404).json({ error: "Not found" });

    const createdAtRaw = (gift as any).createdAt;
    const createdAt = createdAtRaw ? new Date(createdAtRaw) : new Date();
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
    logEvent("gift_get_error", { publicId, error: String(e?.message || e) });
    return res.status(500).json({ error: "Failed to fetch gift" });
  }
});

/* ==================================================
   POST /api/gifts/:publicId/claim
================================================== */
router.post("/api/gifts/:publicId/claim", async (req, res) => {
  const ip = getIp(req);
  const publicId = (req.params.publicId || "").toString().trim();

  try {
    logEvent("claim_attempted", { publicId, ip });

    const gift = await getGiftByPublicId(publicId);
    if (!gift) {
      logEvent("claim_not_found", { publicId });
      return res.status(404).json({ error: "Gift not found" });
    }

    if ((gift as any).isClaimed) {
      logEvent("claim_already_claimed", { publicId });
      return res.status(409).json({ error: "Already claimed" });
    }

    const createdAtRaw = (gift as any).createdAt;
    const createdAt = createdAtRaw ? new Date(createdAtRaw) : new Date();
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
    logEvent("claim_error", { publicId, ip, error: String(e?.message || e) });
    return res.status(500).json({ error: "Failed to claim gift" });
  }
});

export async function registerRoutes(_httpServer: Server, app: Express) {
  app.use(router);
}

export default router;
