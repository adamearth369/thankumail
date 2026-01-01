import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import { db } from "./db";
import { gifts } from "@shared/schema";

async function seed() {
  const existing = await db.query.gifts.findFirst();
  if (!existing) {
    console.log("Seeding database with example gift...");
    const publicId = "demo-gift";
    await db.insert(gifts).values({
      publicId,
      recipientEmail: "demo@example.com",
      message: "Here's a little thank you for trying out ThankuMail! 🎁",
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
      const input = api.gifts.create.input.parse(req.body);
      const gift = await storage.createGift(input);
      res.status(201).json(gift);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: err.errors[0].message,
          field: err.errors[0].path.join('.'),
        });
      }
      throw err;
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
    const gift = await storage.getGift(req.params.publicId);
    if (!gift) {
      return res.status(404).json({ message: 'Gift not found' });
    }
    if (gift.isClaimed) {
      return res.status(400).json({ message: 'Gift already claimed' });
    }
    
    const claimedGift = await storage.claimGift(req.params.publicId);
    res.json(claimedGift);
  });

  return httpServer;
}
