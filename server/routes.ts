import type { Request, Response } from "express";
import { Router } from "express";
import crypto from "crypto";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { db } from "./db";
import { gifts } from "@shared/schema";
import { eq } from "drizzle-orm";
import { sendGiftEmail } from "./email";

/* -------------------- LOGGING -------------------- */
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

/* -------------------- CONFIG -------------------- */
const MIN_CLAIM_DELAY_SEC = Number(process.env.MIN_CLAIM_DELAY_SEC || "60");

const giftCreateLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
});

/* -------------------- VALIDATION -------------------- */
const CreateGiftSchema = z.object({
  recipientEmail: z.string().email(),
  message: z.string().min(1),
  amount: z.number().int().min(1000),
  turnstileToken: z.string().optional(),
});

const router = Router();

/* -------------------- CREATE GIFT -------------------- */
router.post("/api/gifts", giftCreateLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = CreateGiftSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const { recipientEmail, message, amount } = parsed.data;

    const publicId = crypto.randomBytes(12).toString("hex");

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
    if (!gift) throw new Error("Insert failed");

    const base = getBaseUrl(req);
    const claimUrl = `${base}/claim/${publicId}`;

    await sendGiftEmail({
      to: recipientEmail,
      message,
      claimLink: claimUrl,
    });

    logEvent("gift_created", { publicId });

    return res.json({
      publicId,
      claimUrl,
      claimLink: claimUrl,
    });
  } catch (e: any) {
    logEvent("gift_create_failed", { error: String(e?.message || e) });
    return res.status(500).json({ error: "Server error" });
  }
});

/* -------------------- GET GIFT -------------------- */
router.get("/api/gifts/:publicId", async (req: Request, res: Response) => {
  try {
    const publicId = req.params.publicId;

    const rows = await db
      .select()
      .from(gifts as any)
      .where(eq((gifts as any).publicId, publicId))
      .limit(1);

    const gift = rows?.[0];
    if (!gift) return res.status(404).json({ error: "Not found" });

    return res.json(gift);
  } catch (e) {
    return res.status(500).json({ error: "Server error" });
  }
});

/* -------------------- CLAIM -------------------- */
router.post("/api/gifts/:publicId/claim", async (req: Request, res: Response) => {
  try {
    const publicId = req.params.publicId;

    const rows = await db
      .select()
      .from(gifts as any)
      .where(eq((gifts as any).publicId, publicId))
      .limit(1);

    const gift = rows?.[0];
    if (!gift) return res.status(404).json({ error: "Not found" });
    if (gift.isClaimed) return res.status(409).json({ error: "Already claimed" });

    const createdAt = new Date(gift.createdAt);
    const unlockAt = createdAt.getTime() + MIN_CLAIM_DELAY_SEC * 1000;
    if (Date.now() < unlockAt) {
      return res.status(429).json({ error: "Too soon" });
    }

    await db
      .update(gifts as any)
      .set({ isClaimed: true, claimedAt: new Date() })
      .where(eq((gifts as any).publicId, publicId));

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
