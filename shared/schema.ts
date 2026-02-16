// WHERE TO PASTE: shared/schema.ts
// ACTION: Full file replacement (paste exactly)

import { pgTable, pgEnum, text, serial, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

function isE164(s: string) {
  return /^\+[1-9]\d{7,14}$/.test(String(s || "").trim());
}

/* -------------------- ENUMS -------------------- */
export const messageModeEnum = pgEnum("message_mode", ["preset", "custom"]);

/* -------------------- TABLES -------------------- */
export const gifts = pgTable("gifts", {
  id: serial("id").primaryKey(),
  publicId: text("public_id").notNull().unique(),

  // FUTURE-PROOF (accounts): nullable until auth exists
  senderUserId: text("sender_user_id"),

  // OPTIONAL
  senderEmail: text("sender_email"),

  // Delivery targets (at least one required at API layer)
  recipientEmail: text("recipient_email"),
  recipientPhone: text("recipient_phone"),

  /**
   * LEGACY COLUMN (keep to avoid production data-loss during db:push)
   * Do not use in new logic. We will remove in a later controlled migration.
   */
  deliveryMethod: text("delivery_method"),

  // Guest vs registered messaging
  messageMode: messageModeEnum("message_mode").notNull().default("custom"),
  presetMessageId: integer("preset_message_id"),
  message: text("message").notNull().default(""),

  // Gift certificate: nullable to allow message-only Thankümail (guest)
  amount: integer("amount"),

  isClaimed: boolean("is_claimed").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),

  reminderCount: integer("reminder_count").default(0).notNull(),
  lastReminderSentAt: timestamp("last_reminder_sent_at", { withTimezone: true }),

  returnedToSenderAt: timestamp("returned_to_sender_at", { withTimezone: true }),
});

/* -------------------- INSERT SCHEMA -------------------- */
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

    // legacy: never accept from client
    deliveryMethod: true,

    // future-proof: not accepted from guests
    senderUserId: true,
  })
  .extend({
    senderEmail: z.string().email("Enter a valid sender email").optional(),

    recipientEmail: z.string().email("Enter a valid recipient email").optional(),
    recipientPhone: z
      .string()
      .optional()
      .refine((v) => !v || isE164(v), { message: "Phone must be E.164 like +14165551234" }),

    messageMode: z.enum(["preset", "custom"]).default("custom"),
    presetMessageId: z.coerce.number().int().optional(),

    // Allow empty at input time; refined below
    message: z.string().max(280, "Message must be 280 characters or less").optional(),

    // Amount optional for guest/message-only; if present enforce registered min ($25)
    amount: z
      .union([z.coerce.number(), z.undefined(), z.null()])
      .transform((v) => (v === null || v === undefined ? undefined : Number(v)))
      .refine((v) => v === undefined || Number.isFinite(v), { message: "Amount must be a number" })
      .refine((v) => v === undefined || (v >= 2500 && v <= 100000), {
        message: "Amount must be between $25 and $1000",
      })
      .optional(),
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

    const mode = String(val?.messageMode || "custom");
    if (mode === "preset") {
      const pid = Number(val?.presetMessageId);
      // IMPORTANT: presets are 1..7 (matches client preset carousel + API)
      if (!Number.isInteger(pid) || pid < 1 || pid > 7) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Choose a preset message (1–7)",
          path: ["presetMessageId"],
        });
      }
      // preset mode: message can be omitted; server can fill from preset id
    } else {
      const msg = String(val?.message ?? "").trim();
      if (!msg) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Message is required",
          path: ["message"],
        });
      }
      if (msg.length > 280) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Message must be 280 characters or less",
          path: ["message"],
        });
      }
    }
  });

export type Gift = typeof gifts.$inferSelect;
export type InsertGift = z.infer<typeof insertGiftSchema>;
