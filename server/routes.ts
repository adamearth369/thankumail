import type { Express } from "express";
import type { Server } from "http";
import crypto from "crypto";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import { sendGiftEmail } from "./email";

const MIN_AMOUNT_CENTS = 1000; // $10.00
const MIN_CLAIM_DELAY_MS = 60_000; // 60 seconds

// ---- OPTIONAL SERVER-AUTHORITATIVE PRICING (DEFAULT OFF) ----
const ENFORCE_PRICE_TIERS =
  String(process.env.ENFORCE_PRICE_TIERS || "").toLowerCase() === "true";

// Edit tiers anytime; defaults are safe/common
const PRICE_TIERS_CENTS = [1000, 2000, 5000, 10000, 20000, 50000];

// ---- DAILY LIMITS (SAFE IN-MEMORY, AUTO-RESET) ----
const DAILY_MAX_PER_IP = 20;
const DAILY_MAX_PER_EMAIL = 10;

type Counter = { count: number; resetAt: number };
const ipDaily = new Map<string, Counter>();
const emailDaily = new Map<string, Counter>();

const startOfNextDay = () => {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
};

const hitCounter = (map: Map<string, Counter>, key: string, max: number) => {
  const now = Date.now();
  const cur = map.get(key);
  if (!cur || cur.resetAt <= now) {
    map.set(key, { count: 1, resetAt: startOfNextDay() });
    return { ok: true };
  }
  cur.count += 1;
  if (cur.count > max) return { ok: false };
  return { ok: true };
};

// ---- LOGGING ----
const logEvent = (type: string, data: Record<string, any> = {}) => {
  try {
    console.log(JSON.stringify({ time: new Date().toISOString(), type, ...data }));
  } catch {
    // never throw from logging
  }
};

const getDomain = (email: string) => {
  const at = email.lastIndexOf("@");
  if (at === -1) return "";
  return email.slice(at + 1).trim().toLowerCase();
};

const isDisposableEmail = (email: string) => {
  const enabled =
    String(process.env.ENABLE_DISPOSABLE_BLOCK || "").toLowerCase() === "true";
  if (!enabled) return false;

  const domain = getDomain(email);
  if (!domain) return true;

  const blocked = new Set([
    "mailinator.com",
    "guerrillamail.com",
    "guerrillamail.net",
    "guerrillamail.org",
    "tempmail.com",
    "temp-mail.org",
    "10minutemail.com",
    "10minutemail.net",
    "yopmail.com",
    "yopmail.fr",
    "yopmail.net",
  ]);

  return (
    blocked.has(domain) ||
    domain.includes("tempmail") ||
    domain.includes("trashmail")
  );
};

const escapeHtml = (s: string) =>
  String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

// ---- TURNSTILE ----
async function verifyTurnstile(token: string, ip?: string) {
  const secret = process.env.TURNSTILE_SECRET_KEY || "";
  if (!secret) return { ok: true, skipped: true as const };
  if (!token) return { ok: false, reason: "missing_token" as const };

  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", token);
  if (ip) form.set("remoteip", ip);

  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  const data: any = await r.json().catch(() => ({}));
  return { ok: Boolean(data?.success), data };
}

// ---- STRIPE WEBHOOK VERIFICATION (SAFE: INACTIVE UNLESS SECRET SET) ----
function verifyStripeSignature(rawBody: Buffer, signatureHeader: string, secret: string) {
  // Stripe-Signature: t=timestamp,v1=signature[,v1=...]
  const parts = signatureHeader.split(",").map((p) => p.trim());
  const t = parts.find((p) => p.startsWith("t="))?.slice(2);
  const v1s = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));

  if (!t || v1s.length === 0) return false;

  const payload = `${t}.${rawBody.toString("utf8")}`;
  const expected = crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex");

  for (const v1 of v1s) {
    try {
      const a = Buffer.from(v1, "hex");
      const b = Buffer.from(expected, "hex");
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  // ---- STRIPE WEBHOOK (OPTIONAL) ----
  // WHERE TO CALL: Stripe Dashboard → Developers → Webhooks → add endpoint:
  //   https://thankumail.com/api/webhooks/stripe
  app.post("/api/webhooks/stripe", async (req: any, res) => {
    try {
      const secret = process.env.STRIPE_WEBHOOK_SECRET || "";

      // If not configured, accept but log (non-breaking)
      if (!secret) {
        logEvent("stripe_webhook_skipped_no_secret", { ip: req.ip });
        return res.status(200).send("ok");
      }

      const sig = String(req.headers["stripe-signature"] || "");
      const rawBody: Buffer | undefined = req.rawBody;

      if (!sig || !rawBody) {
        logEvent("stripe_webhook_missing_sig_or_raw", { ip: req.ip });
        return res.status(400).send("bad_request");
      }

      const ok = verifyStripeSignature(rawBody, sig, secret);
      if (!ok) {
        logEvent("stripe_webhook_invalid_signature", { ip: req.ip });
        return res.status(400).send("invalid_signature");
      }

      const event = req.body;
      logEvent("stripe_webhook_received", { type: event?.type, id: event?.id });

      // TODO (later): map event to gift/payment state in storage
      return res.status(200).send("ok");
    } catch (e: any) {
      logEvent("stripe_webhook_error", { error: e?.message || String(e) });
      return res.status(500).send("error");
    }
  });

  // ---- PUBLIC CLAIM PAGE ----
  app.get("/claim/:publicId", async (req, res) => {
    const publicId = String(req.params.publicId || "");
    logEvent("claim_page_view", { publicId, ip: req.ip });

    try {
      const gift = await storage.getGift(publicId);

      if (!gift)
        return res.status(404).send(`
          <div style="font-family:sans-serif;text-align:center;padding:50px;">
            <h2>Invalid or expired link.</h2>
            <a href="/" style="display:inline-block;margin-top:16px;color:#7c3aed;text-decoration:none;font-weight:700;">Back →</a>
          </div>
        `);

      if (gift.isClaimed)
        return res.status(200).send(`
          <div style="font-family:sans-serif;text-align:center;padding:50px;">
            <h2>This gift has already been claimed 🎁</h2>
            <a href="/" style="display:inline-block;margin-top:16px;color:#7c3aed;text-decoration:none;font-weight:700;">Send a gift →</a>
          </div>
        `);

      const createdAt =
        (gift as any).createdAt ||
        (gift as any).created_at ||
        (gift as any).created;

      const createdMs = createdAt ? new Date(createdAt).getTime() : NaN;
      if (!Number.isNaN(createdMs)) {
        const age = Date.now() - createdMs;
        if (age < MIN_CLAIM_DELAY_MS) {
          const waitSec = Math.ceil((MIN_CLAIM_DELAY_MS - age) / 1000);
          return res.status(429).send(`
            <div style="font-family:sans-serif;text-align:center;padding:50px;">
              <h2>Please wait ${waitSec}s, then refresh.</h2>
              <a href="/claim/${encodeURIComponent(publicId)}" style="display:inline-block;margin-top:16px;color:#7c3aed;text-decoration:none;font-weight:700;">Refresh →</a>
            </div>
          `);
        }
      }

      logEvent("claim_attempt", { publicId, ip: req.ip });
      const claimedGift = await storage.claimGift(publicId);
      logEvent("claim_completed", { publicId, ip: req.ip });

      const msg = escapeHtml((claimedGift as any).message || "");
      const amount = Number((claimedGift as any).amount || 0);

      return res.status(200).send(`
        <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; text-align: center; padding: 50px;">
          <h1>🎉 Gift Claimed!</h1>
          <p><strong>Amount:</strong> $${(amount / 100).toFixed(2)}</p>
          ${msg ? `<p><strong>Message:</strong></p><p style="font-style: italic; color: #666;">"${msg}"</p>` : ""}
          <a href="/" style="display:inline-block;margin-top:20px;color:#7c3aed;text-decoration:none;font-weight:700;">Send a gift →</a>
        </div>
      `);
    } catch (err: any) {
      logEvent("claim_error", { publicId, ip: req.ip, error: err?.message || String(err) });
      return res.status(500).send(`
        <div style="font-family:sans-serif;text-align:center;padding:50px;">
          <h2>Internal server error</h2>
          <a href="/" style="display:inline-block;margin-top:16px;color:#7c3aed;text-decoration:none;font-weight:700;">Back →</a>
        </div>
      `);
    }
  });

  // ---- CREATE GIFT ----
  app.post(api.gifts.create.path, async (req
