// server/routes.ts
import { Router } from "express";
import type { Express, Request, Response } from "express";
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
      .refine((v) => !v || E164.test(v), { message: "Invalid phone number (use E.164 like +15551234567)" }),
    message: z.string().max(2000).optional().default(""),
    amount: z.number().int().min(1000),
    turnstileToken: z.string().optional(),
  })
  .refine((d) => !!d.recipientEmail || !!d.recipientPhone, {
    message: "Provide recipientEmail or recipientPhone",
    path: ["recipientEmail"],
  });

const ClaimSchema = z.object({ turnstileToken: z.string().optional() });

/* -------------------- RATE LIMITS -------------------- */
const createLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false });
const claimLimiter = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false });

/* -------------------- SCHEMA HELPERS -------------------- */
function hasCol(name: string) {
  return !!(gifts as any)[name];
}
function col(name: string) {
  return (gifts as any)[name];
}

/* -------------------- ROUTER -------------------- */
const router = Router();

/* -------------------- CREATE -------------------- */
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

    const remoteip = req.headers["cf-connecting-ip"]?.toString() || req.ip;
    const captcha = await verifyTurnstile(turnstileToken || "", remoteip);
    if (!captcha.ok) return res.status(400).json({ error: captcha.error, field: "turnstileToken" });

    const publicId = crypto.randomBytes(16).toString("hex");
    const claimUrl = `${getClaimSiteBaseUrl()}/claim/${publicId}`;

    // Build values object ONLY with keys that exist in your Drizzle schema.
    // ✅ CRITICAL: set BOTH public_id and publicId if present, to guarantee the NOT NULL column is filled.
    const row: any = {};

    if (hasCol("public_id")) row["public_id"] = publicId;
    if (hasCol("publicId")) row["publicId"] = publicId;
    if (hasCol("publicID")) row["publicID"] = publicId;

    // if none exist, fail loudly
    if (!("public_id" in row) && !("publicId" in row) && !("publicID" in row)) {
      return res.status(500).json({ error: "Server misconfigured: gifts table missing public id column mapping" });
    }

    if (hasCol("sender_email")) row["sender_email"] = senderEmail;
    if (hasCol("senderEmail")) row["senderEmail"] = senderEmail;

    if (hasCol("recipient_email")) row["recipient_email"] = recipientEmail || null;
    if (hasCol("recipientEmail")) row["recipientEmail"] = recipientEmail || null;

    if (hasCol("recipient_phone")) row["recipient_phone"] = recipientPhone || null;
    if (hasCol("recipientPhone")) row["recipientPhone"] = recipientPhone || null;

    if (hasCol("message")) row["message"] = message || "";

    if (hasCol("amount")) row["amount"] = amount;

    if (hasCol("is_claimed")) row["is_claimed"] = false;
    if (hasCol("isClaimed")) row["isClaimed"] = false;

    if (hasCol("created_at")) row["created_at"] = new Date();
    if (hasCol("createdAt")) row["createdAt"] = new Date();

    // DEBUG: log what keys we are inserting
    logEvent("gift_insert_debug", {
      publicId,
      rowKeys: Object.keys(row),
      schemaHasPublic_id: hasCol("public_id"),
      schemaHasPublicId: hasCol("publicId"),
    });

    await db.insert(gifts).values(row);

    logEvent("gift_created", {
      publicId,
      senderEmail,
      hasRecipientEmail: !!recipientEmail,
      hasRecipientPhone: !!recipientPhone,
      amount,
    });

    // Delivery must NOT crash the request
    let deliveryOk = true;
    let deliveryError: string | undefined;

    try {
      if (recipientEmail) {
        const r = await sendGiftEmail({
          to: recipientEmail,
          publicId,
          claimUrl,
          amountCents: amount,
          senderEmail,
          message,
        });
        deliveryOk = !!r.ok;
        deliveryError = r.ok ? undefined : r.error || "Email delivery failed";
        logEvent("gift_email_sent", { publicId, ok: deliveryOk, error: deliveryError || null });
      } else if (recipientPhone) {
        const r = await sendGiftSms({ to: recipientPhone, claimUrl, publicId });
        deliveryOk = !!r.ok;
        deliveryError = r.ok ? undefined : r.error || "SMS delivery failed";
        logEvent("gift_sms_sent", { publicId, ok: deliveryOk, error: deliveryError || null });
      }
    } catch (e: any) {
      deliveryOk = false;
      deliveryError = e?.message || "Delivery threw an exception";
      logEvent("gift_delivery_exception", { publicId, error: deliveryError });
    }

    return res.json({ ok: true, publicId, claimUrl, deliveryOk, deliveryError });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
});

/* -------------------- GET -------------------- */
router.get("/api/gifts/:publicId", async (req: Request, res: Response) => {
  const publicId = String(req.params.publicId || "").trim();
  if (!publicId) return res.status(400).json({ error: "Missing id" });

  // Prefer whichever public id column exists
  const pubCol = hasCol("public_id")
    ? col("public_id")
    : hasCol("publicId")
      ? col("publicId")
      : hasCol("publicID")
        ? col("publicID")
        : null;
  if (!pubCol) return res.status(500).json({ error: "Server misconfigured: missing public id column mapping" });

  const rows = await db.select().from(gifts).where(eq(pubCol as any, publicId)).limit(1);
  const g: any = rows?.[0];
  if (!g) return res.status(404).json({ error: "Not found" });

  return res.json({
    ok: true,
    publicId,
    message: g.message ?? "",
    amount: g.amount ?? 0,
    isClaimed: g.isClaimed ?? g.is_claimed ?? false,
    createdAt: g.createdAt ?? g.created_at ?? null,
  });
});

/* -------------------- CLAIM -------------------- */
router.post("/api/gifts/:publicId/claim", claimLimiter, async (req: Request, res: Response) => {
  const publicId = String(req.params.publicId || "").trim();
  if (!publicId) return res.status(400).json({ error: "Missing id" });

  const parsed = ClaimSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Invalid request" });

  const pubCol = hasCol("public_id")
    ? col("public_id")
    : hasCol("publicId")
      ? col("publicId")
      : hasCol("publicID")
        ? col("publicID")
        : null;
  if (!pubCol) return res.status(500).json({ error: "Server misconfigured: missing public id column mapping" });

  const rows = await db.select().from(gifts).where(eq(pubCol as any, publicId)).limit(1);
  const g: any = rows?.[0];
  if (!g) return res.status(404).json({ error: "Not found" });

  if (g.isClaimed ?? g.is_claimed) return res.status(400).json({ error: "Already claimed", code: "ALREADY_CLAIMED" });

  const minDelaySec = Number(process.env.MIN_CLAIM_DELAY_SEC || 0);
  const createdAt = g.createdAt ?? g.created_at;
  if (minDelaySec > 0 && createdAt) {
    const ageSec = Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000);
    if (ageSec < minDelaySec) {
      return res.status(400).json({
        error: "Please wait a moment before claiming.",
        code: "TOO_SOON",
        retryAfterSec: minDelaySec - ageSec,
      });
    }
  }

  const updateRow: any = {};
  if (hasCol("is_claimed")) updateRow["is_claimed"] = true;
  if (hasCol("isClaimed")) updateRow["isClaimed"] = true;

  if (hasCol("claimed_at")) updateRow["claimed_at"] = new Date();
  if (hasCol("claimedAt")) updateRow["claimedAt"] = new Date();

  await db.update(gifts).set(updateRow).where(eq(pubCol as any, publicId));

  logEvent("gift_claimed", { publicId });
  return res.json({ ok: true });
});

/* -------------------- ADMIN: REMINDERS + RETURN TO SENDER -------------------- */
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

  const pubCol = hasCol("public_id")
    ? col("public_id")
    : hasCol("publicId")
      ? col("publicId")
      : hasCol("publicID")
        ? col("publicID")
        : null;
  if (!pubCol) return res.status(500).json({ ok: false, error: "Server misconfigured: missing public id column mapping" });

  const isClaimedCol = (gifts as any).isClaimed || (gifts as any).is_claimed;
  const createdAtCol = (gifts as any).createdAt || (gifts as any).created_at;
  const reminderCountCol = (gifts as any).reminderCount || (gifts as any).reminder_count;
  const lastReminderSentAtCol = (gifts as any).lastReminderSentAt || (gifts as any).last_reminder_sent_at;
  const returnedToSenderAtCol = (gifts as any).returnedToSenderAt || (gifts as any).returned_to_sender_at;

  if (!isClaimedCol || !createdAtCol || !reminderCountCol || !lastReminderSentAtCol || !returnedToSenderAtCol) {
    return res.status(500).json({ ok: false, error: "Server misconfigured: reminder columns missing" });
  }

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
        ok = dryRun
          ? true
          : (await sendReminderEmail({ to: recipientEmail, publicId, claimUrl, amountCents: amount, senderEmail })).ok;
      } else if (recipientPhone) {
        ok = dryRun ? true : (await sendGiftSms({ to: recipientPhone, claimUrl, publicId })).ok;
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
          .set({ reminderCount: Number(g.reminderCount ?? g.reminder_count ?? 0) + 1, lastReminderSentAt: new Date() } as any)
          .where(eq(pubCol as any, publicId));
      }
    } else {
      failed++;
      actions.push({ publicId, action: "reminder", ok: false, error });
    }
  }

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
      const r = dryRun
        ? { ok: true, error: null as any }
        : await sendReturnToSenderEmail({
            to: senderEmail,
            publicId,
            amountCents: amount,
            reason: "Not claimed after 2 reminders (48h apart).",
          });

      if (r.ok) {
        sent++;
        actions.push({ publicId, action: "return_to_sender", ok: true });
        if (!dryRun) await db.update(gifts).set({ returnedToSenderAt: new Date() } as any).where(eq(pubCol as any, publicId));
      } else {
        failed++;
        actions.push({ publicId, action: "return_to_sender", ok: false, error: r.error || "Failed" });
      }
    } catch (e: any) {
      failed++;
      actions.push({ publicId, action: "return_to_sender", ok: false, error: e?.message || "Unknown error" });
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

/* -------------------- EXPORT: REGISTER ROUTES -------------------- */
export function registerRoutes(app: Express) {
  // routes already include /api prefixes
  app.use(router);
}

export default router;
