// server/routes.ts

import type { Express } from "express";
import type { Server } from "http";
import crypto from "crypto";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import { sendGiftEmail } from "./email";

const MIN_AMOUNT_CENTS = 1000; // $10.00
const MIN_CLAIM_DELAY_MS = 60_000; // 60 seconds

// Optional server-authoritative pricing tiers
const ENFORCE_PRICE_TIERS =
  String(process.env.ENFORCE_PRICE_TIERS || "").toLowerCase() === "true";
const PRICE_TIERS_CENTS = [1000, 2000, 5000, 10000, 20000, 50000];

// Daily limits (in-memory)
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

const logEvent = (type: string, data: Record<string, any> = {}) => {
  try {
    console.log(JSON.stringify({ time: new Date().toISOString(), type, ...data }));
  } catch {}
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

// ---- Turnstile ----
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

// ---- Stripe webhook signature verification ----
function verifyStripeSignature(rawBody: Buffer, signatureHeader: string, secret: string) {
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
    } catch {}
  }
  return false;
}

// ---- Stripe PaymentIntent creation (no SDK required) ----
async function stripeCreatePaymentIntent(params: {
  amount: number;
  currency: string;
  metadata?: Record<string, string>;
  receipt_email?: string;
  idempotencyKey?: string;
}) {
  const key = process.env.STRIPE_SECRET_KEY || "";
  if (!key) throw new Error("Missing STRIPE_SECRET_KEY");

  const body = new URLSearchParams();
  body.set("amount", String(params.amount));
  body.set("currency", params.currency);
  body.set("automatic_payment_methods[enabled]", "true");

  if (params.receipt_email) body.set("receipt_email", params.receipt_email);

  if (params.metadata) {
    for (const [k, v] of Object.entries(params.metadata)) {
      body.set(`metadata[${k}]`, v);
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };

  if (params.idempotencyKey) headers["Idempotency-Key"] = params.idempotencyKey;

  const r = await fetch("https://api.stripe.com/v1/payment_intents", {
    method: "POST",
    headers,
    body: body.toString(),
  });

  const json: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = json?.error?.message || `Stripe error ${r.status}`;
    throw new Error(msg);
  }

  return json as { id: string; client_secret: string };
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  // ---- Stripe webhook endpoint ----
  app.post("/api/webhooks/stripe", async (req: any, res) => {
    try {
      const secret = process.env.STRIPE_WEBHOOK_SECRET || "";
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
      const type = String(event?.type || "");
      const id = String(event?.id || "");
      logEvent("stripe_webhook_received", { type, id });

      // MVP: log-only (non-breaking). Later you will map this to gift activation.
      if (type === "payment_intent.succeeded") {
        const pi = event?.data?.object;
        logEvent("payment_intent_succeeded", {
          payment_intent_id: pi?.id,
          amount: pi?.amount,
          currency: pi?.currency,
          metadata: pi?.metadata || {},
        });
      }

      if (type === "payment_intent.payment_failed") {
        const pi = event?.data?.object;
        logEvent("payment_intent_failed", {
          payment_intent_id: pi?.id,
          amount: pi?.amount,
          currency: pi?.currency,
          metadata: pi?.metadata || {},
        });
      }

      return res.status(200).send("ok");
    } catch (e: any) {
      logEvent("stripe_webhook_error", { error: e?.message || String(e) });
      return res.status(500).send("error");
    }
  });

  // ---- Create PaymentIntent (server-authoritative) ----
  // Client calls this first to get clientSecret, then confirms payment on frontend.
  app.post("/api/payments/create-intent", async (req: any, res) => {
    try {
      const { amount, recipientEmail, giftPublicId } = req.body || {};

      const amt = Number(amount);
      if (!Number.isFinite(amt) || !Number.isInteger(amt) || amt <= 0) {
        return res.status(400).json({ message: "Invalid amount.", field: "amount" });
      }
      if (amt < MIN_AMOUNT_CENTS) {
        return res.status(400).json({ message: "Minimum amount is $10", field: "amount" });
      }
      if (ENFORCE_PRICE_TIERS && !PRICE_TIERS_CENTS.includes(amt)) {
        return res.status(400).json({ message: "Invalid amount selection.", field: "amount" });
      }

      const email = recipientEmail ? String(recipientEmail).trim().toLowerCase() : "";
      if (email && isDisposableEmail(email)) {
        return res.status(400).json({ message: "Please use a real email address.", field: "recipientEmail" });
      }

      const idempotencyKey =
        String(req.headers["x-idempotency-key"] || "") ||
        crypto.randomUUID();

      const pi = await stripeCreatePaymentIntent({
        amount: amt,
        currency: "usd",
        receipt_email: email || undefined,
        metadata: {
          app: "thankumail",
          giftPublicId: giftPublicId ? String(giftPublicId) : "",
        },
        idempotencyKey,
      });

      logEvent("payment_intent_created", {
        payment_intent_id: pi.id,
        amount: amt,
        ip: req.ip,
      });

      return res.json({ paymentIntentId: pi.id, clientSecret: pi.client_secret });
    } catch (e: any) {
      logEvent("payment_intent_create_error", { error: e?.message || String(e) });
      return res.status(500).json({ message: "Payment setup failed." });
    }
  });

  // ---- Public claim page ----
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

  // ---- Create gift ----
  app.post(api.gifts.create.path, async (req: any, res) => {
    try {
      const { recipientEmail, message, amount, turnstileToken } = req.body;

      const turnstile = await verifyTurnstile(String(turnstileToken || ""), req.ip);
      if (!turnstile.ok) {
        return res.status(400).json({ message: "Captcha verification failed.", field: "turnstileToken" });
      }

      const ipKey = String(req.ip || "unknown");
      if (!hitCounter(ipDaily, ipKey, DAILY_MAX_PER_IP).ok) {
        return res.status(429).json({ message: "Daily send limit reached (IP)." });
      }

      if (!recipientEmail || amount === undefined) {
        return res.status(400).json({ error: "Missing required fields: recipientEmail or amount" });
      }

      const email = String(recipientEmail).trim().toLowerCase();
      if (!hitCounter(emailDaily, email, DAILY_MAX_PER_EMAIL).ok) {
        return res.status(429).json({ message: "Daily send limit reached (email)." });
      }

      if (isDisposableEmail(email)) {
        return res.status(400).json({ message: "Please use a real email address.", field: "recipientEmail" });
      }

      const amt = Number(amount);
      if (!Number.isFinite(amt) || !Number.isInteger(amt) || amt <= 0) {
        return res.status(400).json({ message: "Invalid amount.", field: "amount" });
      }

      if (amt < MIN_AMOUNT_CENTS) {
        return res.status(400).json({ message: "Minimum amount is $10", field: "amount" });
      }

      if (ENFORCE_PRICE_TIERS && !PRICE_TIERS_CENTS.includes(amt)) {
        return res.status(400).json({ message: "Invalid amount selection.", field: "amount" });
      }

      if (message && String(message).length > 3000) {
        return res.status(400).json({ error: "Message too long (max 3000 characters)" });
      }

      const input = api.gifts.create.input.parse({
        recipientEmail: email,
        message: (message || "").trim(),
        amount: amt,
      });

      const gift = await storage.createGift(input);

      logEvent("gift_created", {
        publicId: (gift as any).publicId,
        amount: (gift as any).amount,
        recipientEmail: (gift as any).recipientEmail,
        ip: req.ip,
      });

      const baseUrl = process.env.BASE_URL;
      const protocol = (req.headers["x-forwarded-proto"] as string) || "http";
      const host = req.headers["host"];

      const claimLink = baseUrl
        ? `${baseUrl.replace(/\/$/, "")}/claim/${(gift as any).publicId}`
        : `${protocol}://${host}/claim/${(gift as any).publicId}`;

      await sendGiftEmail((gift as any).recipientEmail, claimLink, (gift as any).amount, (gift as any).message);

      logEvent("email_sent", { publicId: (gift as any).publicId, recipientEmail: (gift as any).recipientEmail });

      returnorial: any = undefined;

      return res.status(201).json({
        success: true,
        giftId: (gift as any).publicId,
        claimLink: `/claim/${(gift as any).publicId}`,
      });
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ message: err.errors[0].message, field: err.errors[0].path.join(".") });
      }
      logEvent("gift_create_error", { error: err?.message || String(err) });
      return res.status(500).json({ error: "Internal Server Error" });
    }
  });

  // ---- Get gift ----
  app.get(api.gifts.get.path, async (req, res) => {
    try {
      const publicId = String(req.params.publicId || "");
      const gift = await storage.getGift(publicId);
      if (!gift) return res.status(404).json({ message: "Gift not found" });
      return res.json(gift);
    } catch (err: any) {
      logEvent("gift_get_error", { error: err?.message || String(err) });
      return res.status(500).json({ message: "Internal Server Error" });
    }
  });

  // ---- Programmatic claim ----
  app.post(api.gifts.claim.path, async (req, res) => {
    const publicId = String(req.params.publicId || "");
    logEvent("claim_api_attempt", { publicId, ip: (req as any).ip });

    try {
      const gift = await storage.getGift(publicId);
      if (!gift) return res.status(404).json({ message: "Gift not found" });
      if (gift.isClaimed) return res.status(409).json({ message: "Already claimed" });

      const createdAt =
        (gift as any).createdAt ||
        (gift as any).created_at ||
        (gift as any).created;

      const createdMs = createdAt ? new Date(createdAt).getTime() : NaN;
      if (!Number.isNaN(createdMs)) {
        const age = Date.now() - createdMs;
        if (age < MIN_CLAIM_DELAY_MS) {
          return res.status(429).json({ message: "Please wait a moment before claiming.", field: "claimDelay" });
        }
      }

      const claimedGift = await storage.claimGift(publicId);
      logEvent("claim_api_completed", { publicId, ip: (req as any).ip });
      return res.json(claimedGift);
    } catch (err: any) {
      logEvent("claim_api_error", { publicId, error: err?.message || String(err) });
      return res.status(500).json({ message: "Internal Server Error" });
    }
  });

  // ---- Email test ----
  app.get("/__email_test", async (req, res) => {
    try {
      const to = String(req.query.to || "");
      if (!to) return res.status(400).send("Missing ?to=email");

      const r = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "api-key": process.env.BREVO_API_KEY || "",
        },
        body: JSON.stringify({
          sender: {
            name: process.env.FROM_NAME || "ThankuMail",
            email: process.env.FROM_EMAIL || "noreply@thankumail.com",
          },
          to: [{ email: to }],
          subject: "ThankuMail API test",
          textContent: "If you received this, Brevo API sending works.",
        }),
      });

      const body = await r.text();
      if (!r.ok) return res.status(500).send(`BREVO_API_ERROR ${r.status}: ${body}`);

      logEvent("email_test_sent", { to, ip: (req as any).ip });
      return res.send(`SENT_OK: ${body}`);
    } catch (e: any) {
      logEvent("email_test_error", { error: e?.message || String(e) });
      return res.status(500).send(String(e?.message || e));
    }
  });

  return httpServer;
}
