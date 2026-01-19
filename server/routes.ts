// server/routes.ts
import type { Express, Request, Response } from "express";
import crypto from "crypto";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { eq } from "drizzle-orm";

import { db } from "./db";
import { gifts } from "@shared/schema";
import { sendGiftEmail, sendReminderEmail, sendReturnToSenderEmail } from "./email";

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
  if (!secret) return { ok: true as const }; // not enabled
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
const CreateGiftSchema = z.object({
  senderEmail: z.string().email(),
  recipientEmail: z.string().email(),
  message: z.string().max(2000).optional().default(""),
  amount: z.number().int().min(1000), // cents; min $10
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

/* -------------------- REGISTER ROUTES -------------------- */
export function registerRoutes(app: Express) {
  app.post("/gifts", createLimiter, createGiftHandler);
  app.post("/api/gifts", createLimiter, createGiftHandler);

  app.get("/api/gifts/:id", getGiftHandler);

  app.post("/api/gifts/:id/claim", claimLimiter, claimGiftHandler);

  app.post("/api/email/test", async (req: Request, res: Response) => {
    const to = String(req.body?.to || req.body?.email || "").trim();
    if (!to) return res.status(400).json({ ok: false, error: "Missing to" });

    const r = await sendGiftEmail({
      to,
      publicId: "test",
      claimUrl: `${getClaimSiteBaseUrl()}/claim/test`,
      amountCents: 1000,
      senderEmail: "sender@example.com",
      message: "This is a test email from ThankuMail.",
    });

    return res.json({ ok: r.ok, error: r.error || null });
  });
}

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

  const { senderEmail, recipientEmail, message, amount, turnstileToken } = parsed.data;

  if (process.env.TURNSTILE_SECRET_KEY) {
    const v = await verifyTurnstile(turnstileToken || "", req.ip);
    if (!v.ok) {
      logEvent("gift_create_captcha_fail", { publicId, error: v.error });
      return res.status(400).json({ error: v.error, field: "turnstileToken" });
    }
  }

  try {
    logEvent("gift_db_insert_start", { publicId });

    // IMPORTANT:
    // Insert with BOTH camelCase and snake_case keys.
    // Drizzle will use the keys that exist in your schema and ignore unknown ones.
    const insertValues: any = {
      publicId,
      public_id: publicId,

      amount,

      message: message || "",

      recipientEmail,
      recipient_email: recipientEmail,

      senderEmail,
      sender_email: senderEmail,

      isClaimed: false,
      is_claimed: false,

      createdAt: new Date(),
      created_at: new Date(),
    };

    await db.insert(gifts).values(insertValues);

    logEvent("gift_db_insert_ok", { publicId });

    // Sanity-check: immediately try to read it back by publicId
    // (If this fails, it means the schema key isn't publicId/public_id and we must align to the real column.)
    try {
      const pubCol = (gifts as any).publicId ?? (gifts as any).public_id;
      if (pubCol) {
        const chk = await db.select().from(gifts).where(eq(pubCol, publicId)).limit(1);
        logEvent("gift_db_readback", { publicId, ok: !!chk?.[0] });
      } else {
        logEvent("gift_db_readback", { publicId, ok: false, error: "No publicId/public_id column in schema" });
      }
    } catch (e: any) {
      logEvent("gift_db_readback", { publicId, ok: false, error: e?.message || "readback error" });
    }

    const claimUrl = `${getClaimSiteBaseUrl()}/claim/${publicId}`;

    logEvent("gift_created", {
      publicId,
      recipientEmail,
      senderEmail,
      amount,
    });

    // Fire-and-forget email
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
        logEvent("email_sent", {
          kind: "gift",
          publicId,
          to: recipientEmail,
          ok: r.ok,
          error: r.error || null,
        });

        // Optional return-to-sender best effort
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
    const pubCol = (gifts as any).publicId ?? (gifts as any).public_id;
    if (!pubCol) return res.status(500).json({ message: "Server misconfigured: missing publicId column" });

    const rows = await db.select().from(gifts).where(eq(pubCol, key)).limit(1);
    const g: any = rows?.[0];
    if (!g) return res.status(404).json({ message: "Not found" });

    return res.json({
      publicId: g.publicId ?? g.public_id ?? key,
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
    const pubCol = (gifts as any).publicId ?? (gifts as any).public_id;
    if (!pubCol) return res.status(500).json({ error: "Server misconfigured: missing publicId column" });

    const rows = await db.select().from(gifts).where(eq(pubCol, key)).limit(1);
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
          return res.status(400).json({
            error: "Too early to claim",
            field: "minDelay",
            waitMs: earliest - Date.now(),
          });
        }
      }
    }

    const updateValues: any = {
      isClaimed: true,
      is_claimed: true,
      claimedAt: new Date(),
      claimed_at: new Date(),
    };

    await db.update(gifts).set(updateValues).where(eq(pubCol, key));

    logEvent("claim_completed", { publicId: key });

    return res.json({ ok: true });
  } catch (e: any) {
    logEvent("claim_error", { publicId: key, error: e?.message || "Unknown error" });
    return res.status(500).json({ error: "Server error" });
  }
}
