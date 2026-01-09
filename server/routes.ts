import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import { db } from "./db";
import { gifts } from "@shared/schema";
import { sendGiftEmail } from "./email";

/* -------------------- SAFE SEED -------------------- */
async function seed() {
  // Skip entirely if db query layer isn't ready
  if (!(db as any)?.query?.gifts?.findFirst) {
    console.log("Seeding skipped: db not ready");
    return;
  }

  const existing = await db.query.gifts.findFirst();
  if (!existing) {
    console.log("Seeding database with example gift...");
    const publicId = "demo-gift";
    await db.insert(gifts).values({
      publicId,
      recipientEmail: "demo@example.com",
      message: "Here's a little thank you for trying out ThanküMail! 🎁",
      amount: 1000, // $10.00
      isClaimed: false,
    });
    console.log(`Seeded! Claim link: /claim/${publicId}`);
  }
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // Never crash deploy if DB/table isn't ready
  try {
    await seed();
  } catch (e) {
    console.error("seed skipped:", e);
  }

  /* -------------------- EMAIL DIAGNOSTIC -------------------- */
  // GET /__email_test?to=email@example.com
  app.get("/__email_test", async (req, res) => {
    try {
      const to = String(req.query.to || "");
      if (!to) return res.status(400).send("Missing ?to=email");

      const apiKey = process.env.BREVO_API_KEY || "";
      if (!apiKey) return res.status(500).send("Missing BREVO_API_KEY");

      const senderEmail = process.env.FROM_EMAIL || "noreply@thankumail.com";
      const senderName = process.env.FROM_NAME || "ThankuMail";

      const r = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "api-key": apiKey,
        },
        body: JSON.stringify({
          sender: { name: senderName, email: senderEmail },
          to: [{ email: to }],
          subject: "ThankuMail API test",
          textContent: "If you received this, Brevo API sending works.",
        }),
      });

      const body = await r.text();
      if (!r.ok) return res.status(500).send(`BREVO_API_ERROR ${r.status}: ${body}`);
      return res.send(`SENT_OK: ${body}`);
    } catch (e) {
      return res.status(500).send(String(e?.message || e));
    }
  });

  /* -------------------- GIFTS API -------------------- */
  app.post(api.gifts.create.path, async (req, res) => {
    try {
      const { recipientEmail, message, amount } = req.body;

      if (!recipientEmail || amount === undefined) {
        return res.status(400).json({
          error: "Missing required fields: recipientEmail or amount",
        });
      }

      if (message && message.length > 3000) {
        return res
          .status(400)
          .json({ error: "Message too long (max 3000 characters)" });
      }

      const input = api.gifts.create.input.parse({
        recipientEmail,
        message: (message || "").trim(),
        amount: Number(amount),
      });

      const gift = await storage.createGift(input);

      const baseUrl = process.env.BASE_URL;
      const claimLink = baseUrl
        ? `${baseUrl.replace(/\/$/, "")}/claim/${gift.publicId}`
        : `${req.headers["x-forwarded-proto"] || "http"}://${req.headers["host"]}/claim/${gift.publicId}`;

      await sendGiftEmail(
        gift.recipientEmail,
        claimLink,
        gift.amount,
        gift.message
      );

      res.status(201).json({
        success: true,
        giftId: gift.publicId,
        claimLink: `/claim/${gift.publicId}`,
      });
    } catch (err) {
      console.error(err);
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: err.errors[0].message,
          field: err.errors[0].path.join("."),
        });
      }
      res.status(500).json({ error: "Email failed to send" });
    }
  });

  app.get(api.gifts.get.path, async (req, res) => {
    const gift = await storage.getGift(req.params.publicId);
    if (!gift) return res.status(404).json({ message: "Gift not found" });
    res.json(gift);
  });

  app.post(api.gifts.claim.path, async (req, res) => {
    try {
      const gift = await storage.getGift(req.params.publicId);
      if (!gift) return res.status(404).send("<h2>Gift not found</h2>");
      if (gift.isClaimed) {
        return res.status(400).send("<h2>This gift has already been claimed 🎁</h2>");
      }

      const claimedGift = await storage.claimGift(req.params.publicId);

      res.send(`
        <div style="font-family: sans-serif; text-align: center; padding: 50px;">
          <h1>🎉 Gift Claimed!</h1>
          <p><strong>Amount:</strong> $${(claimedGift.amount / 100).toFixed(2)}</p>
          <p><strong>Message:</strong></p>
          <p style="font-style: italic; color: #666;">"${claimedGift.message}"</p>
          <p>Thank you for using ThanküMail.</p>
          <a href="/" style="display: inline-block; margin-top: 20px; color: #7c3aed; text-decoration: none; font-weight: bold;">
            Send a gift yourself →
          </a>
        </div>
      `);
    } catch (err) {
      console.error(err);
      res.status(500).send("<h2>Internal server error</h2>");
    }
  });

  return httpServer;
}
