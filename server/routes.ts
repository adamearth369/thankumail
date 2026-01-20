// WHERE TO PASTE: server/routes.ts (FULL REPLACEMENT)
import { Router } from "express";
import type { Request, Response } from "express";
import crypto from "crypto";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { eq } from "drizzle-orm";

import { db } from "./db";
import { gifts } from "@shared/schema";
import { sendGiftEmail, sendReturnToSenderEmail } from "./email";
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

    // Email OPTIONAL (allow "", undefined)
    recipientEmail: z
      .string()
      .optional()
      .or(z.literal(""))
      .transform((v) => (typeof v === "string" ? v.trim() : "")),

    // Phone OPTIONAL (E.164)
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
  // Require at least ONE delivery method
  .refine((d) => !!d.recipientEmail || !!d.recipientPhone, {
    message: "Provide recipientEmail or recipientPhone",
    path: ["recipientEmail"],
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

/* -------------------- ROUTER (DEFAULT EXPORT) -------------------- */
const router = Router();

/* -------------------- HANDLERS -------------------- */
async function createGiftHandler(req: Request, res: Response) {
  const publicId = crypto.randomBytes(16).toString("hex");
  logEvent("gift_create_start", { publicId });

  const parsed = CreateGiftSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    const msg = parsed.error.issues?.[0]?.message || "Invalid request";
    logEvent("gift_create_bad_request", { publicId, error: msg });
    return res.status(400).json({ error: msg });
  }

  const { senderEmail, recipientEmail, recipientPhone, message, amount, turnstileToken } = parsed.data;

  if (process.env.TURNSTILE_SECRET_KEY) {
    const v = await verifyTurnstile(turnstileToken || "", req.ip);
    if (!v.ok) {
      logEvent("gift_create_captcha_fail", { publicId, error: v.error });
      return res.status(400).json({ error: v.error, field: "turnstileToken" });
    }
  }

  try {
    logEvent("gift_db_insert_start", { publicId });

    // Only set keys that exist on the Drizzle schema object.
    const values: any = {};

    // publicId
    if ((gifts as any).publicId) values.publicId = publicId;
    else if ((gifts as any).public_id) values.public_id = publicId;
    else if ((gifts as any).publicID) values.publicID = publicId;
    else throw new Error("Schema missing publicId/public_id column");

    // amount/message
    if ((gifts as any).amount) values.amount = amount;
    if ((gifts as any).message) values.message = message || "";

    // recipientEmail optional
    if (recipientEmail) {
      if ((gifts as any).recipientEmail) values.recipientEmail = recipientEmail;
      else if ((gifts as any).recipient_email) values.recipient_email = recipientEmail;
    }

    // senderEmail
    if ((gifts as any).senderEmail) values.senderEmail = senderEmail;
    else if ((gifts as any).sender_email) values.sender_email = senderEmail;

    // claimed flags
    if ((gifts as any).isClaimed) values.isClaimed = false;
    else if ((gifts as any).is_claimed) values.is_claimed = false;

    // timestamps
    if ((gifts as any).createdAt) values.createdAt = new Date();
    else if ((gifts as any).created_at) values.created_at = new Date();

    await db.insert(gifts).values(values);

    logEvent("gift_db_insert_ok", { publicId });

    // Readback sanity check (shows if the publicId is truly stored)
    try {
      const pubCol = COL_PUBLIC_ID();
      if (pubCol) {
        const chk = await db.select().from(gifts).where(eq(pubCol as any, publicId)).limit(1);
        logEvent("gift_db_readback", { publicId, ok: !!chk?.[0] });
      } else {
        logEvent("gift_db_readback", { publicId, ok: false, error: "No publicId column" });
      }
    } catch (e: any) {
      logEvent("gift_db_readback", { publicId, ok: false, error: e?.message || "readback error" });
    }

    const claimUrl = `${getClaimSiteBaseUrl()}/claim/${publicId}`;

    logEvent("gift_created", {
      publicId,
      recipientEmail: recipientEmail || "",
      recipientPhone: recipientPhone || "",
      senderEmail,
      amount,
    });

    // Fire-and-forget EMAIL (only if recipientEmail exists)
    if (recipientEmail) {
      (async () => {
        try {
          logEvent("email_send_start", { kind: "gift", publicId, to: recipientEmail });
          const r = await sendGiftEmail({
            to: recipientEmail,
            publicId,
            claimUrl,
            amountCents: amount,
            senderEmail,
            message,
          });
          logEvent("email_sent", { kind: "gift", publicId, to: recipientEmail, ok: r.ok, error: r.error || null });

          if (!r.ok && senderEmail) {
            logEvent("email_send_start", { kind: "return_to_sender", publicId, to: senderEmail });
            const r2 = await sendReturnToSenderEmail({
              to: senderEmail,
              publicId,
              amountCents: amount,
              reason: r.error || "Delivery failed",
            });
            logEvent("email_sent", {
              kind: "return_to_sender",
              publicId,
              to: senderEmail,
              ok: r2.ok,
              error: r2.error || null,
            });
          }
        } catch (e: any) {
          logEvent("email_send_crash", { publicId, error: e?.message || "Unknown error" });
        }
      })();
    }

    // Fire-and-forget SMS (only if recipientPhone exists)
    if (recipientPhone) {
      (async () => {
        try {
          logEvent("sms_send_start", { publicId, to: recipientPhone });
          const r = await sendGiftSms({ to: recipientPhone, claimUrl, publicId });
          logEvent("sms_sent", { publicId, to: recipientPhone, ok: r.ok, error: r.error || null });
        } catch (e: any) {
          logEvent("sms_send_crash", { publicId, to: recipientPhone, error: e?.message || "Unknown error" });
        }
      })();
    }

    return res.json({ ok: true, publicId, claimUrl });
  } catch (e: any) {
    logEvent("gift_create_error", { publicId, error: e?.message || "Unknown error" });
    return res.status(500).json({ error: "Server error" });
  }
}

async function getGiftHandler(req: Request, res: Response) {
  const key = String(req.params.id || "").trim();
  if (!key) return res.status(400).json({ message: "Missing id" });

  try {
    const pubCol = COL_PUBLIC_ID();
    if (!pubCol) return res.status(500).json({ message: "Server misconfigured: missing publicId column" });

    const rows = await db.select().from(gifts).where(eq(pubCol as any, key)).limit(1);
    const g: any = rows?.[0];
    if (!g) return res.status(404).json({ message: "Not found" });

    return res.json({
      publicId: g.publicId ?? g.public_id ?? g.publicID ?? key,
      amount: g.amount,
      message: g.message ?? "",
      senderEmail: g.senderEmail ?? g.sender_email ?? "",
      isClaimed: !!(g.isClaimed ?? g.is_claimed),
    });
  } catch (e: any) {
    console.error("GET /api/gifts/:id error:", e);
    return res.status(500).json({ message: "Server error" });
  }
}

async function claimGiftHandler(req: Request, res: Response) {
  const key = String(req.params.id || "").trim();
  if (!key) return res.status(400).json({ error: "Missing id" });

  const minDelaySec = Number(process.env.MIN_CLAIM_DELAY_SEC || "0");

  try {
    const pubCol = COL_PUBLIC_ID();
    if (!pubCol) return res.status(500).json({ error: "Server misconfigured: missing publicId column" });

    const rows = await db.select().from(gifts).where(eq(pubCol as any, key)).limit(1);
    const g: any = rows?.[0];
    if (!g) return res.status(404).json({ error: "Not found" });

    const claimed = !!(g.isClaimed ?? g.is_claimed);
    if (claimed) return res.status(400).json({ error: "Already claimed" });

    if (minDelaySec > 0) {
      const created = g.createdAt ?? g.created_at;
      if (created) {
        const createdMs = new Date(created).getTime();
        const earliest = createdMs + minDelaySec * 1000;
        if (Date.now() < earliest) {
          return res.status(400).json({ error: "Too early to claim", field: "minDelay", waitMs: earliest - Date.now() });
        }
      }
    }

    const update: any = {};
    if ((gifts as any).isClaimed) update.isClaimed = true;
    else if ((gifts as any).is_claimed) update.is_claimed = true;

    if ((gifts as any).claimedAt) update.claimedAt = new Date();
    else if ((gifts as any).claimed_at) update.claimed_at = new Date();

    await db.update(gifts).set(update).where(eq(pubCol as any, key));

    logEvent("claim_completed", { publicId: key });
    return res.json({ ok: true });
  } catch (e: any) {
    logEvent("claim_error", { publicId: key, error: e?.message || "Unknown error" });
    return res.status(500).json({ error: "Server error" });
  }
}

/* -------------------- ROUTES -------------------- */
// Create (support both endpoints)
router.post("/gifts", createLimiter, (req, res) => void createGiftHandler(req, res));
router.post("/api/gifts", createLimiter, (req, res) => void createGiftHandler(req, res));

// Read + claim
router.get("/api/gifts/:id", (req, res) => void getGiftHandler(req, res));
router.post("/api/gifts/:id/claim", claimLimiter, (req, res) => void claimGiftHandler(req, res));

export default router;
