import nodemailer from "nodemailer";

type SendGiftEmailArgs = {
  to: string;
  claimLink: string; // may be relative like "/claim/abc"
  message: string;
  amountCents: number;
};

function getEnv(name: string, fallback = "") {
  return process.env[name] || fallback;
}

function isEmailDebugEnabled() {
  return getEnv("EMAIL_DEBUG", "") === "1";
}

function toAbsoluteUrl(maybeRelative: string) {
  if (!maybeRelative) return maybeRelative;

  // already absolute
  if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;

  const origin = getEnv(
    "APP_ORIGIN",
    "https://thankumail.onrender.com",
  ).replace(/\/+$/, "");
  const path = maybeRelative.startsWith("/")
    ? maybeRelative
    : `/${maybeRelative}`;
  return `${origin}${path}`;
}

function sanitizeSmtpError(err: any) {
  // Never include secrets. Only safe fields.
  const out: Record<string, any> = {
    name: err?.name,
    message: err?.message,
    code: err?.code,
    command: err?.command,
    responseCode: err?.responseCode,
  };

  // nodemailer sometimes includes a server response string
  if (typeof err?.response === "string") out.response = err.response;

  // Brevo/SMTP servers sometimes embed details; keep it short
  if (typeof out.message === "string" && out.message.length > 500) {
    out.message = out.message.slice(0, 500) + "...";
  }
  if (typeof out.response === "string" && out.response.length > 500) {
    out.response = out.response.slice(0, 500) + "...";
  }

  return out;
}

export async function sendGiftEmail(args: SendGiftEmailArgs) {
  const BREVO_SMTP_KEY = getEnv("BREVO_SMTP_KEY") || getEnv("BREVO_API_KEY"); // fallback
  if (!BREVO_SMTP_KEY) throw new Error("Missing BREVO_SMTP_KEY");

  // Brevo SMTP login is typically literally "apikey"
  const BREVO_SMTP_LOGIN = getEnv("BREVO_SMTP_LOGIN", "apikey");

  // IMPORTANT: FROM_EMAIL must be a sender you verified inside Brevo
  const FROM_EMAIL = getEnv("FROM_EMAIL", "noreply@thankumail.com");
  const FROM_NAME = getEnv("FROM_NAME", "ThankuMail");

  const transporter = nodemailer.createTransport({
    host: "smtp-relay.brevo.com",
    port: 587,
    secure: false,
    auth: {
      user: BREVO_SMTP_LOGIN,
      pass: BREVO_SMTP_KEY,
    },
  });

  const dollars = (args.amountCents / 100).toFixed(2);
  const claimUrl = toAbsoluteUrl(args.claimLink);

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
      <p style="margin:0 0 16px; font-style:italic; color:#555">"${escapeHtml(args.message)}"</p>
      <p style="margin:0 0 16px">
        <a href="${claimUrl}" style="display:inline-block; padding:10px 14px; background:#7c3aed; color:#fff; text-decoration:none; border-radius:10px; font-weight:700">
          Claim your gift →
        </a>
      </p>
      <p style="margin:0; color:#777; font-size:13px">If you did not expect this, you can ignore this email.</p>
    </div>
  `;

  try {
    if (isEmailDebugEnabled()) {
      console.log("[EMAIL_DEBUG] sending email", {
        to: args.to,
        from: FROM_EMAIL,
        origin: getEnv("APP_ORIGIN", "https://thankumail.onrender.com"),
        claimUrl,
      });
    }

    const info = await transporter.sendMail({
      from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
      to: args.to,
      subject,
      text,
      html,
    });

    if (isEmailDebugEnabled()) {
      console.log("[EMAIL_DEBUG] sent OK", { messageId: info.messageId });
    }

    return { messageId: info.messageId };
  } catch (err: any) {
    const safe = sanitizeSmtpError(err);
    console.error("[EMAIL_SEND_FAILED]", safe);

    // Throw a small safe message upward (no secrets)
    throw new Error(
      `SMTP_SEND_FAILED: ${safe.code || safe.responseCode || "unknown"}`,
    );
  }
}

function escapeHtml(input: string) {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
