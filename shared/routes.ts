// WHERE TO PASTE: shared/routes.ts
// ACTION: Full file replacement (paste exactly)

export type InsertGift = {
  senderEmail: string;
  recipientEmail: string;
  messageMode: "preset" | "custom";
  presetMessageId?: number | null;
  message?: string;
  amount?: number | null;
  turnstileToken: string;
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
};

