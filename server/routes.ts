// WHERE TO PASTE: GitHub → thankumail repo → server/routes.ts
// ACTION: COPY/PASTE THIS ENTIRE FILE — REPLACE EVERYTHING

import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import { sendGiftEmail } from "./email";

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  // ✅ PUBLIC CLAIM PAGE (FIXES: Cannot GET /claim/<id>)
  app.get("/claim/:publicId", async (req, res) => {
    try {
      const publicId = String(req.params.publicId || "");
      const gift = await storage.getGift(publicId);

      if (!gift) return res.status(404).send("<h2>Gift not found</h2>");
      if (gift.isClaimed) return res.status(200).send("<h2>This gift has already been claimed 🎁</h2>");

      // Simple one-click claim (GET does the claim)
      const claimedGift = await storage.claimGift(publicId);

      return res.status(200).send(`
        <div style="font-family: sans-serif; text-align: center; padding: 50px;">
          <h1>🎉 Gift Claimed!</h1>
          <p><strong>Amount:</strong> $${(claimedGift.amount / 100).toFixed(2)}</p>
          <p><strong>Message:</strong></p>
          <p style="font-style: italic; color: #666;">"${claimedGift.message}"</p>
          <p>Thank you for using ThanküMail.</p>
          <a href="/" style="display: inline-block; margin-top: 20px; color: #7c3aed; text-decoration: none; font-weight: bold;">Send a gift yourself &rarr;</a>
        </div>
      `);
    } catch (err) {
      console.error(err);
      return res.status(500).send("<h2>Internal server error</h2>");
    }
  });

  // API: CREATE GIFT
  app.post(api.gifts.create.path, async (req, res) => {
    try {
      const { recipientEmail, message, amount } = req.body;

      if (!recipientEmail || amount === undefined) {
        return res.status(400).json({ error: "Missing required fields: recipientEmail or amount" });
      }

      if (message && String(message).length > 3000) {
        return res.status(400).json({ error: "Message too long (max 3000 characters)" });
      }

      const input = api.gifts.create.input.parse({
        recipientEmail,
        message: (message || "").trim(),
        amount: Number(amount),
      });

      const gift = await storage.createGift(input);

      const baseUrl = process.env.BASE_URL;
      const protocol = (req.headers["x-forwarded-proto"] as string) || "http";
      const host = req.headers["host"];

      const claimLink = baseUrl
        ? `${baseUrl.replace(/\/$/, "")}/claim/${gift.publicId}`
        : `${protocol}://${host}/claim/${gift.publicId}`;

      await sendGiftEmail(gift.recipientEmail, claimLink, gift.amount, gift.message);

      return res.status(201).json({
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
      return res.status(500).json({ error: "Email failed to send" });
    }
  });

  // API: GET GIFT
  app.get(api.gifts.get.path, async (req, res) => {
    const gift = await storage.getGift(req.params.publicId);
    if (!gift) return res.status(404).json({ message: "Gift not found" });
    return res.json(gift);
  });

  // API: CLAIM (KEPT FOR PROGRAMMATIC USE)
  app.post(api.gifts.claim.path, async (req, res) => {
    try {
      const gift = await storage.getGift(req.params.publicId);
      if (!gift) return res.status(404).json({ message: "Gift not found" });
      if (gift.isClaimed) return res.status(400).json({ message: "Already claimed" });

      const claimedGift = await storage.claimGift(req.params.publicId);
      return res.json(claimedGift);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: "Internal Server Error" });
    }
  });

  // EMAIL TEST
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

      return res.send(`SENT_OK: ${body}`);
    } catch (e: any) {
      return res.status(500).send(String(e?.message || e));
    }
  });

  return httpServer;
}
