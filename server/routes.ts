// WHERE TO PASTE: server/routes.ts
// ACTION: Full file replacement (paste exactly)

import type { Express, Request } from "express";
import { createServer, type Server } from "http";
import crypto from "crypto";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { and, asc, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import dns from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";

import { db } from "./db";
import { gifts, users, authMagicLinks, authSessions } from "@shared/schema";
import { sendGiftEmail, sendReminderEmail, sendReturnToSenderEmail } from "./email";

/* -------------------- VERSION -------------------- */
const VERSION = "routes_v2026-02-19_001";
const COMMIT = process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || "";

/* -------------------- ROUTES MARKER -------------------- */
const ROUTES_MARKER =
  "locked_scope_guest_preset_email_only_registered_preset_or_custom_amounts_fixed_25_50_100_250_500_1000_schema_aligned_v1_auth_hardened_magiclink_v1_disposable_file_v2_auth_me_v1";

/* -------------------- AMOUNTS -------------------- */
const ALLOWED_AMOUNTS_DOLLARS = [25, 50, 100, 250, 500, 1000] as const;
const ALLOWED_AMOUNTS_CENTS = new Set(ALLOWED_AMOUNTS_DOLLARS.map((d) => d * 100));
const MIN_AMOUNT_CENTS_REGISTERED = 25 * 100;

/* -------------------- TURNSTILE -------------------- */
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_SECRET_KEY = (process.env.TURNSTILE_SECRET_KEY || "").trim();
const TURNSTILE_BYPASS = String(process.env.TURNSTILE_BYPASS || "false").toLowerCase() === "true";

/* -------------------- AUTH HARDENING -------------------- */
const AUTH_MAGIC_LINK_TTL_MS = 10 * 60 * 1000; // 10 minutes (requested)
const AUTH_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const AUTH_RETURN_TOKEN =
  String(process.env.AUTH_RETURN_TOKEN ?? "true").toLowerCase() === "true"; // dev-friendly; set false to never return token
const AUTH_MX_VALIDATE_ENABLED =
  String(process.env.AUTH_MX_VALIDATE_ENABLED ?? "false").toLowerCase() === "true";

/**
 * Disposable emails:
 * - Primary source: server/disposableDomains.txt (one domain per line)
 * - Optional overrides: DISPOSABLE_EMAIL_DOMAINS env (comma-separated exact domains)
 *
 * Note: In production (Render), runtime CWD + dist layout can vary.
 * We attempt a robust set of locations.
 */
function loadDisposableDomainsFromFile(): { set: Set<string>; loadedFrom: string | null } {
  const cwd = process.cwd();

  const candidates = [
    // repo-root style
    path.resolve(cwd, "server", "disposableDomains.txt"),
    path.resolve(cwd, "disposableDomains.txt"),

    // dist shipped artifacts (common on Render)
    path.resolve(cwd, "dist", "server", "disposableDomains.txt"),
    path.resolve(cwd, "dist", "disposableDomains.txt"),

    // relative to this compiled file location (best effort)
    path.resolve(__dirname, "server", "disposableDomains.txt"),
    path.resolve(__dirname, "disposableDomains.txt"),
    path.resolve(__dirname, "..", "server", "disposableDomains.txt"),
    path.resolve(__dirname, "..", "disposableDomains.txt"),
  ];

  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, "utf8");
      const lines = raw
        .split(/\r?\n/g)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
        .filter((s) => !s.startsWith("#"))
        .filter((s) => !s.startsWith("//"));
      return { set: new Set(lines), loadedFrom: p };
    } catch {
      // ignore and fall through
    }
  }
  return { set: new Set(), loadedFrom: null };
}

const DISPOSABLE_FILE = loadDisposableDomainsFromFile();
const DISPOSABLE_EMAIL_DOMAINS_FILE = DISPOSABLE_FILE.set;
const DISPOSABLE_EMAIL_DOMAINS_FILE_PATH = DISPOSABLE_FILE.loadedFrom;

const DISPOSABLE_EMAIL_DOMAINS_ENV = new Set(
  String(process.env.DISPOSABLE_EMAIL_DOMAINS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

const DISPOSABLE_EMAIL_DOMAINS = new Set<string>([
  ...Array.from(DISPOSABLE_EMAIL_DOMAINS_FILE),
  ...Array.from(DISPOSABLE_EMAIL_DOMAINS_ENV),
]);

/* -------------------- LIMITS -------------------- */
const DAILY_LIMIT_IP = Math.max(0, Number(process.env.DAILY_LIMIT_IP ?? 10));
const DAILY_LIMIT_SENDER = Math.max(0, Number(process.env.DAILY_LIMIT_SENDER ?? 0));
const DAILY_LIMIT_PHONE = Math.max(0, Number(process.env.DAILY_LIMIT_PHONE ?? 3)); // reserved (phone disabled in locked scope)

const MIN_CLAIM_DELAY_SEC = Math.max(0, Number(process.env.MIN_CLAIM_DELAY_SEC ?? 60));
const SMS_DUPLICATE_WINDOW_SEC = Math.max(0, Number(process.env.SMS_DUPLICATE_WINDOW_SEC ?? 90)); // reserved

const REMINDER_GAP_MS = Math.max(1_000, Number(process.env.REMINDER_GAP_MS ?? 172800000)); // 48h default
const REMINDER_MAX = Math.max(0, Number(process.env.REMINDER_MAX ?? 3));
const REMINDER_SENDING_ENABLED =
  String(process.env.REMINDER_SENDING_ENABLED ?? "true").toLowerCase() === "true";

/* -------------------- ADMIN -------------------- */
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || "").trim();

/* -------------------- HELPERS -------------------- */
function now() {
  return new Date();
}

function getIp(req: Request) {
  const xf = (req.headers["x-forwarded-for"] || "") as string;
  return (xf.split(",")[0] || "").trim() || req.socket.remoteAddress || "";
}

function sha256Hex(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

function moneyToCents(dollars: number) {
  const cents = Math.round((Number(dollars) || 0) * 100);
  return Number.isFinite(cents) ? cents : 0;
}

function normalizeEmail(e: string) {
  return String(e || "").trim().toLowerCase();
}

function extractDomain(email: string) {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "";
  return email.slice(at + 1).trim().toLowerCase();
}

function isDisposableEmail(email: string) {
  const d = extractDomain(email);
  if (!d) return false;
  if (!DISPOSABLE_EMAIL_DOMAINS.size) return false;
  return DISPOSABLE_EMAIL_DOMAINS.has(d);
}

async function mxLooksValid(domain: string) {
  if (!AUTH_MX_VALIDATE_ENABLED) return { ok: true, reason: "disabled" as const };
  if (!domain) return { ok: false, reason: "no-domain" as const };
  try {
    const mx = await dns.resolveMx(domain);
    if (!Array.isArray(mx) || mx.length === 0) return { ok: false, reason: "no-mx" as const };
    return { ok: true, reason: "ok" as const };
  } catch {
    return { ok: false, reason: "dns-failed" as const };
  }
}

async function verifyTurnstile(turnstileToken: string, remoteip: string) {
  if (!TURNSTILE_SECRET_KEY) {
    return { ok: true, mode: "disabled" as const, codes: [] as string[] };
  }
  if (TURNSTILE_BYPASS) {
    return { ok: true, mode: "bypass" as const, codes: [] as string[] };
  }

  const body = new URLSearchParams();
  body.set("secret", TURNSTILE_SECRET_KEY);
  body.set("response", String(turnstileToken || ""));
  if (remoteip) body.set("remoteip", remoteip);

  const r = await fetch(TURNSTILE_VERIFY_URL, { method: "POST", body });
  const j: any = await r.json().catch(() => ({}));

  const success = Boolean(j && j.success);
  const codes: string[] = Array.isArray(j?.["error-codes"]) ? j["error-codes"] : [];
  return { ok: success, mode: "enforced" as const, codes };
}

function isAdmin(req: Request) {
  if (!ADMIN_TOKEN) return false;
  const auth = String(req.headers.authorization || "");
  if (auth.toLowerCase().startsWith("bearer ")) {
    const t = auth.slice("bearer ".length).trim();
    if (t && t === ADMIN_TOKEN) return true;
  }
  const x = String(req.headers["x-admin-token"] || "").trim();
  return Boolean(x && x === ADMIN_TOKEN);
}

function shouldRequireTurnstile() {
  return Boolean(TURNSTILE_SECRET_KEY) && !TURNSTILE_BYPASS;
}

/* -------------------- DAILY COUNTS -------------------- */
/**
 * Schema note:
 * - gifts does NOT have senderIp column.
 * - To avoid crashes, we enforce per-IP via a runtime memory counter ONLY (best-effort)
 *   unless you later add sender_ip to schema.
 */
const memIpCounts = new Map<string, { day: string; count: number }>();
function dayKey(d: Date) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function bumpMemIp(ip: string) {
  const k = dayKey(new Date());
  const cur = memIpCounts.get(ip);
  if (!cur || cur.day !== k) {
    memIpCounts.set(ip, { day: k, count: 1 });
    return 1;
  }
  cur.count += 1;
  memIpCounts.set(ip, cur);
  return cur.count;
}
function getMemIp(ip: string) {
  const k = dayKey(new Date());
  const cur = memIpCounts.get(ip);
  if (!cur || cur.day !== k) return 0;
  return cur.count;
}

async function countDailyBySenderEmail(senderEmail: string) {
  if (!DAILY_LIMIT_SENDER) return 0;
  if (!senderEmail) return 0;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const rows = await db
    .select({ c: sql<number>`count(*)` })
    .from(gifts)
    .where(and(eq(gifts.senderEmail, senderEmail), gte(gifts.createdAt, start)));
  return Number(rows?.[0]?.c || 0);
}

/* -------------------- AUTH -------------------- */
type Authed = { isAuthed: true; userId: string; sessionToken: string } | { isAuthed: false };

async function getAuth(req: Request): Promise<Authed> {
  const auth = String(req.headers.authorization || "");
  if (!auth.toLowerCase().startsWith("bearer ")) return { isAuthed: false };
  const sessionToken = auth.slice("bearer ".length).trim();
  if (!sessionToken) return { isAuthed: false };

  const sessionHash = sha256Hex(sessionToken);

  const row = await db
    .select({
      userId: authSessions.userId,
      expiresAt: authSessions.expiresAt,
      revokedAt: authSessions.revokedAt,
    })
    .from(authSessions)
    .where(eq(authSessions.sessionHash, sessionHash))
    .limit(1);

  const s = row?.[0];
  if (!s) return { isAuthed: false };
  if (s.revokedAt) return { isAuthed: false };
  if (s.expiresAt && new Date(s.expiresAt).getTime() <= Date.now()) return { isAuthed: false };

  return { isAuthed: true, userId: String(s.userId), sessionToken };
}

/* -------------------- VALIDATION -------------------- */
const zEmail = z.string().trim().email();

const zCreateGift = z.object({
  recipientEmail: zEmail.optional().nullable(),
  senderEmail: zEmail.optional().nullable(),

  messageMode: z.enum(["preset", "custom"]).optional(),
  presetMessageId: z.coerce.number().int().optional().nullable(),
  message: z.string().trim().max(280).optional().nullable(),

  amountDollars: z.number().optional().nullable(),
  amountCents: z.number().int().optional().nullable(),

  turnstileToken: z.string().trim().optional().nullable(),
});

const zAuthRequest = z.object({
  email: zEmail,
  turnstileToken: z.string().trim().optional().nullable(),
});

const zAuthConsume = z.object({
  token: z.string().trim().min(10),
});

/* -------------------- RATE LIMITERS -------------------- */
const limiterCreateGift = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

const limiterAuthRequest = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

const limiterAuthConsume = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

const limiterAdmin = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

/* -------------------- ROUTES -------------------- */
export function registerRoutes(app: Express): Server {
  /* -------------------- HEALTH/VERSION -------------------- */
  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      version: VERSION,
      commit: COMMIT,
      marker: ROUTES_MARKER,
      ts: new Date().toISOString(),
    });
  });

  app.get("/api/version", (_req, res) => {
    res.json({
      version: VERSION,
      commit: COMMIT,
      routesMarker: ROUTES_MARKER,

      turnstile: {
        configured: Boolean(TURNSTILE_SECRET_KEY),
        bypass: TURNSTILE_BYPASS,
        mode: TURNSTILE_SECRET_KEY ? (TURNSTILE_BYPASS ? "bypass" : "enforced") : "disabled",
      },

      auth: {
        magicLinkTtlMs: AUTH_MAGIC_LINK_TTL_MS,
        sessionTtlMs: AUTH_SESSION_TTL_MS,
        returnToken: AUTH_RETURN_TOKEN,
        mxValidateEnabled: AUTH_MX_VALIDATE_ENABLED,
        disposableListSize: DISPOSABLE_EMAIL_DOMAINS.size,
        disposableFileLoaded: DISPOSABLE_EMAIL_DOMAINS_FILE.size > 0,
        disposableEnvLoaded: DISPOSABLE_EMAIL_DOMAINS_ENV.size > 0,
        disposableFilePath: DISPOSABLE_EMAIL_DOMAINS_FILE_PATH,
      },

      limits: {
        dailyLimitIp: DAILY_LIMIT_IP,
        dailyLimitSender: DAILY_LIMIT_SENDER,
        dailyLimitPhone: DAILY_LIMIT_PHONE,
        minClaimDelaySec: MIN_CLAIM_DELAY_SEC,
        smsDuplicateWindowSec: SMS_DUPLICATE_WINDOW_SEC,
      },

      reminders: {
        reminderGapMs: REMINDER_GAP_MS,
        reminderMax: REMINDER_MAX,
        reminderSendingEnabled: REMINDER_SENDING_ENABLED,
      },

      lockedScope: {
        guest: { delivery: "email-only", message: "preset-only", amount: "none" },
        registered: {
          delivery: "email-only",
          message: "preset-or-custom",
          amount: `optional (allowed: ${ALLOWED_AMOUNTS_DOLLARS.join(", ")}; min $25 when present)`,
        },
      },
    });
  });

  /* -------------------- AUTH: MAGIC LINK (HARDENED) -------------------- */
  app.post("/api/auth/request", limiterAuthRequest, async (req, res) => {
    try {
      const ip = getIp(req);
      const parsed = zAuthRequest.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid request",
          code: "INVALID_REQUEST",
          issues: parsed.error.issues,
          version: VERSION,
        });
      }

      const email = normalizeEmail(parsed.data.email);
      const domain = extractDomain(email);
      const turnstileToken = String(parsed.data.turnstileToken || "").trim();

      if (!domain) {
        return res.status(400).json({
          error: "Invalid email",
          field: "email",
          code: "INVALID_EMAIL",
          version: VERSION,
        });
      }

      if (shouldRequireTurnstile()) {
        if (!turnstileToken) {
          return res.status(400).json({
            error: "Missing CAPTCHA token",
            field: "turnstileToken",
            code: "TURNSTILE_REQUIRED",
            version: VERSION,
          });
        }
      }

      const v = await verifyTurnstile(turnstileToken, ip);
      if (!v.ok) {
        return res.status(400).json({
          error: "Missing or invalid CAPTCHA token",
          field: "turnstileToken",
          code: "TURNSTILE_FAILED",
          codes: v.codes,
          version: VERSION,
        });
      }

      if (isDisposableEmail(email)) {
        return res.status(400).json({
          error: "Email provider not supported",
          field: "email",
          code: "DISPOSABLE_EMAIL_BLOCKED",
          version: VERSION,
        });
      }

      const mx = await mxLooksValid(domain);
      if (!mx.ok) {
        return res.status(400).json({
          error: "Email domain not deliverable",
          field: "email",
          code: "MX_INVALID",
          reason: mx.reason,
          version: VERSION,
        });
      }

      const rawToken = randomToken(24);
      const tokenHash = sha256Hex(rawToken);
      const expiresAt = new Date(Date.now() + AUTH_MAGIC_LINK_TTL_MS);
      const ua = String(req.headers["user-agent"] || "").slice(0, 500);

      await db.insert(authMagicLinks).values({
        email,
        tokenHash,
        expiresAt,
        consumedAt: null,
        ip,
        userAgent: ua || null,
        createdAt: now(),
      });

      if (AUTH_RETURN_TOKEN) {
        return res.json({
          ok: true,
          token: rawToken,
          expiresAt: expiresAt.toISOString(),
          version: VERSION,
        });
      }

      return res.json({
        ok: true,
        sent: true,
        expiresAt: expiresAt.toISOString(),
        version: VERSION,
      });
    } catch (err: any) {
      return res.status(500).json({
        error: "Auth request failed",
        code: "AUTH_REQUEST_FAILED",
        detail: String(err?.message || err),
        version: VERSION,
      });
    }
  });

  app.post("/api/auth/consume", limiterAuthConsume, async (req, res) => {
    try {
      const parsed = zAuthConsume.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid request",
          code: "INVALID_REQUEST",
          issues: parsed.error.issues,
          version: VERSION,
        });
      }

      const tokenHash = sha256Hex(parsed.data.token);

      const consumed = await db.transaction(async (tx) => {
        const updated = await tx
          .update(authMagicLinks)
          .set({ consumedAt: now() })
          .where(
            and(
              eq(authMagicLinks.tokenHash, tokenHash),
              isNull(authMagicLinks.consumedAt),
              gtTime(authMagicLinks.expiresAt, new Date())
            )
          )
          .returning({
            id: authMagicLinks.id,
            email: authMagicLinks.email,
            expiresAt: authMagicLinks.expiresAt,
          });

        if (updated?.length) {
          return { ok: true as const, email: String(updated[0].email || "").trim().toLowerCase() };
        }

        const row = await tx
          .select({
            consumedAt: authMagicLinks.consumedAt,
            expiresAt: authMagicLinks.expiresAt,
          })
          .from(authMagicLinks)
          .where(eq(authMagicLinks.tokenHash, tokenHash))
          .limit(1);

        const link = row?.[0];
        if (!link) return { ok: false as const, code: "MAGIC_LINK_INVALID" as const };
        if (link.consumedAt) return { ok: false as const, code: "MAGIC_LINK_USED" as const };
        if (link.expiresAt && new Date(link.expiresAt).getTime() <= Date.now())
          return { ok: false as const, code: "MAGIC_LINK_EXPIRED" as const };

        return { ok: false as const, code: "MAGIC_LINK_INVALID" as const };
      });

      if (!consumed.ok) {
        const msg =
          consumed.code === "MAGIC_LINK_USED"
            ? "Link already used"
            : consumed.code === "MAGIC_LINK_EXPIRED"
              ? "Link expired"
              : "Invalid or expired link";

        return res.status(400).json({
          error: msg,
          code: consumed.code,
          version: VERSION,
        });
      }

      const email = normalizeEmail(consumed.email);
      const domain = extractDomain(email);

      if (!domain) {
        return res.status(400).json({
          error: "Invalid email",
          code: "INVALID_EMAIL",
          version: VERSION,
        });
      }
      if (isDisposableEmail(email)) {
        return res.status(400).json({
          error: "Email provider not supported",
          code: "DISPOSABLE_EMAIL_BLOCKED",
          version: VERSION,
        });
      }
      const mx = await mxLooksValid(domain);
      if (!mx.ok) {
        return res.status(400).json({
          error: "Email domain not deliverable",
          code: "MX_INVALID",
          reason: mx.reason,
          version: VERSION,
        });
      }

      const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);

      let userId = String(existing?.[0]?.id || "");
      if (!userId) {
        userId = crypto.randomBytes(16).toString("hex");
        await db.insert(users).values({
          id: userId,
          email,
          createdAt: now(),
          lastLoginAt: null,
        });
      }

      const sessionToken = randomToken(32);
      const sessionHash = sha256Hex(sessionToken);
      const expiresAt = new Date(Date.now() + AUTH_SESSION_TTL_MS);
      const ip = getIp(req);
      const ua = String(req.headers["user-agent"] || "").slice(0, 500);

      await db.transaction(async (tx) => {
        await tx.insert(authSessions).values({
          userId,
          sessionHash,
          expiresAt,
          revokedAt: null,
          ip,
          userAgent: ua || null,
          createdAt: now(),
        });

        await tx.update(users).set({ lastLoginAt: now() }).where(eq(users.id, userId));
      });

      return res.json({
        ok: true,
        sessionToken,
        expiresAt: expiresAt.toISOString(),
        version: VERSION,
      });
    } catch (err: any) {
      return res.status(500).json({
        error: "Auth consume failed",
        code: "AUTH_CONSUME_FAILED",
        detail: String(err?.message || err),
        version: VERSION,
      });
    }
  });

  // Back-compat: keep /api/me, but frontend expects /api/auth/me
  app.get("/api/me", async (req, res) => {
    const a = await getAuth(req);
    if (!a.isAuthed) {
      return res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED", version: VERSION });
    }

    const row = await db
      .select({
        id: users.id,
        email: users.email,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
      })
      .from(users)
      .where(eq(users.id, a.userId))
      .limit(1);

    return res.json({ ok: true, user: row?.[0] || null, version: VERSION });
  });

  // NEW: /api/auth/me
  app.get("/api/auth/me", async (req, res) => {
    const a = await getAuth(req);
    if (!a.isAuthed) {
      return res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED", version: VERSION });
    }

    const row = await db
      .select({
        id: users.id,
        email: users.email,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
      })
      .from(users)
      .where(eq(users.id, a.userId))
      .limit(1);

    return res.json({ ok: true, user: row?.[0] || null, version: VERSION });
  });

  /* -------------------- GIFTS: CREATE -------------------- */
  app.post("/api/gifts", limiterCreateGift, async (req, res) => {
    try {
      const ip = getIp(req);

      if (DAILY_LIMIT_IP > 0) {
        const current = getMemIp(ip);
        if (current >= DAILY_LIMIT_IP) {
          return res.status(429).json({
            error: "Daily limit reached",
            code: "DAILY_LIMIT_IP",
            retryAfterSec: 60 * 60,
            version: VERSION,
          });
        }
      }

      const parsed = zCreateGift.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid request",
          code: "INVALID_REQUEST",
          issues: parsed.error.issues,
          version: VERSION,
        });
      }

      const a = await getAuth(req);
      const isRegistered = a.isAuthed;

      const {
        recipientEmail,
        senderEmail,
        messageMode,
        presetMessageId,
        message,
        amountDollars,
        amountCents,
        turnstileToken,
      } = parsed.data;

      const v = await verifyTurnstile(String(turnstileToken || ""), ip);
      if (!v.ok) {
        return res.status(400).json({
          error: "Missing or invalid CAPTCHA token",
          field: "turnstileToken",
          code: "TURNSTILE_FAILED",
          codes: v.codes,
          version: VERSION,
        });
      }

      const normSenderEmail = senderEmail ? String(senderEmail).trim().toLowerCase() : "";
      if (DAILY_LIMIT_SENDER > 0 && normSenderEmail) {
        const c = await countDailyBySenderEmail(normSenderEmail);
        if (c >= DAILY_LIMIT_SENDER) {
          return res.status(429).json({
            error: "Daily limit reached",
            code: "DAILY_LIMIT_SENDER",
            retryAfterSec: 60 * 60,
            version: VERSION,
          });
        }
      }

      const toEmail = String(recipientEmail || "").trim().toLowerCase();
      if (!toEmail) {
        return res.status(400).json({
          error: "Recipient email is required",
          field: "recipientEmail",
          code: "RECIPIENT_EMAIL_REQUIRED",
          version: VERSION,
        });
      }

      let finalAmountCents: number | null = null;
      if (amountCents != null) {
        finalAmountCents = Number(amountCents);
      } else if (amountDollars != null) {
        finalAmountCents = moneyToCents(Number(amountDollars));
      }

      let finalMessageMode: "preset" | "custom" = (messageMode as any) || "preset";
      let finalPresetMessageId: number | null = presetMessageId == null ? null : Number(presetMessageId);
      let finalMessage: string = message ? String(message).trim() : "";

      if (!isRegistered) {
        finalMessageMode = "preset";
        finalMessage = "";
        if (!Number.isInteger(finalPresetMessageId) || (finalPresetMessageId as number) < 1) {
          return res.status(400).json({
            error: "Preset message is required for guests",
            field: "presetMessageId",
            code: "GUEST_PRESET_REQUIRED",
            version: VERSION,
          });
        }
        if (finalAmountCents != null && finalAmountCents !== 0) {
          return res.status(400).json({
            error: "Guests cannot include an amount",
            field: "amountDollars",
            code: "GUEST_AMOUNT_NOT_ALLOWED",
            version: VERSION,
          });
        }
        finalAmountCents = null;
      } else {
        if (finalMessageMode === "custom") {
          const m = String(finalMessage || "").trim();
          if (!m) {
            return res.status(400).json({
              error: "Message is required for custom mode",
              field: "message",
              code: "CUSTOM_MESSAGE_REQUIRED",
              version: VERSION,
            });
          }
          if (m.length > 280) {
            return res.status(400).json({
              error: "Message too long (max 280)",
              field: "message",
              code: "MESSAGE_TOO_LONG",
              version: VERSION,
            });
          }
          finalMessage = m;
          finalPresetMessageId = null;
        } else {
          finalMessageMode = "preset";
          finalMessage = "";
          if (!Number.isInteger(finalPresetMessageId) || (finalPresetMessageId as number) < 1) {
            return res.status(400).json({
              error: "Preset message is required for preset mode",
              field: "presetMessageId",
              code: "PRESET_REQUIRED",
              version: VERSION,
            });
          }
        }

        if (finalAmountCents != null) {
          if (finalAmountCents < MIN_AMOUNT_CENTS_REGISTERED) {
            return res.status(400).json({
              error: "Minimum amount is $25",
              field: "amountDollars",
              code: "MIN_AMOUNT",
              version: VERSION,
            });
          }
          if (!ALLOWED_AMOUNTS_CENTS.has(finalAmountCents)) {
            return res.status(400).json({
              error: `Amount must be one of: ${ALLOWED_AMOUNTS_DOLLARS.join(", ")}`,
              field: "amountDollars",
              code: "AMOUNT_NOT_ALLOWED",
              version: VERSION,
            });
          }
        }
      }

      if (DAILY_LIMIT_IP > 0) bumpMemIp(ip);

      const publicId = crypto.randomBytes(16).toString("hex");
      const claimUrl =
        (process.env.PUBLIC_CLAIM_BASE_URL || "https://thankumail.com/claim").replace(/\/+$/, "") + "/" + publicId;

      const inserted = await db
        .insert(gifts)
        .values({
          publicId,
          senderUserId: isRegistered ? a.userId : null,
          senderEmail: normSenderEmail || null,
          recipientEmail: toEmail,
          recipientPhone: null,
          deliveryMethod: null,

          messageMode: finalMessageMode,
          presetMessageId: finalPresetMessageId,
          message: finalMessage,

          amount: finalAmountCents,

          isClaimed: false,
          createdAt: now(),
          claimedAt: null,

          reminderCount: 0,
          lastReminderSentAt: null,
          returnedToSenderAt: null,
        })
        .returning({ id: gifts.id });

      const giftId = Number(inserted?.[0]?.id || 0);
      void giftId;

      let emailSent = false;
      let deliveryError: string | null = null;

      try {
        await sendGiftEmail({
          to: toEmail,
          publicId,
          claimUrl,
          amountCents: finalAmountCents,
          senderEmail: normSenderEmail || undefined,
          message: finalMessageMode === "custom" ? (finalMessage || undefined) : undefined,
        } as any);
        emailSent = true;
      } catch (e: any) {
        deliveryError = String(e?.message || e);
      }

      return res.json({
        ok: true,
        publicId,
        claimUrl,
        deliveryOk: emailSent,
        emailSent,
        deliveryError: deliveryError || undefined,
        version: VERSION,
      });
    } catch (err: any) {
      return res.status(500).json({
        error: "Create gift failed",
        code: "CREATE_GIFT_FAILED",
        detail: String(err?.message || err),
        version: VERSION,
      });
    }
  });

  /* -------------------- GIFTS: GET -------------------- */
  app.get("/api/gifts/:publicId", async (req, res) => {
    try {
      const publicId = String(req.params.publicId || "").trim();
      if (!publicId) {
        return res.status(400).json({ error: "Missing id", code: "MISSING_ID", version: VERSION });
      }

      const row = await db
        .select({
          publicId: gifts.publicId,
          senderEmail: gifts.senderEmail,
          recipientEmail: gifts.recipientEmail,
          messageMode: gifts.messageMode,
          presetMessageId: gifts.presetMessageId,
          message: gifts.message,
          amount: gifts.amount,
          createdAt: gifts.createdAt,
          claimedAt: gifts.claimedAt,
          isClaimed: gifts.isClaimed,
        })
        .from(gifts)
        .where(eq(gifts.publicId, publicId))
        .limit(1);

      const g = row?.[0];
      if (!g) {
        return res.status(404).json({ error: "Not found", code: "NOT_FOUND", version: VERSION });
      }

      return res.json({
        ok: true,
        gift: {
          publicId: g.publicId,
          senderEmail: g.senderEmail || null,
          messageMode: (g.messageMode as any) || "preset",
          presetMessageId: g.presetMessageId ?? null,
          message: (g.messageMode as any) === "custom" ? g.message || "" : "",
          amount: g.amount ?? null,
          createdAt: g.createdAt,
          claimed: Boolean(g.isClaimed || g.claimedAt),
        },
        version: VERSION,
      });
    } catch (err: any) {
      return res.status(500).json({
        error: "Get gift failed",
        code: "GET_GIFT_FAILED",
        detail: String(err?.message || err),
        version: VERSION,
      });
    }
  });

  /* -------------------- CLAIM -------------------- */
  app.post("/api/gifts/:publicId/claim", async (req, res) => {
    try {
      const publicId = String(req.params.publicId || "").trim();
      if (!publicId) {
        return res.status(400).json({ error: "Missing id", code: "MISSING_ID", version: VERSION });
      }

      const row = await db
        .select({
          id: gifts.id,
          createdAt: gifts.createdAt,
          claimedAt: gifts.claimedAt,
          isClaimed: gifts.isClaimed,
        })
        .from(gifts)
        .where(eq(gifts.publicId, publicId))
        .limit(1);

      const g = row?.[0];
      if (!g) {
        return res.status(404).json({ error: "Not found", code: "NOT_FOUND", version: VERSION });
      }
      if (g.isClaimed || g.claimedAt) {
        return res.status(409).json({ error: "Already claimed", code: "ALREADY_CLAIMED", version: VERSION });
      }

      const createdAtMs = g.createdAt ? new Date(g.createdAt).getTime() : 0;
      const minDelayMs = MIN_CLAIM_DELAY_SEC * 1000;
      if (createdAtMs && Date.now() - createdAtMs < minDelayMs) {
        const waitMs = minDelayMs - (Date.now() - createdAtMs);
        return res.status(429).json({
          error: "Please wait a moment before claiming",
          code: "CLAIM_TOO_SOON",
          retryAfterSec: Math.ceil(waitMs / 1000),
          version: VERSION,
        });
      }

      const updated = await db
        .update(gifts)
        .set({ isClaimed: true, claimedAt: now() })
        .where(and(eq(gifts.id, g.id), eq(gifts.isClaimed, false), isNull(gifts.claimedAt)))
        .returning({ id: gifts.id });

      if (!updated?.length) {
        return res.status(409).json({ error: "Already claimed", code: "ALREADY_CLAIMED", version: VERSION });
      }

      return res.json({ ok: true, claimed: true, version: VERSION });
    } catch (err: any) {
      return res.status(500).json({
        error: "Claim failed",
        code: "CLAIM_FAILED",
        detail: String(err?.message || err),
        version: VERSION,
      });
    }
  });

  /* -------------------- ADMIN: REMINDERS -------------------- */
  app.post("/api/admin/reminders/send", limiterAdmin, async (req, res) => {
    try {
      if (!ADMIN_TOKEN) {
        return res.status(503).json({
          error: "ADMIN_TOKEN not configured",
          code: "ADMIN_NOT_CONFIGURED",
          version: VERSION,
        });
      }
      if (!isAdmin(req)) {
        return res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED", version: VERSION });
      }
      if (!REMINDER_SENDING_ENABLED) {
        return res.json({ ok: true, sent: 0, skipped: 0, disabled: true, version: VERSION });
      }

      const limit = Math.max(1, Math.min(50, Number((req.body || {}).limit ?? 20)));
      const cutoff = new Date(Date.now() - REMINDER_GAP_MS);

      const rows = await db
        .select({
          id: gifts.id,
          publicId: gifts.publicId,
          recipientEmail: gifts.recipientEmail,
          senderEmail: gifts.senderEmail,
          amount: gifts.amount,
          isClaimed: gifts.isClaimed,
          claimedAt: gifts.claimedAt,
          reminderCount: gifts.reminderCount,
          lastReminderSentAt: gifts.lastReminderSentAt,
          returnedToSenderAt: gifts.returnedToSenderAt,
        })
        .from(gifts)
        .where(
          and(
            eq(gifts.isClaimed, false),
            isNull(gifts.claimedAt),
            isNull(gifts.returnedToSenderAt),
            lt(gifts.reminderCount, REMINDER_MAX),
            or(isNull(gifts.lastReminderSentAt), lt(gifts.lastReminderSentAt, cutoff)),
            sql`${gifts.recipientEmail} is not null`
          )
        )
        .orderBy(asc(gifts.lastReminderSentAt), asc(gifts.id))
        .limit(limit);

      let sent = 0;
      let skipped = 0;

      for (const g of rows) {
        const pid = String(g.publicId || "");
        const to = String(g.recipientEmail || "").trim();
        if (!pid || !to) {
          skipped++;
          continue;
        }

        const claimUrl =
          (process.env.PUBLIC_CLAIM_BASE_URL || "https://thankumail.com/claim").replace(/\/+$/, "") + "/" + pid;

        try {
          await sendReminderEmail({
            to,
            publicId: pid,
            claimUrl,
            amountCents: g.amount ?? null,
            senderEmail: g.senderEmail || undefined,
          } as any);

          await db
            .update(gifts)
            .set({
              reminderCount: Number(g.reminderCount || 0) + 1,
              lastReminderSentAt: now(),
            })
            .where(eq(gifts.id, g.id));

          sent++;
        } catch {
          skipped++;
        }
      }

      return res.json({ ok: true, sent, skipped, scanned: rows.length, version: VERSION });
    } catch (err: any) {
      return res.status(500).json({
        error: "Reminders send failed",
        code: "REMINDERS_FAILED",
        detail: String(err?.message || err),
        version: VERSION,
      });
    }
  });

  /* -------------------- ADMIN: RETURN TO SENDER -------------------- */
  app.post("/api/admin/return-to-sender/send", limiterAdmin, async (req, res) => {
    try {
      if (!ADMIN_TOKEN) {
        return res.status(503).json({
          error: "ADMIN_TOKEN not configured",
          code: "ADMIN_NOT_CONFIGURED",
          version: VERSION,
        });
      }
      if (!isAdmin(req)) {
        return res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED", version: VERSION });
      }

      const publicId = String((req.body || {}).publicId || "").trim();
      const reason = String((req.body || {}).reason || "").trim() || undefined;

      if (!publicId) {
        return res.status(400).json({
          error: "publicId required",
          field: "publicId",
          code: "MISSING_PUBLIC_ID",
          version: VERSION,
        });
      }

      const row = await db
        .select({
          id: gifts.id,
          senderEmail: gifts.senderEmail,
          amount: gifts.amount,
          returnedToSenderAt: gifts.returnedToSenderAt,
        })
        .from(gifts)
        .where(eq(gifts.publicId, publicId))
        .limit(1);

      const g = row?.[0];
      if (!g) {
        return res.status(404).json({ error: "Not found", code: "NOT_FOUND", version: VERSION });
      }
      if (g.returnedToSenderAt) {
        return res.status(409).json({ error: "Already sent", code: "ALREADY_SENT", version: VERSION });
      }

      const to = String(g.senderEmail || "").trim();
      if (!to) {
        return res.status(400).json({ error: "Gift has no sender email", code: "NO_SENDER_EMAIL", version: VERSION });
      }

      await sendReturnToSenderEmail({
        to,
        publicId,
        amountCents: g.amount ?? null,
        reason,
      } as any);

      await db.update(gifts).set({ returnedToSenderAt: now() }).where(eq(gifts.id, g.id));

      return res.json({ ok: true, sent: true, version: VERSION });
    } catch (err: any) {
      return res.status(500).json({
        error: "Return-to-sender failed",
        code: "RETURN_TO_SENDER_FAILED",
        detail: String(err?.message || err),
        version: VERSION,
      });
    }
  });

  /* -------------------- FALLBACK 404 -------------------- */
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found", code: "NOT_FOUND", version: VERSION });
  });

  const httpServer = createServer(app);
  return httpServer;
}

/* -------------------- DRIZZLE HELPERS -------------------- */
function gtTime(col: any, d: Date) {
  return sql`${col} > ${d}`;
}
