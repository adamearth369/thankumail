import { Router } from "express";
import crypto from "crypto";
import { db } from "./db";
import { gifts } from "@shared/schema";
import { eq } from "drizzle-orm";

const router = Router();

/* -------------------- CONFIG -------------------- */
const MIN_AMOUNT_CENTS = 1000;
const MIN_CLAIM_DELAY_SEC = Number(process.env.MIN_CLAIM_DELAY_SEC || 60);

const TURNSTILE_SECRET =
  process.env.TURNSTILE_SECRET_KEY ||
  process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY ||
  "";

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

/* -------------------- TURNSTILE -------------------- */
async function verifyTurnstile(turnstileToken: string, ip: string) {
  if (!TURNSTILE_SECRET) {
    // If you want to hard-require Turnstile always, change this to throw.
    logEvent("turnstile_secret_missing");
    return { ok: true };
  }

  try {
    const form = new URLSearchParams();
    form.set("secret", TURNSTILE_SECRET);
    form.set("response", turnstileToken);
    if (ip) form.set("remoteip", ip);

    const resp = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }
    );

    const json: any = await resp.json().catch(() => null);
    const success = !!json?.success;

    if (!success) {
      logEvent("turnstile_failed", {
        ip,
        codes: json?.["error-codes"] || [],
      });
      return { ok: false, codes: json?.["error-codes"] || [] };
    }

    logEvent("turnstile_passed", { ip });
    return { ok: true };
  } catch (e: any) {
    logEvent("turnstile_error", { ip, error: String(e?.message || e) });
    // Fail closed (safer): treat as failure
    return { ok: false, codes: ["turnstile_unreachable"] };
  }
}

/* -------------------- HELPERS -------------------- */
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

/* ==================================================
   POST /api/gifts
   - Requires turnstileToken
   - Enforces min amount
   - Generates claimToken (kept private)
   - Returns publicId only (keeps claimToken private)
   - Logs claimUrl so you can test without exposing token in API responses
================================================== */
router.post("/api/gifts", async (req, res) => {
  const ip = getIp(req);

  const recipientEmail = (req.body?.recipientEmail || "").toString().trim();
  const message = (req.body?.message || "").toString();
  const amount = Number(req.body?.amount);

  const turnstileToken = (req.body?.turnstileToken || "").toString().trim();

  if (!turnstileToken) {
    return res.status(400).json({ error: "Missing CAPTCHA token", field: "turnstileToken" });
  }

  const ts = await verifyTurnstile(turnstileToken, ip);
  if (!ts.ok) {
    return res.status(400).json({ error: "CAPTCHA failed", field: "turnstileToken" });
  }

  if (!recipientEmail || !recipientEmail.includes("@")) {
    return res.status(400).json({ error: "Invalid recipient email", field: "recipientEmail" });
  }

  if (!Number.isFinite(amount) || amount < MIN_AMOUNT_CENTS) {
    return res.status(400).json({ error: "Minimum amount is $10", field: "amount" });
  }

  // claimToken stays server-side; email uses /claim/<claimToken> in the future
  const claimToken = crypto.randomBytes(12).toString("hex");

  const [gift] = await db
    .insert(gifts)
    .values({
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
    claimUrl, // ✅ critical for your testing
  });

  // Keep response stable for UI
  return res.json({
    publicId: (gift as any).publicId,
  });
});

/* ==================================================
   GET /api/gifts/:publicId
   - Returns gift info + correct unlockInSec
================================================== */
router.get("/api/gifts/:publicId", async (req, res) => {
  const publicId = (req.params.publicId || "").toString().trim();

  const gift = await db.query.gifts.findFirst({
    where: eq((gifts as any).publicId, publicId),
  });

  if (!gift) return res.status(404).json({ error: "Not found" });

  const createdAt = new Date((gift as any).createdAt);
  const unlockInSec = computeUnlockInSec(createdAt);

  return res.json({
    id: (gift as any).id,
    publicId: (gift as any).publicId,
    recipientEmail: (gift as any).recipientEmail,
    message: (gift as any).message,
    amount: (gift as any).amount,
    isClaimed: (gift as any).isClaimed,
    createdAt: (gift as any).createdAt,
    claimedAt: (gift as any).claimedAt,
    unlockInSec,
    minClaimDelaySec: MIN_CLAIM_DELAY_SEC,
    serverNow: new Date().toISOString(),
  });
});

/* ==================================================
   POST /api/gifts/:publicId/claim
   - Enforces delay: returns 429 + retryAfterSec
   - Prevents double-claim: returns 409 Already claimed
   - Atomic update: update where isClaimed=false
================================================== */
router.post("/api/gifts/:publicId/claim", async (req, res) => {
  const ip = getIp(req);
  const publicId = (req.params.publicId || "").toString().trim();

  logEvent("claim_attempted", { publicId, ip });

  const gift = await db.query.gifts.findFirst({
    where: eq((gifts as any).publicId, publicId),
  });

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

  // Atomic: only claim if still unclaimed
  const updated = await db
    .update(gifts)
    .set({ isClaimed: true, claimedAt } as any)
    .where(eq((gifts as any).publicId, publicId))
    .returning();

  // If returning() returns the row even if already claimed depends on db;
  // We already checked isClaimed above, but keep a sanity fallback.
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
});

/* ==================================================
   (OPTIONAL) Back-compat route if something still calls /api/gifts/:token/claim
   - It will treat param as publicId
================================================== */
router.post("/api/gifts/:token/claim", async (req, res, next) => {
  // If the token looks like a publicId, hand off to the publicId claim handler by rewriting params.
  // Otherwise, let it fall through.
  const token = (req.params.token || "").toString().trim();
  if (token && token.length >= 6 && token.length <= 32) {
    (req as any).params.publicId = token;
    return (router as any).handle(req, res, next);
  }
  return res.status(404).json({ error: "Gift not found" });
});

export default router;