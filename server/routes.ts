// WHERE TO PASTE: server/routes.ts
// ACTION: FULL REPLACEMENT — paste the entire file

import type { Express } from "express";
import type { Server } from "http";
import crypto from "crypto";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { db } from "./db";
import { gifts } from "@shared/schema";
import { eq } from "drizzle-orm";
import { sendGiftEmail } from "./email";

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

/* -------------------- TIMEOUT WRAPPER -------------------- */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout:${label}:${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/* -------------------- RATE LIMITING -------------------- */
function getClientKey(req: any) {
  const xff = safeStr(req.headers["x-forwarded-for"]);
  const firstXff = xff ? xff.split(",")[0].trim() : "";
  const ip = safeStr(req.ip);
  const host = safeStr(req.headers["x-forwarded-host"] || req.headers.host || "");
  return `${firstXff || ip || "unknown"}|${host || "unknown"}`;
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

/* -------------------- SEED -------------------- */
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

/* -------------------- SCHEMAS -------------------- */
const CreateGiftSchema = z.object({
  recipientEmail: z.string().email(),
  message: z.string().min(1).max(1000),
  amount: z.number().int().min(1000),
});

/* ==================== ROUTES ==================== */
export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  await seed();

  /* -------- HEALTH -------- */
  app.get(["/health", "/__health", "/api/health"], (_req, res) => {
    res.json({
      ok: true,
      routesMarker: "ROUTES_MARKER_v12_admin_status_live",
      gitCommit: process.env.RENDER_GIT_COMMIT || "",
      serviceId: process.env.RENDER_SERVICE_ID || "",
    });
  });

  /* -------- ADMIN STATUS (NO SECRETS) -------- */
  app.get("/api/admin/status", (_req, res) => {
    res.json({
      ok: true,
      env: {
        NODE_ENV: process.env.NODE_ENV || "",
        PUBLIC_BASE_URL: Boolean(process.env.PUBLIC_BASE_URL),
        BASE_URL: Boolean(process.env.BASE_URL),
        FROM_EMAIL: Boolean(process.env.FROM_EMAIL),
        BREVO_API_KEY: Boolean(process.env.BREVO_API_KEY),
      },
      email: {
        provider: "brevo",
        configured: Boolean(process.env.FROM_EMAIL && process.env.BREVO_API_KEY),
      },
      uptimeSec: Math.floor(process.uptime()),
    });
  });

  /* -------- CREATE GIFT -------- */
  app.post("/api/gifts", createGiftLimiter, async (req, res) => {
    const parsed = CreateGiftSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid payload", issues: parsed.error.issues });
    }

    const { recipientEmail, message, amount } = parsed.data;
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

    withTimeout(
      sendGiftEmail({
        to: recipientEmail,
        claimLink: claimAbs,
        message,
        amountCents: amount,
      }),
      10000,
      "sendGiftEmail",
    )
      .then((r: any) =>
        logEvent(r.ok ? "email_send_ok" : "email_send_failed", {
          publicId,
          error: r.ok ? undefined : r.error,
        }),
      )
      .catch((e) => logEvent("email_send_failed", { publicId, error: e?.message || e }));
  });

  /* -------- GET GIFT -------- */
  app.get("/api/gifts/:publicId", async (req, res) => {
    const row = (
      await db
        .select()
        .from(gifts)
        .where(eq(gifts.publicId, req.params.publicId))
        .limit(1)
    )[0];

    if (!row) return res.status(404).json({ error: "Not found" });

    res.json({
      publicId: row.publicId,
      recipientEmail: row.recipientEmail,
      message: row.message,
      amount: row.amount,
      isClaimed: row.isClaimed,
      createdAt: row.createdAt,
      claimedAt: row.claimedAt,
    });
  });

  /* -------- CLAIM -------- */
  app.post("/api/gifts/:publicId/claim", claimGiftLimiter, async (req, res) => {
    const row = (
      await db
        .select()
        .from(gifts)
        .where(eq(gifts.publicId, req.params.publicId))
        .limit(1)
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
