import { Router } from "express";
import type { Request, Response } from "express";
import crypto from "crypto";
import { z } from "zod";
import { db, pool } from "./db";
import { gifts } from "@shared/schema";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { sendGiftEmail, sendReminderEmail, sendReturnToSenderEmail } from "./email";

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

function hoursAgoDate(h: number) {
  const ms = Math.max(0, h) * 60 * 60 * 1000;
  return new Date(Date.now() - ms);
}

function toIso(d: any) {
  try {
    const dd = d instanceof Date ? d : d ? new Date(d) : null;
    return dd ? dd.toISOString() : "";
  } catch {
    return "";
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: any;
  const timeout = new Promise<T>((_resolve, reject) => {
    t = setTimeout(() => reject(new Error(`${label}_timeout_${ms}ms`)), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(t)), timeout]);
}

/* -------------------- SCHEMAS -------------------- */
const CreateGiftSchema = z.object({
  senderEmail: z.string().email(),
  recipientEmail: z.string().email(),
  message: z.string().max(2000).optional().default(""),
  amount: z.number().int().min(1000),
  turnstileToken: z.string().optional(),
});

const RunRemindersSchema = z.object({
  olderThanHours: z.coerce.number().int().min(1).max(24 * 365).optional().default(48),
  limit: z.coerce.number().int().min(1).max(500).optional().default(50),
  spacingHours: z.coerce.number().int().min(1).max(24 * 365).optional().default(48),
});

/* -------------------- ROUTER (DEFAULT EXPORT) -------------------- */
const router = Router();

router.get("/health", (_req: Request, res: Response) => res.json({ ok: true }));

/* ---------- Create Gift ---------- */
router.post("/gifts", async (req: Request, res: Response) => {
  const parsed = CreateGiftSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Bad request", issues: parsed.error.issues });
  }

  const senderEmail = parsed.data.senderEmail.trim().toLowerCase();
  const recipientEmail = parsed.data.recipientEmail.trim().toLowerCase();
  const message = parsed.data.message || "";
  const amount = parsed.data.amount;

  const publicId = crypto.randomBytes(16).toString("hex");
  const baseUrl = getBaseUrl(req);
  const claimUrl = `${baseUrl}/claim/${publicId}`;

  logEvent("gift_create_start", { publicId });

  // IMPORTANT:
  // Use a raw INSERT with a hard timeout so we *never* hang the HTTP request.
  // This also avoids any Drizzle schema mismatch issues.
  try {
    logEvent("gift_db_insert_start", { publicId });

    const insertPromise = pool.query(
      `
      INSERT INTO gifts (
        public_id,
        sender_email,
        recipient_email,
        message,
        amount,
        is_claimed,
        reminder_count,
        last_reminder_sent_at,
        returned_to_sender_at
      )
      VALUES ($1,$2,$3,$4,$5,false,0,NULL,NULL)
      RETURNING public_id;
      `,
      [publicId, senderEmail, recipientEmail, message, amount]
    );

    await withTimeout(insertPromise, 8000, "db_insert");

    logEvent("gift_db_insert_ok", { publicId });

    // Respond immediately (no waiting on email)
    res.json({ ok: true, publicId, claimUrl });

    // Fire-and-forget email send
    Promise.resolve()
      .then(async () => {
        logEvent("email_send_start", { kind: "gift", publicId, to: recipientEmail });
        await sendGiftEmail({ to: recipientEmail, claimUrl, message, amountCents: amount });
        logEvent("email_sent", { kind: "gift", publicId, to: recipientEmail, ok: true });
      })
      .catch((err: any) => {
        logEvent("email_sent", { kind: "gift", publicId, to: recipientEmail, ok: false, error: safeStr(err?.message || err) });
      });

    logEvent("gift_created", { publicId, recipientEmail, senderEmail, amount });
    return;
  } catch (err: any) {
    const msg = safeStr(err?.message || err);
    logEvent("gift_create_failed", { publicId, error: msg });

    // If DB is stalling, return a clear error immediately.
    if (/_timeout_/.test(msg) || /timeout/i.test(msg)) {
      return res.status(504).json({ error: "Database timeout creating gift" });
    }

    return res.status(500).json({ error: "Failed to create gift" });
  }
});

/* ---------- Get Gift by publicId ---------- */
router.get("/gifts/:publicId", async (req: Request, res: Response) => {
  const publicId = safeStr(req.params.publicId);
  if (!publicId) return res.status(400).json({ error: "Missing id" });

  const rows = await db.select().from(gifts).where(eq((gifts as any).publicId, publicId)).limit(1);
  const gift = rows?.[0];
  if (!gift) return res.status(404).json({ error: "Not found" });

  return res.json({
    publicId: (gift as any).publicId,
    senderEmail: (gift as any).senderEmail,
    recipientEmail: (gift as any).recipientEmail,
    message: (gift as any).message,
    amount: (gift as any).amount,
    isClaimed: (gift as any).isClaimed,
    createdAt: (gift as any).createdAt,
    claimedAt: (gift as any).claimedAt,
    reminderCount: (gift as any).reminderCount ?? 0,
    lastReminderSentAt: (gift as any).lastReminderSentAt,
    returnedToSenderAt: (gift as any).returnedToSenderAt,
  });
});

/* ---------- Claim Gift ---------- */
router.post("/gifts/:publicId/claim", async (req: Request, res: Response) => {
  const publicId = safeStr(req.params.publicId);
  if (!publicId) return res.status(400).json({ error: "Missing id" });

  try {
    const updated = await db
      .update(gifts)
      .set({ isClaimed: true, claimedAt: new Date() } as any)
      .where(and(eq((gifts as any).publicId, publicId), eq((gifts as any).isClaimed, false)))
      .returning();

    if (!updated?.[0]) return res.status(400).json({ error: "Already claimed or not found" });

    logEvent("claim_completed", { publicId });
    return res.json({ ok: true });
  } catch (err: any) {
    logEvent("claim_failed", { publicId, error: safeStr(err?.message || err) });
    return res.status(500).json({ error: "Claim failed" });
  }
});

/* ---------- Reminder Job Endpoint ---------- */
router.post("/reminders/run", async (req: Request, res: Response) => {
  const parsed = RunRemindersSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Bad request", issues: parsed.error.issues });
  }

  let olderThanHours = Number(parsed.data.olderThanHours);
  let spacingHours = Number(parsed.data.spacingHours);
  let limit = Number(parsed.data.limit);

  if (!Number.isFinite(olderThanHours) || olderThanHours < 1) olderThanHours = 48;
  if (!Number.isFinite(spacingHours) || spacingHours < 1) spacingHours = 48;
  if (!Number.isFinite(limit) || limit < 1) limit = 50;
  if (limit > 500) limit = 500;

  const now = new Date();
  const olderThan = hoursAgoDate(olderThanHours);
  const reminderCutoff = hoursAgoDate(spacingHours);

  logEvent("reminders_run", { olderThanHours, spacingHours, limit });

  const candidates = await db
    .select()
    .from(gifts)
    .where(
      and(
        eq((gifts as any).isClaimed, false),
        isNull((gifts as any).returnedToSenderAt),
        lt((gifts as any).createdAt, olderThan),
        or(isNull((gifts as any).lastReminderSentAt), lt((gifts as any).lastReminderSentAt, reminderCutoff))
      )
    )
    .limit(limit);

  let remindersSent = 0;
  let returnsSent = 0;
  let skippedNoSender = 0;

  const baseUrl = getBaseUrl(req);

  for (const g of candidates) {
    const publicId = safeStr((g as any).publicId);
    const recipientEmail = safeStr((g as any).recipientEmail);
    const senderEmail = safeStr((g as any).senderEmail);
    const message = safeStr((g as any).message);
    const reminderCount = Number((g as any).reminderCount ?? 0);

    if (reminderCount >= 3) {
      if (!senderEmail) {
        skippedNoSender++;
        logEvent("return_skipped_no_sender_email", { publicId });
        continue;
      }

      const marked = await db
        .update(gifts)
        .set({ returnedToSenderAt: now } as any)
        .where(
          and(
            eq((gifts as any).publicId, publicId),
            eq((gifts as any).isClaimed, false),
            isNull((gifts as any).returnedToSenderAt)
          )
        )
        .returning();

      if (!marked?.[0]) continue;

      const claimUrl = `${baseUrl}/claim/${publicId}`;

      try {
        await sendReturnToSenderEmail({
          to: senderEmail,
          recipientEmail,
          publicId,
          createdAtIso: toIso((g as any).createdAt),
          claimUrl,
          remindersAttempted: reminderCount,
        });

        returnsSent++;
        logEvent("email_sent", { kind: "return_to_sender", publicId, to: senderEmail, ok: true });
      } catch (err: any) {
        logEvent("email_sent", { kind: "return_to_sender", publicId, to: senderEmail, ok: false, error: safeStr(err?.message || err) });
      }

      continue;
    }

    const nextReminderNumber = reminderCount + 1;

    const updated = await db
      .update(gifts)
      .set({ lastReminderSentAt: now, reminderCount: nextReminderNumber } as any)
      .where(
        and(
          eq((gifts as any).publicId, publicId),
          eq((gifts as any).isClaimed, false),
          isNull((gifts as any).returnedToSenderAt),
          eq((gifts as any).reminderCount, reminderCount),
          or(isNull((gifts as any).lastReminderSentAt), lt((gifts as any).lastReminderSentAt, reminderCutoff))
        )
      )
      .returning();

    if (!updated?.[0]) continue;

    const claimUrl = `${baseUrl}/claim/${publicId}`;

    try {
      await sendReminderEmail({ to: recipientEmail, claimUrl, message, reminderNumber: nextReminderNumber });
      remindersSent++;
      logEvent("email_sent", { kind: "reminder", publicId, to: recipientEmail, n: nextReminderNumber, ok: true });
    } catch (err: any) {
      try {
        await db
          .update(gifts)
          .set({ reminderCount: reminderCount, lastReminderSentAt: (g as any).lastReminderSentAt || null } as any)
          .where(eq((gifts as any).publicId, publicId));
      } catch {}

      logEvent("email_sent", { kind: "reminder", publicId, to: recipientEmail, n: nextReminderNumber, ok: false, error: safeStr(err?.message || err) });
    }
  }

  return res.json({ ok: true, scanned: candidates.length, remindersSent, returnsSent, skippedNoSender, olderThanHours, spacingHours, limit });
});

export default router;
