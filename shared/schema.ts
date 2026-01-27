import { pgTable, text, serial, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

function isE164(s: string) {
  return /^\+[1-9]\d{7,14}$/.test(String(s || "").trim());
}

export const gifts = pgTable("gifts", {
  id: serial("id").primaryKey(),
  publicId: text("public_id").notNull().unique(),

  // OPTIONAL
  senderEmail: text("sender_email"),

  // Delivery targets (at least one required at API layer)
  recipientEmail: text("recipient_email"),
  recipientPhone: text("recipient_phone"),

  message: text("message").notNull().default(""),
  amount: integer("amount").notNull(),

  isClaimed: boolean("is_claimed").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),

  reminderCount: integer("reminder_count").default(0).notNull(),
  lastReminderSentAt: timestamp("last_reminder_sent_at", { withTimezone: true }),

  returnedToSenderAt: timestamp("returned_to_sender_at", { withTimezone: true }),
});

export const insertGiftSchema = createInsertSchema(gifts)
  .omit({
    id: true,
    createdAt: true,
    claimedAt: true,
    isClaimed: true,
    publicId: true,
    reminderCount: true,
    lastReminderSentAt: true,
    returnedToSenderAt: true,
  })
  .extend({
    senderEmail: z.string().email("Enter a valid sender email").optional(),
    recipientEmail: z.string().email("Enter a valid recipient email").optional(),
    recipientPhone: z
      .string()
      .optional()
      .refine((v) => !v || isE164(v), { message: "Phone must be E.164 like +14165551234" }),
    amount: z.coerce.number().min(1000, "Minimum amount is $10").max(100000, "Maximum amount is $1000"),
  })
  .superRefine((val: any, ctx) => {
    const hasEmail = !!String(val?.recipientEmail || "").trim();
    const hasPhone = !!String(val?.recipientPhone || "").trim();
    if (!hasEmail && !hasPhone) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide a recipient email or phone",
        path: ["recipient"],
      });
    }
  });

export type Gift = typeof gifts.$inferSelect;
export type InsertGift = z.infer<typeof insertGiftSchema>;
