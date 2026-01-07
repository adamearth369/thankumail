// NEXT ACTIONABLE ITEM: DAILY SEND LIMITS (PER IP + PER EMAIL)
// WHERE TO PASTE: GitHub → thankumail repo → server/routes.ts
// ACTION: COPY/PASTE THIS ENTIRE FILE — REPLACE EVERYTHING

import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import { sendGiftEmail } from "./email";

const MIN_AMOUNT_CENTS = 1000; // $10.00
const MIN_CLAIM_DELAY_MS = 60_000; // 60 seconds

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
  } catch {}
};

const getDomain = (email: string) => {
  const at = email.lastIndexOf("@");
  if (at === -1) return "";
  return email.slice(at + 1).trim().toLowerCase();
};

const isDisposableEmail = (email: string) => {
  const enabled = String(process.env.ENABLE_DISPOSABLE_BLOCK || "").toLowerCase() === "true";
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
  return blocked.has(domain) || domain.includes("tempmail") || domain.includes("trashmail");
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
  if (!token) return { ok: false };
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
  return { ok: Boolean(data?.success) };
};

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  // PUBLIC CLAIM PAGE
  app.get("/claim/:publicId", async (req, res) => {
    const publicId = String(req.params.publicId || "");
    logEvent("claim_page_view", { publicId, ip: req.ip });
    try {
      const gift = await storage.getGift(publicId);
      if (!gift)
        return res.status(404).send(`<div style="font-family:sans-serif;text-align:center;padding:50px;"><h2>Invalid or expired link.</h2><a href="/" style="color:#7c3aed;font-weight:700;">Back →</a></div>`);
      if (gift.isClaimed)
        return res.status(200).send(`<div style="font-family:sans-serif;text-align:center;padding:50px;"><h2>Already claimed 🎁</h2><a href="/" style="color:#7c3aed;font-weight:700;">Send a gift →</a></div>`);

      const createdAt = (gift as any).createdAt || (gift as any).created_at || (gift as any).created;
      const createdMs = createdAt ? new Date(createdAt).getTime() : NaN;
      if (!Number.isNaN(createdMs)) {
        const age = Date.now() - createdMs;
        if (age < MIN_CLAIM_DELAY_MS) {
          const waitSec = Math.ceil((MIN_CLAIM_DELAY_MS - age) / 1000);
          return res.status(429).send(`<div style="font-family:sans-serif;text-align:center;padding:50px;"><h2>Please wait ${waitSec}s</h2></div>`);
        }
      }

      logEvent("claim_attempt", { publicId, ip: req.ip });
      const claimedGift = await storage.claimGift(publicId);
      logEvent("claim_completed", { publicId, ip: req.ip });

      const msg = escapeHtml((claimedGift as any).message || "");
      const amount = Number((claimedGift as any).amount || 0);

      return res.status(200).send(`
        <div style="font-family:system-ui;text-align:center;padding:50px;">
          <h1>🎉 Gift Claimed!</h1>
          <p><strong>Amount:</strong> $${(amount / 100).toFixed(2)}</p>
          ${msg ? `<p style="color:#666;font-style:italic;">"${msg}"</p>` : ""}
          <a href="/" style="color:#7c3aed;font-weight:700;">Send a gift →</a>
        </div>
      `);
    } catch (e: any) {
      logEvent("claim_error", { publicId, ip: req.ip, error: e?.message || String(e) });
      return res.status(500).send("<h2>Internal server error</h2>");
    }
  });

  // CREATE GIFT (WITH DAILY LIMITS)
  app.post(api.gifts.create.path, async (req, res) => {
    try {
      const { recipientEmail, message, amount, turnstileToken } = req.body;

      const turnstile = await verifyTurnstile(String(turnstileToken || ""), req.ip);
      if (!turnstile.ok)
        return res.status(400).json({ message: "Captcha verification failed.", field: "turnstileToken" });

      const ipKey = String(req.ip || "unknown");
      if (!hitCounter(ipDaily, ipKey, DAILY_MAX_PER_IP).ok) {
        logEvent("daily_ip_limit", { ip: ipKey });
        return res.status(429).json({ message: "Daily send limit reached (IP)." });
      }

      if (!recipientEmail || amount === undefined)
        return res.status(400).json({ error: "Missing required fields" });

      const email = String(recipientEmail).trim().toLowerCase();

      if (!hitCounter(emailDaily, email, DAILY_MAX_PER_EMAIL).ok) {
        logEvent("daily_email_limit", { email });
        return res.status(429).json({ message: "Daily send limit reached (email)." });
      }

      if (isDisposableEmail(email))
        return res.status(400).json({ message: "Please use a real email address.", field: "recipientEmail" });

      const amt = Number(amount);
      if (!Number.isFinite(amt) || amt < MIN_AMOUNT_CENTS)
        return res.status(400).json({ message: "Minimum amount is $10", field: "amount" });

      if (message && String(message).length > 3000)
        return res.status(400).json({ error: "Message too long (max 3000)" });

      const input = api.gifts.create.input.parse({
        recipientEmail: email,
        message: (message || "").trim(),
        amount: amt,
      });

      const gift = await storage.createGift(input);
      logEvent("gift_created", { publicId: (gift as any).publicId, ip: req.ip });

      const baseUrl = process.env.BASE_URL;
      const protocol = (req.headers["x-forwarded-proto"] as string) || "http";
      const host = req.headers["host"];
      const claimLink = baseUrl
        ? `${baseUrl.replace(/\/$/, "")}/claim/${(gift as any).publicId}`
        : `${protocol}://${host}/claim/${(gift as any).publicId}`;

      await sendGiftEmail((gift as any).recipientEmail, claimLink, (gift as any).amount, (gift as any).message);
      logEvent("email_sent", { publicId: (gift as any).publicId });

      return res.status(201).json({
        success: true,
        giftId: (gift as any).publicId,
        claimLink: `/claim/${(gift as any).publicId}`,
      });
    } catch (err: any) {
      if (err instanceof z.ZodError)
        return res.status(400).json({ message: err.errors[0].message, field: err.errors[0].path.join(".") });
      logEvent("gift_create_error", { error: err?.message || String(err) });
      return res.status(500).json({ error: "Internal Server Error" });
    }
  });

  // GET GIFT
  app.get(api.gifts.get.path, async (req, res) => {
    const gift = await storage.getGift(String(req.params.publicId || ""));
    if (!gift) return res.status(404).json({ message: "Gift not found" });
    return res.json(gift);
  });

  // PROGRAMMATIC CLAIM
  app.post(api.gifts.claim.path, async (req, res) => {
    const publicId = String(req.params.publicId || "");
    try {
      const gift = await storage.getGift(publicId);
      if (!gift) return res.status(404).json({ message: "Gift not found" });
      if (gift.isClaimed) return res.status(409).json({ message: "Already claimed" });
      const claimedGift = await storage.claimGift(publicId);
      return res.json(claimedGift);
    } catch {
      return res.status(500).json({ message: "Internal Server Error" });
    }
  });

  // EMAIL TEST
  app.get("/__email_test", async (req, res) => {
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
        sender: { name: process.env.FROM_NAME || "ThankuMail", email: process.env.FROM_EMAIL || "noreply@thankumail.com" },
        to: [{ email: to }],
        subject: "ThankuMail API test",
        textContent: "If you received this, Brevo API sending works.",
      }),
    });
    const body = await r.text();
    if (!r.ok) return res.status(500).send(`BREVO_API_ERROR ${r.status}: ${body}`);
    return res.send(`SENT_OK: ${body}`);
  });

  return httpServer;
}
