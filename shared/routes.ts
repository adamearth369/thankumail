// WHERE TO PASTE: shared/routes.ts
// ACTION: Full file replacement (paste exactly)

export type InsertGift = {
  /**
   * Guest: required (server enforces)
   * Registered: optional (server derives from authed user email)
   */
  senderEmail?: string;

  /**
   * Guest: recipientEmail required (server enforces email-only)
   * Registered: at least one of recipientEmail or recipientPhone required (server enforces)
   */
  recipientEmail?: string;
  recipientPhone?: string;

  messageMode: "preset" | "custom";
  presetMessageId?: number | null;
  message?: string;

  // Amount in cents (optional)
  amount?: number | null;

  // Turnstile enforced server-side when configured
  turnstileToken?: string;
};

export function buildUrl(base: string, path: string) {
  const b = String(base || "").replace(/\/+$/, "");
  const p = String(path || "").replace(/^\/+/, "");
  return `${b}/${p}`;
}

export const api = {
  createGift: "/api/gifts",
  health: "/api/health",
  version: "/api/version",
  stripeConfig: "/api/stripe/config",
  stripeCheckoutSession: "/api/stripe/checkout/session",
};