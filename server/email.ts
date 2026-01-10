import nodemailer from "nodemailer";

type SendGiftEmailArgs = {
  to: string;
  claimLink: string;
  message: string;
  amountCents: number;
};

function requireEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export async function sendGiftEmail(args: SendGiftEmailArgs) {
  const BREVO_SMTP_KEY =
    process.env.BREVO_SMTP_KEY || process.env.BREVO_API_KEY || "";
  if (!BREVO_SMTP_KEY) {
    throw new Error("Missing BREVO_SMTP_KEY (or BREVO_API_KEY fallback)");
  }

  const FROM_EMAIL = process.env.FROM_EMAIL || "noreply@thankumail.com";
  const FROM_NAME = process.env.FROM_NAME || "ThankuMail";

  // Brevo SMTP standard settings
  const transporter = nodemailer.createTransport({
    host: "smtp-relay.brevo.com",
    port: 587,
    secure: false,
    auth: {
      // Brevo SMTP login is typically "apikey"
      user: process.env.BREVO_SMTP_LOGIN || "apikey",
      pass: BREVO_SMTP_KEY,
    },
  });

  const dollars = (args.amountCents / 100).toFixed(2);

  const subject = `You received a ThanküMail gift ($${dollars})`;
  const text = [
    `You received a ThanküMail gift!`,
    ``,
    `Amount: $${dollars}`,
    `Message: ${args.message}`,
    ``,
    `Claim here: ${args.claimLink}`,
  ].join("\n");

  const html = `
    <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; line-height:1.4">
      <h2 style="margin:0 0 12px">You received a ThanküMail gift 🎁</h2>
      <p style="margin:0 0 8px"><b>Amount:</b> $${dollars}</p>
      <p style="margin:0 0 8px"><b>Message:</b></p>
      <p style="margin:0 0 16px; font-style:italic; color:#555">"${escapeHtml(
        args.message,
      )}"</p>
      <p style="margin:0 0 16px">
        <a href="${args.claimLink}" style="display:inline-block; padding:10px 14px; background:#7c3aed; color:#fff; text-decoration:none; border-radius:10px; font-weight:700">
          Claim your gift →
        </a>
      </p>
      <p style="margin:0; color:#777; font-size:13px">If you did not expect this, you can ignore this email.</p>
    </div>
  `;

  const info = await transporter.sendMail({
    from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
    to: args.to,
    subject,
    text,
    html,
  });

  return { messageId: info.messageId };
}

function escapeHtml(input: string) {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
