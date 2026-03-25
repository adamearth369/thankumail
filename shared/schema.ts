import { pgTable, pgEnum, text, serial, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

function isE164(s: string) {
  return /^\+[1-9]\d{7,14}$/.test(String(s || "").trim());
}

/* -------------------- ENUMS -------------------- */
export const messageModeEnum = pgEnum("message_mode", ["preset", "custom"]);

/* -------------------- AUTH TABLES -------------------- */
/**
 * NOTE:
 * - We use text IDs so we can generate IDs server-side (crypto hex) without relying on uuid extensions.
 * - Email is stored normalized (lowercased/trimmed) at write time in routes.
 */
export const users = pgTable("users", {
  id: text("id").primaryKey(), // server-generated (hex)
  email: text("email").notNull().unique(),

  /**
   * Provider identity
   * - authProvider: "email" | "google" | "facebook" | "linkedin" | "microsoft"
   * - googleSub/facebookId/linkedinId/microsoftId: provider user ids when available
   */
  authProvider: text("auth_provider").notNull().default("email"),
  googleSub: text("google_sub").unique(),
  facebookId: text("facebook_id").unique(),
  linkedinId: text("linkedin_id").unique(),
  microsoftId: text("microsoft_id").unique(),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
});

export const authMagicLinks = pgTable("auth_magic_links", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(), // normalized email
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),

  ip: text("ip"),
  userAgent: text("user_agent"),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const authSessions = pgTable("auth_sessions", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(), // references users.id (soft ref to avoid migration coupling)
  sessionHash: text("session_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),

  ip: text("ip"),
  userAgent: text("user_agent"),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/* -------------------- TABLES -------------------- */
export const gifts = pgTable("gifts", {
  id: serial("id").primaryKey(),
  publicId: text("public_id").notNull().unique(),

  // FUTURE-PROOF (accounts): nullable until auth exists
  senderUserId: text("sender_user_id"),

  // OPTIONAL (server should set from authed user; guests provide)
  senderEmail: text("sender_email"),
  senderEmailHash: text("sender_email_hash"),

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
  // Amount stored in CENTS when present
  amount: integer("amount"),

  /* -------------------- STRIPE PAYMENT TRACKING -------------------- */
  // null means "no payment required" (message-only)
  // "requires_payment" | "pending" | "paid" | "failed" | "refunded" (server-controlled)
  paymentStatus: text("payment_status"),
  stripeCheckoutSessionId: text("stripe_checkout_session_id"),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  paidAt: timestamp("paid_at", { withTimezone: true }),

  /* -------------------- DELIVERY TRACKING (SERVER-CONTROLLED) -------------------- */
  // Set when delivery has successfully occurred (any channel)
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  // Channel-specific success timestamps
  deliveredEmailAt: timestamp("delivered_email_at", { withTimezone: true }),
  deliveredSmsAt: timestamp("delivered_sms_at", { withTimezone: true }),
  // Last delivery attempt timestamp + last error (if any)
  deliveryAttemptedAt: timestamp("delivery_attempted_at", { withTimezone: true }),
  deliveryError: text("delivery_error"),

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

    // stripe: never accept from client
    paymentStatus: true,
    stripeCheckoutSessionId: true,
    stripePaymentIntentId: true,
    paidAt: true,

    // delivery: never accept from client
    deliveredAt: true,
    deliveredEmailAt: true,
    deliveredSmsAt: true,
    deliveryAttemptedAt: true,
    deliveryError: true,
  })
  .extend({
    /**
     * CHANGE:
     * - Keep optional for DB compatibility.
     * - Server will REQUIRE for guests, and IGNORE/DERIVE for registered users.
     */
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

export type User = typeof users.$inferSelect;
export type AuthMagicLink = typeof authMagicLinks.$inferSelect;
export type AuthSession = typeof authSessions.$inferSelect;

export const stripeWebhookEvents = pgTable("stripe_webhook_events", {
  id: serial("id").primaryKey(),

  stripeEventId: text("stripe_event_id").notNull().unique(),

  stripeType: text("stripe_type").notNull(),

  receivedAt: timestamp("received_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/* -------------------- AUTH EMAIL THROTTLE -------------------- */
export const authEmailThrottle = pgTable("auth_email_throttle", {
  id: serial("id").primaryKey(),

  emailHash: text("email_hash").notNull(),

  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),

  count: integer("count").notNull().default(1),

  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type StripeWebhookEvent = typeof stripeWebhookEvents.$inferSelect;
export type AuthEmailThrottle = typeof authEmailThrottle.$inferSelect;