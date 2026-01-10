import nodemailer from "nodemailer";

type SendGiftEmailArgs = {
  to: string;
  claimLink: string; // can be relative (/claim/abc) or absolute (https://...)
  message: string;
  amountCents: number;
};

function getEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim().length ? v : undefined;
}

function requireEnv(name: string): string {
  const v = getEnv(name);
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function isAbsoluteUrl(s: string) {
  return /^https?:\/\//i.test(s);
}

function toAbsoluteClaimLink(claimLink: string) {
  const base =
    getEnv("APP_BASE_URL") ||
    getEnv("PUBLIC_APP_URL") ||
    getEnv("RENDER_EXTERNAL_URL") ||
    "https://thankumail.onrender.com";

  if (isAbsoluteUrl(claimLink)) return claimLink;

  const cleanBase = base.replace(/\/+$/, "");
  const cleanPath = claimLink.startsWith("/") ? claimLink : `/${claimLink}`;
  return `${cleanBase}${cleanPath}`;
}

function escapeHtml(input: string) {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export async function sendGiftEmail(args: SendGiftEmailArgs) {
  // Prefer explicit SMTP vars
  const BREVO_SMTP_KEY =
    getEnv("BREVO_SMTP_KEY") || getEnv("BREVO_API_KEY") || "";
  if (!BREVO_SMTP_KEY) {
    throw new Error("Missing BREVO_SMTP_KEY (or BREVO_API_KEY fallback)");
  }

  const SMTP_USER = getEnv("BREVO_SMTP_LOGIN") || "apikey";

  // IMPORTANT: FROM_EMAIL must be a verified Brevo sender/domain
  const FROM_EMAIL = getEnv("FROM_EMAIL") || "noreply@thankumail.com";
  const FROM_NAME = getEnv("FROM_NAME") || "ThankuMail";

  const claimUrl = toAbsoluteClaimLink(args.claimLink);
  const dollars = (args.amountCents / 100).toFixed(2);

  const subject = `You received a ThanküMail gift ($${dollars})`;

  const text = [
    `You received a ThanküMail gift!`,
    ``,
    `Amount: $${dollars}`,
    `Message: ${args.message}`,
    ``,
    `Claim here: ${claimUrl}`,
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
        <a href="${claimUrl}" style="display:inline-block; padding:10px 14px; background:#7c3aed; color:#fff; text-decoration:none; border-radius:10px; font-weight:700">
          Claim your gift →
        </a>
      </p>
      <p style="margin:0; color:#777; font-size:13px">If you did not expect this, you can ignore this email.</p>
    </div>
  `;

  // Brevo SMTP standard settings
  const transporter = nodemailer.createTransport({
    host: "smtp-relay.brevo.com",
    port: 587,
    secure: false,
    auth: {
      user: SMTP_USER,
      pass: BREVO_SMTP_KEY,
    },
    // Helps on some platforms with slower connections
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });

  // Optional sanity check (doesn't leak secrets)
  // If this throws, you'll get an actionable error in logs.
  try {
    await transporter.verify();
  } catch (err: any) {
    console.error("SMTP_VERIFY_FAIL", {
      host: "smtp-relay.brevo.com",
      port: 587,
      user: SMTP_USER,
      from: FROM_EMAIL,
      code: err?.code,
      responseCode: err?.responseCode,
      command: err?.command,
      message: err?.message,
      response: err?.response,
    });
    throw err;
  }

  try {
    const info = await transporter.sendMail({
      from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
      to: args.to,
      subject,
      text,
      html,
    });

    console.log("SMTP_SEND_OK", {
      to: args.to,
      from: FROM_EMAIL,
      messageId: info.messageId,
    });

    return { messageId: info.messageId };
  } catch (err: any) {
    console.error("SMTP_SEND_FAIL", {
      to: args.to,
      from: FROM_EMAIL,
      code: err?.code,
      responseCode: err?.responseCode,
      command: err?.command,
      message: err?.message,
      response: err?.response,
    });
    throw err;
  }
}
