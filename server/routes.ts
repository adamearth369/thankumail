import type { Express, Request, Response } from "express";
import crypto from "crypto";
import { z } from "zod";
import { eq, and, isNull, lt, or } from "drizzle-orm";
import { db } from "./db";
import { gifts } from "@shared/schema";
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

/* -------------------- SCHEMAS -------------------- */
const CreateGiftSchema = z.object({
  recipientEmail: z.string().email(),
  message: z.string().max(2000).optional().default(""),
  amount: z.number().int().min(1000), // cents, min $10
  // NEW (optional for now; frontend update comes next):
  senderEmail: z.string().email().optional(),
  // CAPTCHA may exist in your app already; keep optional here to avoid breaking:
  turnstileToken: z.string().optional(),
});

const RunRemindersSchema = z.object({
  olderThanHours: z.number().int().min(1).max(24 * 365).optional().default(48),
  limit: z.number().int().min(1).max(500).optional().default(50),
  spacingHours: z.number().int().min(1).max(24 * 365).optional().default(48),
});

/* -------------------- REGISTER ROUTES -------------------- */
export function registerRoutes(app: Express) {
  /* ---------- Health / debug ---------- */
  app.get("/api/health", (_req: Request, res: Response) => res.json({ ok: true }));

  /* ---------- Create Gift ---------- */
  app.post("/api/gifts", async (req: Request, res: Response) => {
    const parsed = CreateGiftSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Bad request", issues: parsed.error.issues });
    }

    const recipientEmail = parsed.data.recipientEmail;
    const message = parsed.data.message || "";
    const amount = parsed.data.amount;
    const senderEmail = parsed.data.senderEmail ? parsed.data.senderEmail.trim().toLowerCase() : null;

    // You may already enforce CAPTCHA elsewhere; keeping this non-breaking.
    // If you require it, your existing middleware/logic should still run.

    const publicId = crypto.randomBytes(16).toString("hex");

    try {
      const created = await db
        .insert(gifts)
        .values({
          publicId,
          recipientEmail,
          message,
          amount,
          isClaimed: false,
          // NEW columns (migration done):
          senderEmail,
          reminderCount: 0,
          lastReminderSentAt: null,
          returnedToSenderAt: null,
        } as any)
        .returning();

      const gift = created?.[0];
      const baseUrl = getBaseUrl(req);
      const claimUrl = `${baseUrl}/claim/${publicId}`;

      // Send initial email
      await sendGiftEmail({ to: recipientEmail, claimUrl, message, amountCents: amount });

      logEvent("gift_created", {
        publicId,
        recipientEmail,
        senderEmail: senderEmail || "",
        amount,
      });
      logEvent("email_sent", { kind: "gift", publicId, to: recipientEmail, ok: true });

      return res.json({
        ok: true,
        publicId,
        claimUrl,
        gift: gift ? { publicId, recipientEmail, amount, isClaimed: false } : undefined,
      });
    } catch (err: any) {
      logEvent("gift_create_failed", { error: safeStr(err?.message || err) });
      return res.status(500).json({ error: "Failed to create gift" });
    }
  });

  /* ---------- Get Gift by publicId ---------- */
  app.get("/api/gifts/:publicId", async (req: Request, res: Response) => {
    const publicId = safeStr(req.params.publicId);
    if (!publicId) return res.status(400).json({ error: "Missing id" });

    const rows = await db.select().from(gifts).where(eq((gifts as any).publicId, publicId)).limit(1);
    const gift = rows?.[0];
    if (!gift) return res.status(404).json({ error: "Not found" });

    return res.json({
      publicId: (gift as any).publicId,
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
  app.post("/api/gifts/:publicId/claim", async (req: Request, res: Response) => {
    const publicId = safeStr(req.params.publicId);
    if (!publicId) return res.status(400).json({ error: "Missing id" });

    try {
      // Atomic-ish: only update if not already claimed
      const updated = await db
        .update(gifts)
        .set({ isClaimed: true, claimedAt: new Date() } as any)
        .where(and(eq((gifts as any).publicId, publicId), eq((gifts as any).isClaimed, false)))
        .returning();

      const row = updated?.[0];
      if (!row) return res.status(400).json({ error: "Already claimed or not found" });

      logEvent("claim_completed", { publicId });

      return res.json({ ok: true });
    } catch (err: any) {
      logEvent("claim_failed", { publicId, error: safeStr(err?.message || err) });
      return res.status(500).json({ error: "Claim failed" });
    }
  });

  /**
   * ---------- Reminder Job Endpoint ----------
   * POST /api/reminders/run
   * Body: { olderThanHours: 48, limit: 50, spacingHours: 48 }
   *
   * Behavior:
   * - Finds unclaimed gifts older than olderThanHours
   * - Sends up to 3 reminders max, spaced by spacingHours
   * - After 3 reminders and still unclaimed: send "return to sender" once
   */
  app.post("/api/reminders/run", async (req: Request, res: Response) => {
    const parsed = RunRemindersSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Bad request", issues: parsed.error.issues });
    }

    const olderThanHours = parsed.data.olderThanHours;
    const limit = parsed.data.limit;
    const spacingHours = parsed.data.spacingHours;

    const now = new Date();
    const olderThan = hoursAgoDate(olderThanHours);
    const reminderCutoff = hoursAgoDate(spacingHours);

    // Select candidates
    const candidates = await db
      .select()
      .from(gifts)
      .where(
        and(
          eq((gifts as any).isClaimed, false),
          isNull((gifts as any).returnedToSenderAt),
          lt((gifts as any).createdAt, olderThan),
          or(
            isNull((gifts as any).lastReminderSentAt),
            lt((gifts as any).lastReminderSentAt, reminderCutoff)
          )
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

      // If already at 3 reminders -> return-to-sender once
      if (reminderCount >= 3) {
        if (!senderEmail) {
          skippedNoSender++;
          logEvent("return_skipped_no_sender_email", { publicId });
          continue;
        }

        // Mark returned (idempotent)
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
          logEvent("email_sent", {
            kind: "return_to_sender",
            publicId,
            to: senderEmail,
            ok: false,
            error: safeStr(err?.message || err),
          });
        }

        continue;
      }

      // Otherwise: send next reminder and increment counters (idempotent)
      const nextReminderNumber = reminderCount + 1;

      // Mark reminder sent before emailing (prevents duplicates if job retries)
      const updated = await db
        .update(gifts)
        .set({
          lastReminderSentAt: now,
          reminderCount: nextReminderNumber,
        } as any)
        .where(
          and(
            eq((gifts as any).publicId, publicId),
            eq((gifts as any).isClaimed, false),
            isNull((gifts as any).returnedToSenderAt),
            eq((gifts as any).reminderCount, reminderCount),
            or(
              isNull((gifts as any).lastReminderSentAt),
              lt((gifts as any).lastReminderSentAt, reminderCutoff)
            )
          )
        )
        .returning();

      if (!updated?.[0]) continue;

      const claimUrl = `${baseUrl}/claim/${publicId}`;

      try {
        await sendReminderEmail({
          to: recipientEmail,
          claimUrl,
          message,
          reminderNumber: nextReminderNumber,
        });

        remindersSent++;
        logEvent("email_sent", { kind: "reminder", publicId, to: recipientEmail, n: nextReminderNumber, ok: true });
      } catch (err: any) {
        // Email failed: roll back reminder counters so we can retry next run
        try {
          await db
            .update(gifts)
            .set({
              reminderCount: reminderCount,
              lastReminderSentAt: (g as any).lastReminderSentAt || null,
            } as any)
            .where(eq((gifts as any).publicId, publicId));
        } catch {}

        logEvent("email_sent", {
          kind: "reminder",
          publicId,
          to: recipientEmail,
          n: nextReminderNumber,
          ok: false,
          error: safeStr(err?.message || err),
        });
      }
    }

    return res.json({
      ok: true,
      scanned: candidates.length,
      remindersSent,
      returnsSent,
      skippedNoSender,
      olderThanHours,
      spacingHours,
      limit,
    });
  });

  return app;
}
