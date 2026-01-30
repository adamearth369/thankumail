// WHERE TO PASTE: server/email.ts
// ACTION: Full file replacement (paste exactly)

type SendEmailResult = { ok: true; messageId: string } | { ok: false; error: string };

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

function env(name: string, fallback = "") {
  const v = process.env[name];
  return (v ?? fallback).trim();
}

function isEmail(s: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((s || "").trim());
}

function toAbsoluteLink(link: string) {
  if (!link) return link;
  if (/^https?:\/\//i.test(link)) return link;

  const base =
    env("PUBLIC_SITE_URL") ||
    env("PUBLIC_CLAIM_BASE_URL") ||
    env("BASE_URL", "").replace(/\/+$/, "");

  if (!base) return link;

  const path = link.startsWith("/") ? link : `/${link}`;
  return `${base}${path}`;
}

function escapeHtml(input: string) {
  return String(input || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function logEmail(event: string, fields: Record<string, any> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

function emailDomain(to: string) {
  const parts = (to || "").split("@");
  return parts.length === 2 ? parts[1] : "";
}

function money(cents: number) {
  const dollars = (Number(cents || 0) / 100).toFixed(2);
  return `$${dollars}`;
}

/* -------------------- KEY HANDLING -------------------- */
function redactKey(k: string) {
  const s = (k || "").trim();
  if (!s) return "";
  const a = s.slice(0, 6);
  const b = s.slice(-2);
  return `${a}…${b}`;
}

function looksLikeBrevoApiKey(k: string) {
  const s = (k || "").trim();
  return /^xkeysib-/.test(s);
}

function getBrevoApiKey():
  | { ok: true; key: string; note: string; preview: string }
  | { ok: false; error: string; note: string } {
  const apiKey = env("BREVO_API_KEY");
  const smtpKey = env("BREVO_SMTP_KEY");

  if (apiKey) {
    const note = looksLikeBrevoApiKey(apiKey)
      ? "BREVO_API_KEY_present"
      : "BREVO_API_KEY_present_nonstandard_format";
    return { ok: true, key: apiKey, note, preview: redactKey(apiKey) };
  }

  if (smtpKey) {
    return {
      ok: false,
      error: "BREVO_API_KEY is missing (BREVO_SMTP_KEY is set, but the API endpoint requires an API v3 key)",
      note: "BREVO_SMTP_KEY_present_but_rejected",
    };
  }

  return { ok: false, error: "Missing BREVO_API_KEY", note: "no_brevo_keys_present" };
}

/* -------------------- REPLY-TO POLICY -------------------- */
function buildReplyTo(senderEmail?: string) {
  // Replies should NEVER go to @thankumail.com; use the original sender when present.
  const s = (senderEmail || "").trim();
  // Brevo requires replyTo.name when replyTo.email is present.
  if (s && isEmail(s)) return { email: s, name: s };
  return null; // no Reply-To if we don't have a valid sender
}

/* -------------------- BREVO SEND -------------------- */
async function sendBrevoEmail(params: {
  to: string;
  subject: string;
  textContent: string;
  htmlContent: string;
  headers?: Record<string, string>;
  senderEmailForReplyTo?: string;
}): Promise<SendEmailResult> {
  const started = Date.now();

  try {
    const to = (params.to || "").trim();
    if (!isEmail(to)) return { ok: false, error: `Invalid recipient email: "${to}"` };

    const endpoint = env("BREVO_API_ENDPOINT", "https://api.brevo.com/v3/smtp/email");

    // IMPORTANT: This is the actual email "From" header (Brevo sender).
    // It should be your verified sender/domain in Brevo.
    const fromEmail = env("FROM_EMAIL", "no-reply@thankumail.com");
    const fromName = env("FROM_NAME", "ThankuMail");

    const replyTo = buildReplyTo(params.senderEmailForReplyTo);
    const keyInfo = getBrevoApiKey();

    logEmail("email_api_send_start", {
      toDomain: emailDomain(to),
      endpoint,
      fromDomain: emailDomain(fromEmail),
      replyToDomain: replyTo?.email ? emailDomain(replyTo.email) : "",
      keyNote: keyInfo.note,
      keyPreview: keyInfo.ok ? keyInfo.preview : "",
    });

    if (!keyInfo.ok) {
      logEmail("email_api_send_failed", {
        toDomain: emailDomain(to),
        status: 0,
        body: keyInfo.error,
        ms: Date.now() - started,
      });
      return { ok: false, error: keyInfo.error };
    }

    const payload: any = {
      sender: { email: fromEmail, name: fromName },
      to: [{ email: to }],
      subject: params.subject,
      textContent: params.textContent,
      htmlContent: params.htmlContent,
      headers: params.headers || {},
    };

    if (replyTo?.email) {
      payload.replyTo = { email: replyTo.email, name: replyTo.name };
    }

    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": keyInfo.key,
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    const bodyText = await resp.text().catch(() => "");
    let bodyJson: any = null;
    try {
      bodyJson = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      bodyJson = null;
    }

    if (!resp.ok) {
      const bodyPreview = (bodyJson ? JSON.stringify(bodyJson) : bodyText || "").toString().slice(0, 800);

      logEmail("email_api_send_failed", {
        toDomain: emailDomain(to),
        status: resp.status,
        body: bodyPreview,
        ms: Date.now() - started,
      });

      return { ok: false, error: `Brevo API error (${resp.status}): ${bodyPreview}` };
    }

    const messageId = (bodyJson && (bodyJson.messageId || bodyJson["messageId"])) || "unknown";

    logEmail("email_api_send_ok", {
      toDomain: emailDomain(to),
      messageId: String(messageId),
      ms: Date.now() - started,
    });

    return { ok: true, messageId: String(messageId) };
  } catch (err: any) {
    const msg = String(err?.message || err);
    logEmail("email_api_crash", { message: msg, code: err?.code });
    return { ok: false, error: msg };
  }
}

/* -------------------- PUBLIC API -------------------- */
export async function sendGiftEmail(args: SendGiftEmailArgs): Promise<{ ok: boolean; error?: string }> {
  const claimUrl = toAbsoluteLink(args.claimUrl);
  const subject = `You received a ThankuMail`;

  const textContent = [
    `You received a ThankuMail`,
    ``,
    `Amount: ${money(args.amountCents)}`,
    args.senderEmail ? `From: ${args.senderEmail}` : "",
    args.message ? `Message: ${args.message}` : "",
    ``,
    `Claim: ${claimUrl}`,
  ]
    .filter(Boolean)
    .join("\n");

  const htmlContent = `
    <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; line-height:1.4">
      <h2 style="margin:0 0 12px">You received a ThankuMail 🎁</h2>
      <p style="margin:0 0 8px"><b>Amount:</b> ${money(args.amountCents)}</p>
      ${args.senderEmail ? `<p style="margin:0 0 8px"><b>From:</b> ${escapeHtml(args.senderEmail)}</p>` : ""}
      ${
        args.message
          ? `<p style="margin:0 0 8px"><b>Message:</b></p>
             <p style="margin:0 0 16px; font-style:italic; color:#555">"${escapeHtml(args.message)}"</p>`
          : ""
      }
      <p style="margin:0 0 16px">
        <a href="${claimUrl}" style="display:inline-block; padding:10px 14px; background:#111; color:#fff; text-decoration:none; border-radius:10px; font-weight:700">
          Claim your ThankuMail →
        </a>
      </p>
    </div>
  `;

  const r = await sendBrevoEmail({
    to: args.to,
    subject,
    textContent,
    htmlContent,
    senderEmailForReplyTo: args.senderEmail,
    headers: { "X-ThankuMail-PublicId": args.publicId, "X-ThankuMail-Kind": "gift" },
  });

  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

export async function sendReminderEmail(args: SendReminderEmailArgs): Promise<{ ok: boolean; error?: string }> {
  const claimUrl = toAbsoluteLink(args.claimUrl);
  const subject = `Reminder: your ThankuMail is waiting`;

  const textContent = [
    `Your ThankuMail is still waiting.`,
    ``,
    `Amount: ${money(args.amountCents)}`,
    args.senderEmail ? `From: ${args.senderEmail}` : "",
    ``,
    `Claim: ${claimUrl}`,
  ]
    .filter(Boolean)
    .join("\n");

  const htmlContent = `
    <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; line-height:1.4">
      <h2 style="margin:0 0 12px">Your ThankuMail is still waiting 💛</h2>
      <p style="margin:0 0 8px"><b>Amount:</b> ${money(args.amountCents)}</p>
      ${args.senderEmail ? `<p style="margin:0 0 8px"><b>From:</b> ${escapeHtml(args.senderEmail)}</p>` : ""}
      <p style="margin:0 0 16px">
        <a href="${claimUrl}" style="display:inline-block; padding:10px 14px; background:#111; color:#fff; text-decoration:none; border-radius:10px; font-weight:700">
          Claim now →
        </a>
      </p>
    </div>
  `;

  const r = await sendBrevoEmail({
    to: args.to,
    subject,
    textContent,
    htmlContent,
    senderEmailForReplyTo: args.senderEmail,
    headers: { "X-ThankuMail-PublicId": args.publicId, "X-ThankuMail-Kind": "reminder" },
  });

  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

export async function sendReturnToSenderEmail(
  args: SendReturnToSenderEmailArgs,
): Promise<{ ok: boolean; error?: string }> {
  const subject = `Your ThankuMail update`;

  const textContent = [
    `Your ThankuMail could not be completed.`,
    ``,
    `Public ID: ${args.publicId}`,
    `Amount: ${money(args.amountCents)}`,
    args.reason ? `Reason: ${args.reason}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const htmlContent = `
    <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; line-height:1.4">
      <h2 style="margin:0 0 12px">Your ThankuMail update</h2>
      <p style="margin:0 0 8px"><b>Public ID:</b> ${escapeHtml(args.publicId)}</p>
      <p style="margin:0 0 8px"><b>Amount:</b> ${money(args.amountCents)}</p>
      ${args.reason ? `<p style="margin:0 0 8px"><b>Reason:</b> ${escapeHtml(args.reason)}</p>` : ""}
    </div>
  `;

  const r = await sendBrevoEmail({
    to: args.to,
    subject,
    textContent,
    htmlContent,
    headers: { "X-ThankuMail-PublicId": args.publicId, "X-ThankuMail-Kind": "return_to_sender" },
  });

  return r.ok ? { ok: true } : { ok: false, error: r.error };
}
