import { pgTable, text, serial, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const gifts = pgTable("gifts", {
  id: serial("id").primaryKey(),
  publicId: text("public_id").notNull().unique(),
  recipientEmail: text("recipient_email").notNull(),
  message: text("message").notNull(),
  amount: integer("amount").notNull(),
  isClaimed: boolean("is_claimed").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  claimedAt: timestamp("claimed_at"),
});

export const insertGiftSchema = createInsertSchema(gifts).extend({
  amount: z.coerce.number().min(1000, "Minimum amount is $10").max(100000, "Maximum amount is $1000"),
}).omit({
  id: true,
  createdAt: true,
  claimedAt: true,
  isClaimed: true,
  publicId: true,
});

export type Gift = typeof gifts.$inferSelect;
export type InsertGift = z.infer<typeof insertGiftSchema>;
