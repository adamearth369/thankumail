// WHERE TO PASTE: server/sms.ts
// ACTION: Full file replacement (paste exactly)

import twilio from "twilio";

export type SmsSendResult = { ok: boolean; error?: string | null };

function safeStr(v: any) {
  return typeof v === "string" ? v : "";
}

function normalizeE164(s: string) {
  return safeStr(s).trim();
}

function isE164(s: string) {
  return /^\+[1-9]\d{7,14}$/.test(safeStr(s).trim());
}

export async function sendGiftSms(opts: {
  to: string;
  claimUrl: string;
  publicId: string;
  senderEmail?: string;
  message?: string;
}): Promise<SmsSendResult> {
  const provider = (process.env.SMS_PROVIDER || "twilio").toLowerCase();
  if (provider !== "twilio") return { ok: false, error: "SMS provider not configured" };

  const sid = process.env.TWILIO_ACCOUNT_SID || "";
  const token = process.env.TWILIO_AUTH_TOKEN || "";
  const from = process.env.TWILIO_FROM_NUMBER || "";

  if (!sid || !token || !from) return { ok: false, error: "Missing Twilio env vars" };

  const to = normalizeE164(opts.to);
  if (!isE164(to)) return { ok: false, error: "Invalid phone (must be E.164 like +14165551234)" };

  try {
    const client = twilio(sid, token);

    // ---- COMPLIANCE-SAFE, HUMAN COPY ----
    // Principles:
    // - Context first (why they got this)
    // - No promotional language
    // - Clear action
    // - STOP / HELP included
    // - Avoid spammy words (“free”, “urgent”, emojis, etc.)

    const shortMessage =
      "You were sent a thankÜmail gift.";

    const body = [
      shortMessage,
      "Open securely:",
      opts.claimUrl,
      "No signup required.",
      "Reply STOP to opt out. HELP for help.",
    ].join(" ");

    await client.messages.create({
      from,
      to,
      body,
    });

    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || "Twilio send failed" };
  }
}
