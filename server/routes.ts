import type { Express, Request } from "express";
import { createServer, type Server } from "http";
import crypto from "crypto";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { eq, and, gte, asc, lte, isNull } from "drizzle-orm";

import { db } from "./db";
import { gifts } from "@shared/schema";
import { sendGiftEmail } from "./email";
import { sendGiftSms } from "./sms";

/* -------------------- VERSION -------------------- */
const VERSION = "routes_v2026-01-28_003";
const COMMIT = process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || "";

/* -------------------- STRUCTURED LOGGING -------------------- */
function logEvent(event: string, fields: Record<string, any> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}
function safeStr(v: any) {
  return typeof v === "string" ? v : "";
}
function toMs(d: any) {
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime();
  return Number.isFinite(t) ? t : 0;
}

/* -------------------- CLAIM SITE BASE URL -------------------- */
function getClaimSiteBaseUrl(req: Request) {
  const env = process.env.PUBLIC_SITE_URL || process.env.PUBLIC_CLAIM_BASE_URL || "";
  if (env) return env.replace(/\/+$/, "");
  const proto = (req.headers["x-forwarded-proto"] || "https").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return `${proto}://${host}`.replace(/\/+$/, "");
}

/* -------------------- IP -------------------- */
function getClientIp(req: Request) {
  const cf = safeStr(req.headers["cf-connecting-ip"]);
  if (cf) return cf;
  const xff = safeStr(req.headers["x-forwarded-for"]);
  if (xff) return xff.split(",")[0].trim();
  return safeStr((req.socket as any)?.remoteAddress);
}

/* -------------------- TURNSTILE -------------------- */
async function verifyTurnstile(token: string, req: Request) {
  const secret = process.env.TURNSTILE_SECRET_KEY || "";
  const bypass = (process.env.TURNSTILE_BYPASS || "").toLowerCase() === "true";

  if (!secret) return { ok: true, mode: "not_configured" as const, codes: [] as string[] };
  if (bypass) return { ok: true, mode: "bypass" as const, codes: [] as string[] };
  if (!token) return { ok: false, mode: "enforced" as const, codes: ["missing-input-response"] };

  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", token);

  const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  const json: any = await resp.json().catch(() => ({}));
  return {
    ok: !!json?.success,
    mode: "enforced" as const,
    codes: Array.isArray(json?.["error-codes"]) ? json["error-codes"] : [],
  };
}

/* -------------------- HELPERS -------------------- */
function newPublicId() {
  return crypto.randomBytes(16).toString("hex");
}
function isE164(s: string) {
  return /^\+[1-9]\d{7,14}$/.test(String(s || "").trim());
}

/* -------------------- VALIDATION -------------------- */
const CreateGiftSchema = z.object({
  senderEmail: z.string().email().optional().or(z.literal("")),
  recipientEmail: z.string().email().optional().or(z.literal("")),
  recipientPhone: z.string().optional().or(z.literal("")).refine(v => !v || isE164(v)),
  message: z.string().min(1).max(2000),
  amount: z.number().int().min(1000).max(100000),
  turnstileToken: z.string().optional().or(z.literal("")),
});

const ClaimSchema = z.object({
  turnstileToken: z.string().optional().or(z.literal("")),
});

const AdminRemindersSchema = z.object({
  dryRun: z.boolean().optional().default(true),
  limit: z.number().int().min(1).max(500).optional().default(25),
  olderThanHours: z.number().int().min(1).max(24 * 365).optional().default(24),
  publicId: z.string().optional(),
});

/* -------------------- LIMITERS -------------------- */
const createGiftLimiter = rateLimit({ windowMs: 60_000, max: 10 });
const claimLimiter = rateLimit({ windowMs: 60_000, max: 30 });

/* -------------------- REMINDERS POLICY -------------------- */
const DEFAULT_REMINDER_GAP_MS = 2 * 24 * 60 * 60 * 1000;
const REMINDER_MAX = 3;
function getReminderGapMs() {
  const raw = Number(process.env.REMINDER_INTERVAL_MS || 0);
  return raw > 0 ? raw : DEFAULT_REMINDER_GAP_MS;
}

/* -------------------- ADMIN AUTH -------------------- */
function requireAdmin(req: Request) {
  const expected = safeStr(process.env.ADMIN_TOKEN);
  const got = safeStr(req.headers["x-admin-token"]);
  if (!expected || got !== expected) return false;
  return true;
}

/* -------------------- ROUTES -------------------- */
export function registerRoutes(app: Express): Server {
  app.get("/api/version", (_req, res) =>
    res.json({ ok: true, version: VERSION, commit: COMMIT }),
  );

  /* -------- ADMIN: REMINDERS (TARGETABLE) -------- */
  app.post("/api/admin/reminders/send", async (req, res) => {
    if (!requireAdmin(req)) return res.status(401).json({ ok: false });

    const parsed = AdminRemindersSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ ok: false });

    const { dryRun, limit, olderThanHours, publicId } = parsed.data;
    const gapMs = getReminderGapMs();
    const now = Date.now();
    const cutoff = new Date(now - olderThanHours * 3600 * 1000);

    let candidates: any[] = [];

    if (publicId) {
      candidates = await db
        .select()
        .from(gifts)
        .where(
          and(
            eq(gifts.publicId, publicId),
            eq(gifts.isClaimed, false),
            isNull((gifts as any).returnedToSenderAt),
          ),
        );
    } else {
      candidates = await db
        .select()
        .from(gifts)
        .where(
          and(
            eq(gifts.isClaimed, false),
            isNull((gifts as any).returnedToSenderAt),
            lte(gifts.createdAt, cutoff),
          ),
        )
        .orderBy(asc(gifts.createdAt))
        .limit(limit);
    }

    const toRemind: any[] = [];
    const toReturn: any[] = [];

    for (const g of candidates) {
      const count = Number(g.reminderCount || 0);
      const last = toMs(g.lastReminderSentAt);
      if (count >= REMINDER_MAX) toReturn.push(g);
      else if (!last || now - last >= gapMs) toRemind.push(g);
    }

    if (dryRun) {
      return res.json({
        ok: true,
        dryRun: true,
        willRemind: toRemind.length,
        willReturn: toReturn.length,
        version: VERSION,
      });
    }

    for (const g of toRemind) {
      await db
        .update(gifts)
        .set({
          reminderCount: g.reminderCount + 1,
          lastReminderSentAt: new Date(),
        })
        .where(eq(gifts.publicId, g.publicId));
    }

    for (const g of toReturn) {
      await db
        .update(gifts)
        .set({ returnedToSenderAt: new Date() })
        .where(eq(gifts.publicId, g.publicId));
    }

    return res.json({
      ok: true,
      reminded: toRemind.length,
      returned: toReturn.length,
      version: VERSION,
    });
  });

  const httpServer = createServer(app);
  return httpServer;
}
