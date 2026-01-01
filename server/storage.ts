import { db } from "./db";
import { gifts, type InsertGift, type Gift } from "@shared/schema";
import { eq } from "drizzle-orm";
import crypto from "crypto";

export interface IStorage {
  createGift(gift: InsertGift): Promise<Gift>;
  getGift(publicId: string): Promise<Gift | undefined>;
  claimGift(publicId: string): Promise<Gift>;
}

export class DatabaseStorage implements IStorage {
  async createGift(insertGift: InsertGift): Promise<Gift> {
    const publicId = crypto.randomBytes(6).toString('hex');
    const [gift] = await db
      .insert(gifts)
      .values({ ...insertGift, publicId })
      .returning();
    return gift;
  }

  async getGift(publicId: string): Promise<Gift | undefined> {
    const [gift] = await db
      .select()
      .from(gifts)
      .where(eq(gifts.publicId, publicId));
    return gift;
  }

  async claimGift(publicId: string): Promise<Gift> {
    const [gift] = await db
      .update(gifts)
      .set({ isClaimed: true, claimedAt: new Date() })
      .where(eq(gifts.publicId, publicId))
      .returning();
    return gift;
  }
}

export const storage = new DatabaseStorage();
