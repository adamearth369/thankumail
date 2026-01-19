type SendGiftEmailArgs = {
  to: string;
  publicId: string;
  claimUrl: string;
  amountCents: number;
  senderEmail?: string;
  message?: string;
};

type SendReminderEmailArgs = {
  to: string;
  publicId: string;
  claimUrl: string;
  amountCents: number;
  senderEmail?: string;
};

type SendReturnToSenderEmailArgs = {
  to: string; // sender email
  publicId: string;
  amountCents: number;
  reason?: string;
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
  return process.env.MAIL_FROM || process.env.BREVO_FROM || "no-reply@thankumail.com";
}

function fromName() {
  return process.env.MAIL_FROM_NAME || "ThankuMail";
}

async function sendBrevoEmail(params: {
  to: string;
  subject: string;
  htmlContent: string;
  headers?: Record<string, string>;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const apiKey = requireEnv("BREVO_API_KEY");

    const payload = {
      sender: { email: fromEmail(), name: fromName() },
      to: [{ email: params.to }],
      subject: params.subject,
      htmlContent: params.htmlContent,
      headers: params.headers || {},
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

export async function sendGiftEmail(args: SendGiftEmailArgs): Promise<{ ok: boolean; error?: string }> {
  const subject = `You received a ThankuMail`;
  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5;">
      <h2>You received a ThankuMail</h2>
      <p><b>Amount:</b> ${money(args.amountCents)}</p>
      ${args.senderEmail ? `<p><b>From:</b> ${escapeHtml(args.senderEmail)}</p>` : ""}
      ${
        args.message
          ? `<p style="margin-top: 12px;"><b>Message:</b><br/>${escapeHtml(args.message).replace(/\n/g, "<br/>")}</p>`
          : ""
      }
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

  return sendBrevoEmail({
    to: args.to,
    subject,
    htmlContent: html,
    headers: { "X-ThankuMail-PublicId": args.publicId, "X-ThankuMail-Kind": "gift" },
  });
}

export async function sendReminderEmail(args: SendReminderEmailArgs): Promise<{ ok: boolean; error?: string }> {
  const subject = `Reminder: your ThankuMail is waiting`;
  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5;">
      <h2>Your ThankuMail is still waiting</h2>
      <p><b>Amount:</b> ${money(args.amountCents)}</p>
      ${args.senderEmail ? `<p><b>From:</b> ${escapeHtml(args.senderEmail)}</p>` : ""}
      <p style="margin-top: 18px;">
        <a href="${args.claimUrl}" style="display:inline-block;padding:10px 14px;background:#111;color:#fff;text-decoration:none;border-radius:8px;">
          Claim now
        </a>
      </p>
      <p style="color:#555;font-size:12px;margin-top:16px;">
        If the button doesn’t work, copy/paste this link: ${args.claimUrl}
      </p>
    </div>
  `;

  return sendBrevoEmail({
    to: args.to,
    subject,
    htmlContent: html,
    headers: { "X-ThankuMail-PublicId": args.publicId, "X-ThankuMail-Kind": "reminder" },
  });
}

export async function sendReturnToSenderEmail(
  args: SendReturnToSenderEmailArgs
): Promise<{ ok: boolean; error?: string }> {
  const subject = `Your ThankuMail couldn’t be delivered`;
  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5;">
      <h2>Your ThankuMail couldn’t be delivered</h2>
      <p><b>Amount:</b> ${money(args.amountCents)}</p>
      <p><b>Public ID:</b> ${escapeHtml(args.publicId)}</p>
      ${args.reason ? `<p><b>Reason:</b> ${escapeHtml(args.reason)}</p>` : ""}
      <p style="color:#555;font-size:12px;margin-top:16px;">
        If you believe this is a mistake, try sending again or contact support.
      </p>
    </div>
  `;

  return sendBrevoEmail({
    to: args.to,
    subject,
    htmlContent: html,
    headers: { "X-ThankuMail-PublicId": args.publicId, "X-ThankuMail-Kind": "return_to_sender" },
  });
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
