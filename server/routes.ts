// server/routes.ts
import { Router } from "express";
import type { Request, Response } from "express";
import crypto from "crypto";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { eq, and, isNull, lte, or, lt, gte, not } from "drizzle-orm";

import { db } from "./db";
import { gifts } from "@shared/schema";
import { sendGiftEmail, sendReminderEmail, sendReturnToSenderEmail } from "./email";
import { sendGiftSms } from "./sms";

/* -------------------- STRUCTURED LOGGING -------------------- */
function logEvent(event: string, fields: Record<string, any> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

/* -------------------- BASE URL HELPERS -------------------- */
function getClaimSiteBaseUrl() {
  const env = process.env.PUBLIC_SITE_URL || process.env.PUBLIC_CLAIM_BASE_URL || "";
  if (env) return env.replace(/\/+$/, "");
  return "https://thankumail.com";
}

/* -------------------- TURNSTILE (OPTIONAL) -------------------- */
async function verifyTurnstile(token: string, remoteip?: string) {
  const secret = process.env.TURNSTILE_SECRET_KEY || "";
  if (!secret) return { ok: true as const };
  if (!token) return { ok: false as const, error: "Missing CAPTCHA token" };

  try {
    const form = new URLSearchParams();
    form.set("secret", secret);
    form.set("response", token);
    if (remoteip) form.set("remoteip", remoteip);

    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    const json: any = await res.json().catch(() => null);
    if (json && json.success) return { ok: true as const };
    return { ok: false as const, error: "Invalid CAPTCHA token" };
  } catch {
    return { ok: false as const, error: "CAPTCHA verification failed" };
  }
}

/* -------------------- VALIDATION -------------------- */
const E164 = /^\+[1-9]\d{7,14}$/;

const CreateGiftSchema = z
  .object({
    senderEmail: z.string().email(),

    recipientEmail: z
      .string()
      .optional()
      .or(z.literal(""))
      .transform((v) => (typeof v === "string" ? v.trim() : "")),

    recipientPhone: z
      .string()
      .optional()
      .or(z.literal(""))
      .transform((v) => (typeof v === "string" ? v.trim() : ""))
      .refine((v) => !v || E164.test(v), {
        message: "Invalid phone number (use E.164 like +15551234567)",
      }),

    message: z.string().max(2000).optional().default(""),
    amount: z.number().int().min(1000),
    turnstileToken: z.string().optional(),
  })
  .refine((d) => !!d.recipientEmail || !!d.recipientPhone, {
    message: "Provide recipientEmail or recipientPhone",
    path: ["recipientEmail"],
  });

const ClaimSchema = z.object({
  // optional, depending on your future claim UX
  turnstileToken: z.string().optional(),
});

/* -------------------- RATE LIMITS -------------------- */
const createLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

const claimLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

/* -------------------- SCHEMA-AWARE COLUMN PICKERS -------------------- */
function pickCol(...candidates: string[]) {
  for (const k of candidates) {
    if ((gifts as any)[k]) return (gifts as any)[k];
  }
  return null;
}

const COL_PUBLIC_ID = () => pickCol("publicId", "public_id", "publicID");
const COL_SENDER_EMAIL = () => pickCol("senderEmail", "sender_email");
const COL_RECIPIENT_EMAIL = () => pickCol("recipientEmail", "recipient_email");
const COL_RECIPIENT_PHONE = () => pickCol("recipientPhone", "recipient_phone");
const COL_MESSAGE = () => pickCol("message");
const COL_AMOUNT = () => pickCol("amount");
const COL_IS_CLAIMED = () => pickCol("isClaimed", "is_claimed");
const COL_CREATED_AT = () => pickCol("createdAt", "created_at");
const COL_CLAIMED_AT = () => pickCol("claimedAt", "claimed_at");

/* -------------------- ROUTER -------------------- */
const router = Router();

/* -------------------- CORE: CREATE GIFT -------------------- */
router.post("/api/gifts", createLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = CreateGiftSchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues?.[0];
      return res.status(400).json({
        error: first?.message || "Invalid request",
        field: first?.path?.[0],
        issues: parsed.error.issues,
      });
    }

    const { senderEmail, recipientEmail, recipientPhone, message, amount, turnstileToken } = parsed.data;

    // Optional Turnstile enforcement (only enforced if TURNSTILE_SECRET_KEY is set)
    const remoteip = req.headers["cf-connecting-ip"]?.toString() || req.ip;
    const captcha = await verifyTurnstile(turnstileToken || "", remoteip);
    if (!captcha.ok) return res.status(400).json({ error: captcha.error, field: "turnstileToken" });

    const pubCol = COL_PUBLIC_ID();
    if (!pubCol) return res.status(500).json({ error: "Server misconfigured: missing publicId column" });

    const publicId = crypto.randomBytes(16).toString("hex");
    const claimUrl = `${getClaimSiteBaseUrl()}/claim/${publicId}`;

    // Build insert payload using whichever columns exist
    const insertRow: Record<string, any> = {};
    const senderCol = COL_SENDER_EMAIL();
    const recEmailCol = COL_RECIPIENT_EMAIL();
    const recPhoneCol = COL_RECIPIENT_PHONE();
    const msgCol = COL_MESSAGE();
    const amtCol = COL_AMOUNT();
    const isClaimedCol = COL_IS_CLAIMED();
    const createdAtCol = COL_CREATED_AT();

    if (senderCol) insertRow[(senderCol as any).name ?? "senderEmail"] = senderEmail;
    if (recEmailCol) insertRow[(recEmailCol as any).name ?? "recipientEmail"] = recipientEmail || null;
    if (recPhoneCol) insertRow[(recPhoneCol as any).name ?? "recipientPhone"] = recipientPhone || null;
    if (msgCol) insertRow[(msgCol as any).name ?? "message"] = message || "";
    if (amtCol) insertRow[(amtCol as any).name ?? "amount"] = amount;
    if (isClaimedCol) insertRow[(isClaimedCol as any).name ?? "isClaimed"] = false;
    if (createdAtCol) insertRow[(createdAtCol as any).name ?? "createdAt"] = new Date();

    // Always set publicId using discovered column key
    insertRow[(pubCol as any).name ?? "publicId"] = publicId;

    await db.insert(gifts).values(insertRow as any);

    logEvent("gift_created", {
      publicId,
      senderEmail,
      hasRecipientEmail: !!recipientEmail,
      hasRecipientPhone: !!recipientPhone,
      amount,
    });

    // Send delivery (email or sms)
    let delivery: { ok: boolean; error?: string } = { ok: true };

    if (recipientEmail) {
      delivery = await sendGiftEmail({
        to: recipientEmail,
        publicId,
        claimUrl,
        amountCents: amount,
        senderEmail,
        message,
      });
      logEvent("gift_email_sent", { publicId, ok: delivery.ok, error: delivery.error || null });
    } else if (recipientPhone) {
      delivery = await sendGiftSms({ to: recipientPhone, claimUrl, publicId });
      logEvent("gift_sms_sent", { publicId, ok: delivery.ok, error: delivery.error || null });
    }

    // Return success even if delivery fails (so sender can copy link)
    return res.json({
      ok: true,
      publicId,
      claimUrl,
      deliveryOk: delivery.ok,
      deliveryError: delivery.ok ? undefined : delivery.error || "Delivery failed",
    });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
});

/* -------------------- CORE: GET GIFT (for claim page) -------------------- */
router.get("/api/gifts/:publicId", async (req: Request, res: Response) => {
  const publicId = String(req.params.publicId || "").trim();
  if (!publicId) return res.status(400).json({ error: "Missing id" });

  const pubCol = COL_PUBLIC_ID();
  if (!pubCol) return res.status(500).json({ error: "Server misconfigured: missing publicId column" });

  const rows = await db
    .select()
    .from(gifts)
    .where(eq(pubCol as any, publicId))
    .limit(1);

  const g: any = rows?.[0];
  if (!g) return res.status(404).json({ error: "Not found" });

  const msgCol = COL_MESSAGE();
  const amtCol = COL_AMOUNT();
  const isClaimedCol = COL_IS_CLAIMED();
  const createdAtCol = COL_CREATED_AT();

  return res.json({
    ok: true,
    publicId,
    message: msgCol ? g[(msgCol as any).name ?? "message"] : g.message,
    amount: amtCol ? g[(amtCol as any).name ?? "amount"] : g.amount,
    isClaimed: isClaimedCol ? g[(isClaimedCol as any).name ?? "isClaimed"] : g.isClaimed,
    createdAt: createdAtCol ? g[(createdAtCol as any).name ?? "createdAt"] : g.createdAt,
  });
});

/* -------------------- CORE: CLAIM GIFT -------------------- */
router.post("/api/gifts/:publicId/claim", claimLimiter, async (req: Request, res: Response) => {
  const publicId = String(req.params.publicId || "").trim();
  if (!publicId) return res.status(400).json({ error: "Missing id" });

  const pubCol = COL_PUBLIC_ID();
  if (!pubCol) return res.status(500).json({ error: "Server misconfigured: missing publicId column" });

  // Optional schema check (kept for future Turnstile-on-claim)
  const parsed = ClaimSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Invalid request" });

  const rows = await db
    .select()
    .from(gifts)
    .where(eq(pubCol as any, publicId))
    .limit(1);

  const g: any = rows?.[0];
  if (!g) return res.status(404).json({ error: "Not found" });

  const isClaimedCol = COL_IS_CLAIMED();
  const createdAtCol = COL_CREATED_AT();
  const claimedAtCol = COL_CLAIMED_AT();

  const isClaimed =
    isClaimedCol ? !!g[(isClaimedCol as any).name ?? "isClaimed"] : !!g.isClaimed;

  if (isClaimed) return res.status(400).json({ error: "Already claimed", code: "ALREADY_CLAIMED" });

  // Optional minimum delay
  const minDelaySec = Number(process.env.MIN_CLAIM_DELAY_SEC || 0);
  if (minDelaySec > 0 && createdAtCol) {
    const createdAt = new Date(g[(createdAtCol as any).name ?? "createdAt"]);
    const now = Date.now();
    const ageSec = Math.floor((now - createdAt.getTime()) / 1000);
    if (ageSec < minDelaySec) {
      return res.status(400).json({
        error: "Please wait a moment before claiming.",
        code: "TOO_SOON",
        retryAfterSec: minDelaySec - ageSec,
      });
    }
  }

  const updateRow: Record<string, any> = {};
  if (isClaimedCol) updateRow[(isClaimedCol as any).name ?? "isClaimed"] = true;
  if (claimedAtCol) updateRow[(claimedAtCol as any).name ?? "claimedAt"] = new Date();

  await db.update(gifts).set(updateRow as any).where(eq(pubCol as any, publicId));

  logEvent("gift_claimed", { publicId });

  return res.json({ ok: true });
});

/* -------------------- ADMIN: REMINDERS + RETURN TO SENDER -------------------- */
/**
 * Behavior:
 * - Max 2 reminders, spaced >= 48 hours apart
 * - After 2 reminders, wait >= 48 hours, then "return to sender"
 */
router.post("/api/admin/reminders/send", async (req: Request, res: Response) => {
  const token = String(req.header("x-admin-token") || "");
  const expected = process.env.ADMIN_TOKEN || "";
  if (!expected || token !== expected) return res.status(401).json({ ok: false, error: "Unauthorized" });

  const dryRun = !!req.body?.dryRun;
  const olderThanHours = Number(req.body?.olderThanHours ?? 48);
  const limit = Math.min(200, Math.max(1, Number(req.body?.limit ?? 50)));

  const now = new Date();
  const cutoffCreated = new Date(now.getTime() - olderThanHours * 3600_000);
  const cutoff48h = new Date(now.getTime() - 48 * 3600_000);

  const pubCol = COL_PUBLIC_ID();
  if (!pubCol) return res.status(500).json({ ok: false, error: "Server misconfigured: missing publicId column" });

  const isClaimedCol = (gifts as any).isClaimed;
  const createdAtCol = (gifts as any).createdAt;
  const reminderCountCol = (gifts as any).reminderCount;
  const lastReminderSentAtCol = (gifts as any).lastReminderSentAt;
  const returnedToSenderAtCol = (gifts as any).returnedToSenderAt;

  if (!isClaimedCol || !createdAtCol || !reminderCountCol || !lastReminderSentAtCol || !returnedToSenderAtCol) {
    return res.status(500).json({ ok: false, error: "Server misconfigured: reminder columns missing" });
  }

  // 1) Eligible for reminders (MAX 2)
  const reminderRows = await db
    .select()
    .from(gifts)
    .where(
      and(
        eq(isClaimedCol, false),
        lte(createdAtCol, cutoffCreated),
        isNull(returnedToSenderAtCol),
        lt(reminderCountCol, 2),
        or(isNull(lastReminderSentAtCol), lte(lastReminderSentAtCol, cutoff48h))
      )
    )
    .limit(limit);

  // 2) Eligible for return-to-sender (after 2 reminders + 48h)
  const returnRows = await db
    .select()
    .from(gifts)
    .where(
      and(
        eq(isClaimedCol, false),
        isNull(returnedToSenderAtCol),
        gte(reminderCountCol, 2),
        not(isNull(lastReminderSentAtCol)),
        lte(lastReminderSentAtCol, cutoff48h)
      )
    )
    .limit(limit);

  let sent = 0;
  let failed = 0;
  const actions: any[] = [];

  // REMINDERS
  for (const g of reminderRows as any[]) {
    const publicId = g.publicId ?? g.public_id ?? g.publicID;
    const claimUrl = `${getClaimSiteBaseUrl()}/claim/${publicId}`;

    const recipientEmail = g.recipientEmail ?? g.recipient_email ?? null;
    const recipientPhone = g.recipientPhone ?? g.recipient_phone ?? null;
    const senderEmail = g.senderEmail ?? g.sender_email ?? "";
    const amount = g.amount ?? 0;

    let ok = false;
    let error: string | null = null;

    try {
      if (recipientEmail) {
        if (!dryRun) {
          const r = await sendReminderEmail({ to: recipientEmail, publicId, claimUrl, amountCents: amount, senderEmail });
          ok = r.ok;
          error = r.error || null;
        } else ok = true;
      } else if (recipientPhone) {
        if (!dryRun) {
          const r = await sendGiftSms({ to: recipientPhone, claimUrl, publicId });
          ok = r.ok;
          error = r.error || null;
        } else ok = true;
      } else {
        ok = false;
        error = "No recipient email or phone";
      }
    } catch (e: any) {
      ok = false;
      error = e?.message || "Unknown error";
    }

    if (ok) {
      sent++;
      actions.push({ publicId, action: "reminder", ok: true });

      if (!dryRun) {
        await db
          .update(gifts)
          .set({
            reminderCount: Number(g.reminderCount ?? g.reminder_count ?? 0) + 1,
            lastReminderSentAt: new Date(),
          } as any)
          .where(eq(pubCol as any, publicId));
      }
    } else {
      failed++;
      actions.push({ publicId, action: "reminder", ok: false, error });
    }
  }

  // RETURN TO SENDER
  for (const g of returnRows as any[]) {
    const publicId = g.publicId ?? g.public_id ?? g.publicID;
    const senderEmail = g.senderEmail ?? g.sender_email ?? "";
    const amount = g.amount ?? 0;

    if (!senderEmail) {
      failed++;
      actions.push({ publicId, action: "return_to_sender", ok: false, error: "Missing sender email" });
      continue;
    }

    try {
      let ok = true;
      let error: string | null = null;

      if (!dryRun) {
        const r = await sendReturnToSenderEmail({
          to: senderEmail,
          publicId,
          amountCents: amount,
          reason: "Not claimed after 2 reminders (48h apart).",
        });
        ok = r.ok;
        error = r.error || null;
      }

      if (ok) {
        sent++;
        actions.push({ publicId, action: "return_to_sender", ok: true });

        if (!dryRun) {
          await db
            .update(gifts)
            .set({
              returnedToSenderAt: new Date(),
            } as any)
            .where(eq(pubCol as any, publicId));
        }
      } else {
        failed++;
        actions.push({ publicId, action: "return_to_sender", ok: false, error });
      }
    } catch (e: any) {
      failed++;
      const error = e?.message || "Unknown error";
      actions.push({ publicId, action: "return_to_sender", ok: false, error });
    }
  }

  return res.json({
    ok: true,
    dryRun,
    scanned: reminderRows.length + returnRows.length,
    reminderEligible: reminderRows.length,
    returnEligible: returnRows.length,
    sent,
    failed,
    cutoffCreated: cutoffCreated.toISOString(),
    actions,
  });
});

export default router;
