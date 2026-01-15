// ============================================================
// FILE TO REPLACE (FULL FILE)
// WHERE TO PASTE: server/email.ts
// PURPOSE:
// - Subject line update (B)
// - Add reminder email sender (A)
// - Remove API key from logs + safer logging
// ============================================================

type SendEmailResult =
  | { ok: true; messageId: string }
  | { ok: false; error: string };

function env(name: string, fallback = "") {
  const v = process.env[name];
  return (v ?? fallback).trim();
}

function isEmail(s: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function toDomain(email: string) {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase() : "";
}

function escapeHtml(input: string) {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function logEmail(event: string, fields: Record<string, any> = {}) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...fields,
    }),
  );
}

function toAbsoluteUrl(maybeRelative: string) {
  if (!maybeRelative) return maybeRelative;
  if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;

  const base =
    env("PUBLIC_BASE_URL") ||
    env("BASE_URL") ||
    ""; // set PUBLIC_BASE_URL on Render to https://thankumail.com

  if (!base) return maybeRelative;

  const cleanBase = base.replace(/\/+$/, "");
  const path = maybeRelative.startsWith("/") ? maybeRelative : `/${maybeRelative}`;
  return `${cleanBase}${path}`;
}

async function sendBrevoEmail(args: {
  to: string;
  subject: string;
  textContent: string;
  htmlContent: string;
}): Promise<SendEmailResult> {
  const started = Date.now();

  try {
    const to = (args.to || "").trim();
    if (!isEmail(to)) return { ok: false, error: `Invalid recipient email: "${to}"` };

    const apiKey = env("BREVO_API_KEY") || env("BREVO_SMTP_KEY");
    if (!apiKey) return { ok: false, error: "Missing BREVO_API_KEY" };

    const fromEmail = env("FROM_EMAIL", "noreply@thankumail.com");
    const fromName = env("FROM_NAME", "ThankuMail");
    const endpoint = env("BREVO_API_ENDPOINT", "https://api.brevo.com/v3/smtp/email");

    logEmail("email_api_send_start", {
      toDomain: toDomain(to),
      fromEmail,
      fromName,
      endpoint,
    });

    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": apiKey,
        Accept: "application/json",
      },
      body: JSON.stringify({
        sender: { email: fromEmail, name: fromName },
        to: [{ email: to }],
        subject: args.subject,
        textContent: args.textContent,
        htmlContent: args.htmlContent,
      }),
    });

    const bodyText = await resp.text();
    let bodyJson: any = null;
    try {
      bodyJson = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      bodyJson = null;
    }

    if (!resp.ok) {
      logEmail("email_api_send_failed", {
        toDomain: toDomain(to),
        status: resp.status,
        body: bodyJson ?? bodyText?.slice(0, 300),
        ms: Date.now() - started,
      });
      return { ok: false, error: `Brevo API error (${resp.status})` };
    }

    const messageId =
      (bodyJson && (bodyJson.messageId || bodyJson["messageId"])) || "unknown";

    logEmail("email_api_send_ok", {
      toDomain: toDomain(to),
      messageId,
      ms: Date.now() - started,
    });

    return { ok: true, messageId: String(messageId) };
  } catch (err: any) {
    const msg = String(err?.message || err);
    logEmail("email_api_crash", {
      message: msg,
      code: err?.code,
      ms: Date.now() - started,
    });
    return { ok: false, error: msg };
  }
}

/* ============================================================
   B) PRIMARY SEND (subject tuned for deliverability)
============================================================ */
export async function sendGiftEmail(args: {
  to: string;
  claimLink: string; // relative "/claim/abc" or absolute
  message: string;
  amountCents: number;
}): Promise<SendEmailResult> {
  const to = (args.to || "").trim();
  const dollars = (args.amountCents / 100).toFixed(2);
  const claimUrl = toAbsoluteUrl(args.claimLink);

  // UPDATED SUBJECT (B)
  const subject = "Someone sent you a ThanküMail";

  const textContent = [
    `Someone sent you a ThanküMail.`,
    ``,
    `Message: ${args.message}`,
    `Gift amount: $${dollars}`,
    ``,
    `Open it when you're ready: ${claimUrl}`,
    ``,
    `You're never required to claim anything, and no personal information is requested.`,
  ].join("\n");

  const htmlContent = `
    <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; line-height:1.5; color:#111">
      <h2 style="margin:0 0 12px">Someone sent you a ThanküMail</h2>
      <p style="margin:0 0 10px"><b>Gift amount:</b> $${dollars}</p>
      <p style="margin:0 0 6px"><b>Message:</b></p>
      <p style="margin:0 0 16px; font-style:italic; color:#444">"${escapeHtml(args.message)}"</p>
      <p style="margin:0 0 16px">
        <a href="${claimUrl}" style="display:inline-block; padding:10px 14px; background:#7c3aed; color:#fff; text-decoration:none; border-radius:10px; font-weight:700">
          Open your ThanküMail →
        </a>
      </p>
      <p style="margin:0; color:#666; font-size:13px">
        ThanküMail is a simple way for someone to send a message of appreciation along with a gift.
        You’re never required to claim anything, and no personal information is requested.
      </p>
    </div>
  `;

  return sendBrevoEmail({ to, subject, textContent, htmlContent });
}

/* ============================================================
   A) REMINDER SEND (48-hour reminder)
============================================================ */
export async function sendGiftReminderEmail(args: {
  to: string;
  claimLink: string; // relative "/claim/abc" or absolute
}): Promise<SendEmailResult> {
  const to = (args.to || "").trim();
  const claimUrl = toAbsoluteUrl(args.claimLink);

  const subject = "A ThanküMail is waiting for you";

  const textContent = [
    `A ThanküMail is still waiting for you.`,
    ``,
    `If you'd like to read it, it's here: ${claimUrl}`,
    ``,
    `You're never required to claim anything, and no personal information is requested.`,
  ].join("\n");

  const htmlContent = `
    <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; line-height:1.5; color:#111">
      <h2 style="margin:0 0 12px">A ThanküMail is waiting for you</h2>
      <p style="margin:0 0 16px; color:#333">
        Someone sent you a ThanküMail earlier. If you'd like to read it, it's still here for you.
      </p>
      <p style="margin:0 0 16px">
        <a href="${claimUrl}" style="display:inline-block; padding:10px 14px; background:#7c3aed; color:#fff; text-decoration:none; border-radius:10px; font-weight:700">
          Open your ThanküMail →
        </a>
      </p>
      <p style="margin:0; color:#666; font-size:13px">
        ThanküMail is a simple way for someone to send a message of appreciation along with a gift.
        You’re never required to claim anything, and no personal information is requested.
      </p>
    </div>
  `;

  return sendBrevoEmail({ to, subject, textContent, htmlContent });
}
