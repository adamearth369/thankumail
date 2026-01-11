import type { Express } from "express";
import type { Server } from "http";
import crypto from "crypto";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { db } from "./db";
import { gifts } from "@shared/schema";
import { eq } from "drizzle-orm";
import { sendGiftEmail } from "./email";

/* ==================== UTIL ==================== */
function logEvent(event: string, fields: Record<string, any> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

function safeStr(v: any) {
  return typeof v === "string" ? v : "";
}

function getBaseUrl(req: any) {
  const envBase = process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "";
  if (envBase) return envBase.replace(/\/+$/, "");
  const proto = (req.headers["x-forwarded-proto"] || "https").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return `${proto}://${host}`.replace(/\/+$/, "");
}

/* ==================== DISPOSABLE EMAIL BLOCK ==================== */
const BLOCKED_EMAIL_DOMAINS = new Set([
  "mailinator.com",
  "10minutemail.com",
  "guerrillamail.com",
  "temp-mail.org",
  "yopmail.com",
  "getnada.com",
  "dispostable.com",
  "maildrop.cc",
  "fakeinbox.com",
  "throwawaymail.com",
]);

function getEmailDomain(email: string) {
  const parts = email.split("@");
  return parts.length === 2 ? parts[1].toLowerCase() : "";
}

function isDisposableEmail(email: string) {
  const domain = getEmailDomain(email);
  return BLOCKED_EMAIL_DOMAINS.has(domain);
}

/* ==================== RATE LIMITING ==================== */
function getClientKey(req: any) {
  const xff = safeStr(req.headers["x-forwarded-for"]);
  const ip = xff ? xff.split(",")[0].trim() : safeStr(req.ip);
  const host = safeStr(req.headers["x-forwarded-host"] || req.headers.host || "");
  return `${ip || "unknown"}|${host || "unknown"}`;
}

const createGiftLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 12,
  keyGenerator: (req) => getClientKey(req),
  handler: (req, res) => {
    logEvent("rate_limited_create_gift", { key: getClientKey(req) });
    res.status(429).json({ error: "Too many requests" });
  },
});

const claimGiftLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => getClientKey(req),
  handler: (req, res) => {
    logEvent("rate_limited_claim_gift", { key: getClientKey(req) });
    res.status(429).json({ error: "Too many requests" });
  },
});

/* ==================== SEED ==================== */
async function seed() {
  const existing = await db.select().from(gifts).limit(1);
  if (!existing || existing.length === 0) {
    await db.insert(gifts).values({
      publicId: "demo-gift",
      recipientEmail: "demo@example.com",
      message: "Welcome to ThanküMail 🎁",
      amount: 1000,
      isClaimed: false,
    });
    logEvent("seed_inserted");
  } else {
    logEvent("seed_noop");
  }
}

/* ==================== SCHEMAS ==================== */
const CreateGiftSchema = z.object({
  recipientEmail: z.string().email(),
  message: z.string().min(1).max(1000),
  amount: z.number().int().min(1000),
});

/* ==================== ROUTES ==================== */
export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  await seed();

  /* -------- HEALTH -------- */
  app.get(["/health", "/api/health"], (_req, res) => {
    res.json({
      ok: true,
      routesMarker: "ROUTES_MARKER_v13_disposable_email_block",
    });
  });

  /* -------- ADMIN STATUS -------- */
  app.get("/api/admin/status", (_req, res) => {
    res.json({
      ok: true,
      email: {
        disposableBlockEnabled: true,
        blockedDomainsCount: BLOCKED_EMAIL_DOMAINS.size,
      },
    });
  });

  /* -------- CREATE GIFT -------- */
  app.post("/api/gifts", createGiftLimiter, async (req, res) => {
    const parsed = CreateGiftSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid payload", issues: parsed.error.issues });
    }

    const { recipientEmail, message, amount } = parsed.data;

    if (isDisposableEmail(recipientEmail)) {
      logEvent("gift_create_blocked_disposable_email", {
        recipientEmail,
        domain: getEmailDomain(recipientEmail),
      });
      return res.status(400).json({
        error: "Disposable email addresses are not allowed",
        field: "recipientEmail",
      });
    }

    const publicId = crypto.randomBytes(6).toString("hex");
    const claimAbs = `${getBaseUrl(req)}/claim/${publicId}`;

    await db.insert(gifts).values({
      publicId,
      recipientEmail,
      message,
      amount,
      isClaimed: false,
    });

    res.json({ success: true, giftId: publicId, claimLink: `/claim/${publicId}` });

    sendGiftEmail({
      to: recipientEmail,
      claimLink: claimAbs,
      message,
      amountCents: amount,
    }).then((r: any) =>
      logEvent(r.ok ? "email_send_ok" : "email_send_failed", {
        publicId,
        error: r.ok ? undefined : r.error,
      }),
    );
  });

  /* -------- GET GIFT -------- */
  app.get("/api/gifts/:publicId", async (req, res) => {
    const row = (
      await db.select().from(gifts).where(eq(gifts.publicId, req.params.publicId)).limit(1)
    )[0];

    if (!row) return res.status(404).json({ error: "Not found" });

    res.json(row);
  });

  /* -------- CLAIM -------- */
  app.post("/api/gifts/:publicId/claim", claimGiftLimiter, async (req, res) => {
    const row = (
      await db.select().from(gifts).where(eq(gifts.publicId, req.params.publicId)).limit(1)
    )[0];

    if (!row) return res.status(404).json({ error: "Not found" });
    if (row.isClaimed) return res.status(409).json({ error: "Already claimed" });

    const claimedAt = new Date();
    await db
      .update(gifts)
      .set({ isClaimed: true, claimedAt: claimedAt as any })
      .where(eq(gifts.publicId, req.params.publicId));

    res.json({ success: true, publicId: row.publicId, claimedAt: claimedAt.toISOString() });
  });

  return httpServer;
}
