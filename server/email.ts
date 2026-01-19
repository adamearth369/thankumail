import fetch from "node-fetch";

type SendGiftEmailArgs = {
  to: string;
  publicId: string;
  claimUrl: string;
  amountCents: number;
  senderEmail?: string;
  message?: string;
};

function money(cents: number) {
  const dollars = (cents / 100).toFixed(2);
  return `$${dollars}`;
}

function requireEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function fromEmail() {
  // Use your verified Brevo sender/domain email here if you have it.
  // Fallback is fine as long as Brevo allows it.
  return process.env.MAIL_FROM || process.env.BREVO_FROM || "no-reply@thankumail.com";
}

function fromName() {
  return process.env.MAIL_FROM_NAME || "ThankuMail";
}

export async function sendGiftEmail(args: SendGiftEmailArgs): Promise<{ ok: boolean; error?: string }> {
  try {
    const apiKey = requireEnv("BREVO_API_KEY");

    const subject = `You received a ThankuMail`;
    const html = `
      <div style="font-family: Arial, sans-serif; line-height: 1.5;">
        <h2>You received a ThankuMail</h2>
        <p><b>Amount:</b> ${money(args.amountCents)}</p>
        ${args.senderEmail ? `<p><b>From:</b> ${args.senderEmail}</p>` : ""}
        ${args.message ? `<p style="margin-top: 12px;"><b>Message:</b><br/>${escapeHtml(args.message).replace(/\n/g, "<br/>")}</p>` : ""}
        <p style="margin-top: 18px;">
          <a href="${args.claimUrl}" style="display:inline-block;padding:10px 14px;background:#111;color:#fff;text-decoration:none;border-radius:8px;">
            Claim your ThankuMail
          </a>
        </p>
        <p style="color:#555;font-size:12px;margin-top:16px;">
          If the button doesn’t work, copy/paste this link: ${args.claimUrl}
        </p>
      </div>
    `;

    const payload = {
      sender: { email: fromEmail(), name: fromName() },
      to: [{ email: args.to }],
      subject,
      htmlContent: html,
      headers: {
        "X-ThankuMail-PublicId": args.publicId,
      },
    };

    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `Brevo API error (${res.status}): ${text || res.statusText}` };
    }

    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || "Unknown error" };
  }
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
