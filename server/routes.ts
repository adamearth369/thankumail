import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import { sendGiftEmail } from "./email";

const MIN_AMOUNT_CENTS = 1000; // $10.00
const MIN_CLAIM_DELAY_MS = 60_000; // 60 seconds

const logEvent = (type: string, data: Record<string, any> = {}) => {
  try {
    console.log(
      JSON.stringify({
        time: new Date().toISOString(),
        type,
        ...data,
      })
    );
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
  const domain = getDomain(email);
  if (!domain) return true;

  const enabled =
    String(process.env.ENABLE_DISPOSABLE_BLOCK || "").toLowerCase() === "true";

  if (!enabled) return false;

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

  if (blocked.has(domain)) return true;
  if (domain.includes("tempmail") || domain.includes("trashmail")) return true;

  return false;
};

const escapeHtml = (s: string) =>
  String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

// ---- TURNSTILE (CLOUDFLARE CAPTCHA) ----
// Enable by setting env: TURNSTILE_SECRET_KEY
// Frontend must send: turnstileToken in POST /api/gifts body
async function verifyTurnstile(token: string, ip?: string) {
  const secret = process.env.TURNSTILE_SECRET_KEY || "";
  if (!secret) return { ok: true, skipped: true as const };

  if (!token) return { ok: false, reason: "missing_token" as const };

  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", token);
  if (ip) form.set("remoteip", ip);

  const r = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }
  );

  const data: any = await r.json().catch(() => ({}));
  const success = Boolean(data?.success);

  return { ok: success, data };
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.get("/claim/:publicId", async (req, res) => {
    const publicId = String(req.params.publicId || "");
    logEvent("claim_page_view", { publicId, ip: req.ip });

    try {
      const gift = await storage.getGift(publicId);

      if (!gift)
        return res.status(404).send(`
          <div style="font-family:sans-serif;text-align:center;padding:50px;">
            <h2>Invalid or expired link.</h2>
            <a href="/" style="display:inline-block;margin-top:16px;color:#7c3aed;text-decoration:none;font-weight:700;">Back to ThankuMail →</a>
          </div>
        `);

      if (gift.isClaimed)
        return res.status(200).send(`
          <div style="font-family:sans-serif;text-align:center;padding:50px;">
            <h2>This gift has already been claimed 🎁</h2>
            <a href="/" style="display:inline-block;margin-top:16px;color:#7c3aed;text-decoration:none;font-weight:700;">Send a gift yourself →</a>
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
              <p style="color:#666;">This helps prevent automated abuse.</p>
              <a href="/claim/${encodeURIComponent(
                publicId
              )}" style="display:inline-block;margin-top:16px;color:#7c3aed;text-decoration:none;font-weight:700;">Refresh →</a>
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
          ${
            msg
              ? `<p><strong>Message:</strong></p><p style="font-style: italic; color: #666;">"${msg}"</p>`
              : ""
          }
          <p>Thank you for using ThanküMail.</p>
          <a href="/" style="display: inline-block; margin-top: 20px; color: #7c3aed; text-decoration: none; font-weight: 700;">Send a gift yourself &rarr;</a>
        </div>
      `);
    } catch (err: any) {
      console.error(err);
      logEvent("claim_error", {
        publicId,
        ip: req.ip,
        error: err?.message || String(err),
      });
      return res.status(500).send(`
        <div style="font-family:sans-serif;text-align:center;padding:50px;">
          <h2>Internal server error</h2>
          <a href="/" style="display:inline-block;margin-top:16px;color:#7c3aed;text-decoration:none;font-weight:700;">Back →</a>
        </div>
      `);
    }
  });

  app.post(api.gifts.create.path, async (req, res) => {
    try {
      const { recipientEmail, message, amount, turnstileToken } = req.body;

      const turnstile = await verifyTurnstile(
        String(turnstileToken || ""),
        req.ip
      );
      if (!turnstile.ok) {
        logEvent("turnstile_failed", { ip: req.ip, reason: turnstile });
        return res.status(400).json({
          message: "Captcha verification failed.",
          field: "turnstileToken",
        });
      }
      if ((turnstile as any).skipped) {
        logEvent("turnstile_skipped", { ip: req.ip });
      } else {
        logEvent("turnstile_ok", { ip: req.ip });
      }

      if (!recipientEmail || amount === undefined) {
        return res
          .status(400)
          .json({ error: "Missing required fields: recipientEmail or amount" });
      }

      const recipientEmailStr = String(recipientEmail).trim().toLowerCase();

      if (isDisposableEmail(recipientEmailStr)) {
        return res.status(400).json({
          message: "Please use a real email address.",
          field: "recipientEmail",
        });
      }

      const amt = Number(amount);

      if (!Number.isFinite(amt) || amt <= 0) {
        return res.status(400).json({
          message: "Invalid amount.",
          field: "amount",
        });
      }

      if (amt < MIN_AMOUNT_CENTS) {
        return res.status(400).json({
          message: "Minimum amount is $10",
          field: "amount",
        });
      }

      if (message && String(message).length > 3000) {
        return res
          .status(400)
          .json({ error: "Message too long (max 3000 characters)" });
      }

      const input = api.gifts.create.input.parse({
        recipientEmail: recipientEmailStr,
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

      try {
        await sendGiftEmail(
          (gift as any).recipientEmail,
          claimLink,
          (gift as any).amount,
          (gift as any).message
        );
        logEvent("email_sent", {
          publicId: (gift as any).publicId,
          recipientEmail: (gift as any).recipientEmail,
        });
      } catch (e: any) {
        console.error(e);
        logEvent("email_failed", {
          publicId: (gift as any).publicId,
          recipientEmail: (gift as any).recipientEmail,
          error: e?.message || String(e),
        });
        return res.status(500).json({ error: "Email failed to send" });
      }

      return res.status(201).json({
        success: true,
        giftId: (gift as any).publicId,
        claimLink: `/claim/${(gift as any).publicId}`,
      });
    } catch (err: any) {
      console.error(err);
      logEvent("gift_create_error", {
        ip: req.ip,
        error: err?.message || String(err),
      });

      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: err.errors[0].message,
          field: err.errors[0].path.join("."),
        });
      }

      return res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.get(api.gifts.get.path, async (req, res) => {
    try {
      const publicId = String(req.params.publicId || "");
      const gift = await storage.getGift(publicId);
      if (!gift) return res.status(404).json({ message: "Gift not found" });
      return res.json(gift);
    } catch (err: any) {
      console.error(err);
      logEvent("gift_get_error", { ip: req.ip, error: err?.message || String(err) });
      return res.status(500).json({ message: "Internal Server Error" });
    }
  });

  app.post(api.gifts.claim.path, async (req, res) => {
    const publicId = String(req.params.publicId || "");
    logEvent("claim_api_attempt", { publicId, ip: req.ip });

    try {
      const gift = await storage.getGift(publicId);
      if (!gift) return res.status(404).json({ message: "Gift not found" });
      if (gift.isClaimed)
        return res.status(409).json({ message: "Already claimed" });

      const createdAt =
        (gift as any).createdAt ||
        (gift as any).created_at ||
        (gift as any).created;

      const createdMs = createdAt ? new Date(createdAt).getTime() : NaN;
      if (!Number.isNaN(createdMs)) {
        const age = Date.now() - createdMs;
        if (age < MIN_CLAIM_DELAY_MS) {
          return res.status(429).json({
            message: "Please wait a moment before claiming.",
            field: "claimDelay",
          });
        }
      }

      const claimedGift = await storage.claimGift(publicId);
      logEvent("claim_api_completed", { publicId, ip: req.ip });
      return res.json(claimedGift);
    } catch (err: any) {
      console.error(err);
      logEvent("claim_api_error", {
        publicId,
        ip: req.ip,
        error: err?.message || String(err),
      });
      return res.status(500).json({ message: "Internal Server Error" });
    }
  });

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

      logEvent("email_test_sent", { to, ip: req.ip });
      return res.send(`SENT_OK: ${body}`);
    } catch (e: any) {
      logEvent("email_test_error", { ip: req.ip, error: e?.message || String(e) });
      return res.status(500).send(String(e?.message || e));
    }
  });

  return httpServer;
}
