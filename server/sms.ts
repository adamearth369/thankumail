import twilio from "twilio";

export type SmsSendResult = { ok: boolean; error?: string | null };

export async function sendGiftSms(opts: { to: string; claimUrl: string; publicId: string }) : Promise<SmsSendResult> {
  const provider = (process.env.SMS_PROVIDER || "twilio").toLowerCase();
  if (provider !== "twilio") return { ok: false, error: "SMS provider not configured" };

  const sid = process.env.TWILIO_ACCOUNT_SID || "";
  const token = process.env.TWILIO_AUTH_TOKEN || "";
  const from = process.env.TWILIO_FROM_NUMBER || "";

  if (!sid || !token || !from) return { ok: false, error: "Missing Twilio env vars" };

  try {
    const client = twilio(sid, token);

    const body = `You received a ThankuMail. Open: ${opts.claimUrl}`;

    await client.messages.create({
      from,
      to: opts.to,
      body,
    });

    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || "Twilio send failed" };
  }
}
