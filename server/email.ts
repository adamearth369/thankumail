import nodemailer from "nodemailer";

type SendGiftEmailArgs = {
  to: string;
  claimLink: string; // can be relative "/claim/abc" or absolute
  message: string;
  amountCents: number;
};

type SendGiftEmailResult =
  | { ok: true; messageId: string }
  | { ok: false; error: string };

function env(name: string, fallback = "") {
  const v = process.env[name];
  return (v ?? fallback).trim();
}

function asInt(value: string, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isEmail(s: string) {
  // simple + safe (good enough for routing)
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function toAbsoluteClaimLink(claimLink: string) {
  if (!claimLink) return claimLink;

  // already absolute
  if (/^https?:\/\//i.test(claimLink)) return claimLink;

  const base = env("BASE_URL", "").replace(/\/+$/, "");
  if (!base) return claimLink; // leave relative if no BASE_URL configured

  const path = claimLink.startsWith("/") ? claimLink : `/${claimLink}`;
  return `${base}${path}`;
}

function escapeHtml(input: string) {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export async function sendGiftEmail(
  args: SendGiftEmailArgs,
): Promise<SendGiftEmailResult> {
  try {
    const to = (args.to || "").trim();
    if (!isEmail(to)) {
      return { ok: false, error: `Invalid recipient email: "${to}"` };
    }

    const smtpKey = env("BREVO_SMTP_KEY") || env("BREVO_API_KEY");
    if (!smtpKey) {
      return { ok: false, error: "Missing BREVO_SMTP_KEY (or BREVO_API_KEY)" };
    }

    const host = env("SMTP_HOST", "smtp-relay.brevo.com");
    const port = asInt(env("SMTP_PORT", "587"), 587);
    const secure = env("SMTP_SECURE", "false").toLowerCase() === "true";

    // IMPORTANT: Brevo SMTP user is typically literally "apikey"
    const user = env("BREVO_SMTP_LOGIN", "apikey");

    // Use a VERIFIED sender in Brevo or it can fail
    const fromEmail = env("FROM_EMAIL", "noreply@thankumail.com");
    const fromName = env("FROM_NAME", "ThankuMail");

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass: smtpKey },
    });

    const dollars = (args.amountCents / 100).toFixed(2);
    const claimUrl = toAbsoluteClaimLink(args.claimLink);

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

    const info = await transporter.sendMail({
      from: `"${fromName}" <${fromEmail}>`,
      to,
      subject,
      text,
      html,
    });

    console.log(
      JSON.stringify({
        tag: "email_sent",
        to,
        from: fromEmail,
        messageId: info.messageId,
      }),
    );

    return { ok: true, messageId: info.messageId || "unknown" };
  } catch (err: any) {
    // DO NOT throw: gift creation must not fail just because email failed
    const safe = {
      tag: "email_send_failed",
      message: String(err?.message || err),
      code: err?.code,
      response: err?.response,
      responseCode: err?.responseCode,
    };
    console.error(JSON.stringify(safe));
    return { ok: false, error: safe.message };
  }
}
