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
  const payload = {
    ts: new Date().toISOString(),
    event,
    ...fields,
  };
  console.log(JSON.stringify(payload));
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
      }
    );
  });
}

/* -------------------- RATE LIMITING (MEMORY STORE) -------------------- */
/**
 * Most stable client key on Render:
 * - take the FIRST IP in x-forwarded-for (client)
 * - fallback to req.ip
 * - include host to avoid cross-domain collisions later
 */
function getClientKey(req: any) {
  const xff = safeStr(req.headers["x-forwarded-for"]);
  const firstXff = xff ? xff.split(",")[0].trim() : "";
  const ip = safeStr(req.ip);
  const host = safeStr(req.headers["x-forwarded-host"] || req.headers.host || "");
  return `${firstXff || ip || "unknown"}|${host || "unknown"}`;
}

const createGiftLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 min
  max: 12, // 12 creates per 10 min per client key
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientKey(req),
  handler: (req, res) => {
    const requestId = safeStr(req.headers["x-request-id"] || req.headers["cf-ray"] || "");
    logEvent("rate_limited_create_gift", { requestId, key: getClientKey(req) });
    res.status(429).json({ error: "Too many requests", route: "POST /api/gifts" });
  },
});

const claimGiftLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 min
  max: 30, // 30 claim attempts per 10 min per client key
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientKey(req),
  handler: (req, res) => {
    const requestId = safeStr(req.headers["x-request-id"] || req.headers["cf-ray"] || "");
    logEvent("rate_limited_claim_gift", { requestId, key: getClientKey(req) });
    res.status(429).json({ error: "Too many requests", route: "POST /api/gifts/:publicId/claim" });
  },
});

/* -------------------- SAFE SEED -------------------- */
async function seed() {
  try {
    const existing = await db.select().from(gifts).limit(1);
    if (!existing || existing.length === 0) {
      const publicId = "demo-gift";
      await db.insert(gifts).values({
        publicId,
        recipientEmail: "demo@example.com",
        message: "Here's a little thank you for trying out ThanküMail! 🎁",
        amount: 1000,
        isClaimed: false,
      });
      logEvent("seed_inserted", { publicId });
    } else {
      logEvent("seed_noop", { reason: "already_has_rows" });
    }
  } catch (e: any) {
    logEvent("seed_error", { error: safeStr(e?.message || e) });
  }
}

/* -------------------- SCHEMAS -------------------- */
const CreateGiftSchema = z.object({
  recipientEmail: z.string().email(),
  message: z.string().min(1).max(1000),
  amount: z.number().int().min(1000),
});

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  try {
    await seed();
  } catch (e: any) {
    logEvent("seed_crash_prevented", { error: safeStr(e?.message || e) });
  }

  /* -------------------- HEALTH -------------------- */
  app.get(["/health", "/__health"], (_req, res) => {
    res.json({
      ok: true,
      routesMarker: "ROUTES_MARKER_v7_rate_limit_memory_ok_2026-01-10",
    });
  });

  /* -------------------- PING (DEBUG KEY) -------------------- */
  app.get("/api/__ping", (req, res) => {
    res.json({
      ok: true,
      ts: new Date().toISOString(),
      key: getClientKey(req),
      ip: safeStr(req.ip),
      xff: safeStr(req.headers["x-forwarded-for"]),
      host: safeStr(req.headers["x-forwarded-host"] || req.headers.host || ""),
    });
  });

  /* -------------------- CREATE GIFT -------------------- */
  app.post("/api/gifts", createGiftLimiter, async (req, res) => {
    const requestId = safeStr(req.headers["x-request-id"] || req.headers["cf-ray"] || "");
    const started = Date.now();

    logEvent("gift_create_start", { requestId, key: getClientKey(req) });

    try {
      const parsed = CreateGiftSchema.safeParse(req.body);
      if (!parsed.success) {
        logEvent("gift_create_validation_failed", { requestId, issues: parsed.error.issues });
        return res.status(400).json({ error: "Invalid payload", issues: parsed.error.issues });
      }

      const { recipientEmail, message, amount } = parsed.data;

      const publicId = crypto.randomBytes(6).toString("hex");
      const baseUrl = getBaseUrl(req);
      const claimLinkAbs = `${baseUrl}/claim/${publicId}`;

      await db.insert(gifts).values({
        publicId,
        recipientEmail,
        message,
        amount,
        isClaimed: false,
      });

      logEvent("gift_create_db_insert_ok", { requestId, publicId, ms: Date.now() - started });

      // respond immediately (email is background)
      res.json({ success: true, giftId: publicId, claimLink: `/claim/${publicId}` });

      (async () => {
        const emailStarted = Date.now();
        try {
          const info = await withTimeout(
            sendGiftEmail({
              to: recipientEmail,
              claimLink: claimLinkAbs,
              message,
              amountCents: amount,
            }),
            10_000,
            "sendGiftEmail"
          );

          logEvent("email_send_ok", {
            requestId,
            publicId,
            to: recipientEmail,
            messageId: safeStr((info as any)?.messageId),
            ms: Date.now() - emailStarted,
          });
        } catch (e: any) {
          logEvent("email_send_failed", {
            requestId,
            publicId,
            to: recipientEmail,
            error: safeStr(e?.message || e),
            ms: Date.now() - emailStarted,
          });
        }
      })().catch((e) => {
        logEvent("email_bg_task_crash", { requestId, publicId, error: safeStr((e as any)?.message || e) });
      });

      return;
    } catch (e: any) {
      logEvent("gift_create_error", { requestId, error: safeStr(e?.message || e) });
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /* -------------------- GET GIFT -------------------- */
  app.get("/api/gi
