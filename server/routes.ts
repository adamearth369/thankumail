import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import { db } from "./db";
import { gifts } from "@shared/schema";
import { sendGiftEmail } from "./email";

async function seed() {
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
  await seed();

  app.post(api.gifts.create.path, async (req, res) => {
    try {
      console.log("Create gift request body:", req.body);
      const { recipientEmail, message, amount } = req.body;

      // Relaxed validation to debug
      if (!recipientEmail || amount === undefined) {
        return res.status(400).json({ error: 'Missing required fields: recipientEmail or amount' });
      }

      if (message && message.length > 3000) {
        return res.status(400).json({ error: 'Message too long (max 3000 characters)' });
      }

      const input = api.gifts.create.input.parse({ 
        recipientEmail, 
        message: (message || "").trim(), 
        amount: Number(amount)
      });
      const gift = await storage.createGift(input);
      
      const protocol = req.headers["x-forwarded-proto"] || "http";
      const host = req.headers["host"];
      const claimLink = `${protocol}://${host}/claim/${gift.publicId}`;
      
      await sendGiftEmail(gift.recipientEmail, claimLink, gift.amount, gift.message);
      
      res.status(201).json({ success: true, giftId: gift.publicId, claimLink: `/claim/${gift.publicId}` });
    } catch (err) {
      console.error(err);
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: err.errors[0].message,
          field: err.errors[0].path.join('.'),
        });
      }
      res.status(500).json({ error: 'Email failed to send' });
    }
  });

  app.post('/test-email', async (req, res) => {
    try {
      const { to, subject, message } = req.body;
      if (!to || !subject || !message) {
        return res.status(400).json({ error: 'Missing to, subject, or message' });
      }

      await sendGiftEmail(to, "http://localhost:5000/claim/test", 0, message);
      res.json({ success: true, message: 'Test email sent' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Test email failed' });
    }
  });

  app.get(api.gifts.get.path, async (req, res) => {
    const gift = await storage.getGift(req.params.publicId);
    if (!gift) {
      return res.status(404).json({ message: 'Gift not found' });
    }
    res.json(gift);
  });

  app.post(api.gifts.claim.path, async (req, res) => {
    try {
      const gift = await storage.getGift(req.params.publicId);
      if (!gift) {
        return res.status(404).send('<h2>Gift not found</h2>');
      }
      if (gift.isClaimed) {
        return res.status(400).send('<h2>This gift has already been claimed 🎁</h2>');
      }
      
      const claimedGift = await storage.claimGift(req.params.publicId);
      
      res.send(`
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
      res.status(500).send('<h2>Internal server error</h2>');
    }
  });

  return httpServer;
}
