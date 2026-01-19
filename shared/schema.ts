import { pgTable, text, serial, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const gifts = pgTable("gifts", {
  id: serial("id").primaryKey(),
  publicId: text("public_id").notNull().unique(),

  // OPTIONAL for now (older gifts may not have it)
  senderEmail: text("sender_email"),

  recipientEmail: text("recipient_email").notNull(),
  message: text("message").notNull().default(""),
  amount: integer("amount").notNull(),

  isClaimed: boolean("is_claimed").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),

  // Reminder tracking (matches DB)
  reminderCount: integer("reminder_count").default(0).notNull(),
  lastReminderSentAt: timestamp("last_reminder_sent_at", { withTimezone: true }),

  // Return-to-sender marker (matches DB)
  returnedToSenderAt: timestamp("returned_to_sender_at", { withTimezone: true }),
});

export const insertGiftSchema = createInsertSchema(gifts)
  .extend({
    senderEmail: z.string().email("Enter a valid sender email").optional(),
    recipientEmail: z.string().email("Enter a valid recipient email"),
    amount: z.coerce.number().min(1000, "Minimum amount is $10").max(100000, "Maximum amount is $1000"),
  })
  .omit({
    id: true,
    createdAt: true,
    claimedAt: true,
    isClaimed: true,
    publicId: true,
    reminderCount: true,
    lastReminderSentAt: true,
    returnedToSenderAt: true,
  });

export type Gift = typeof gifts.$inferSelect;
export type InsertGift = z.infer<typeof insertGiftSchema>;
