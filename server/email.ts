// WHERE TO PASTE: server/email.ts
// ACTION: Full file replacement (paste exactly)

type SendEmailResult = { ok: true; messageId: string } | { ok: false; error: string };

type SendGiftEmailArgs = {
  to: string;
  publicId: string;
  claimUrl: string;
  amountCents: number;
  senderEmail?: string; // intentionally NOT used (anonymous)
  message?: string;
};

type SendReminderEmailArgs = {
  to: string;
  publicId: string;
  claimUrl: string;
  amountCents: number;
  senderEmail?: string; // intentionally NOT used (anonymous)
};

type SendReturnToSenderEmailArgs = {
  to: string; // sender email
  publicId: string;
  amountCents: number;
  reason?: string;
};

const EMAIL_VERSION = "email_v2026-02-14_002";

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
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, emailVersion: EMAIL_VERSION, ...fields }));
}

function emailDomain(to: string) {
  const parts = (to || "").split("@");
  return parts.length === 2 ? parts[1] : "";
}

function money(cents: number) {
  const dollars = (Number(cents || 0) / 100).toFixed(2);
  return `$${dollars}`;
}

function shouldShowAmount(amountCents: number) {
  return Number(amountCents || 0) > 0;
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

/* -------------------- HTML WRAPPER -------------------- */
function htmlDoc(inner: string) {
  // NOTE: Email clients may fall back to system fonts. We still try to load the same families as the site.
  const fontLinks = `
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Outfit:wght@500;700;800&family=Quicksand:wght@600;700&display=swap" rel="stylesheet" />
`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
  <title>thankümail</title>
  ${fontLinks}
</head>
<body style="margin:0; padding:0; background:#ffffff;">
  <div style="padding:16px; color:#111; line-height:1.6; font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, 'Apple Color Emoji', 'Segoe UI Emoji', sans-serif;">
    ${inner}
  </div>
</body>
</html>`;
}

/* -------------------- BREVO SEND -------------------- */
async function sendBrevoEmail(params: {
  to: string;
  subject: string;
  textContent: string;
  htmlContent: string;
  headers?: Record<string, string>;
}): Promise<SendEmailResult> {
  const started = Date.now();

  try {
    const to = (params.to || "").trim();
    if (!isEmail(to)) return { ok: false, error: `Invalid recipient email: "${to}"` };

    const endpoint = env("BREVO_API_ENDPOINT", "https://api.brevo.com/v3/smtp/email");

    // IMPORTANT: these must match a VERIFIED sender in Brevo
    const fromEmail = env("FROM_EMAIL", "no-reply@thankumail.com");
    const fromName = env("FROM_NAME", "thankümail");

    // CRITICAL ANONYMITY:
    // Always force Reply-To to the same no-reply identity so Brevo/account defaults can’t leak a real address.
    const replyToEmail = env("REPLY_TO_EMAIL", fromEmail);
    const replyToName = env("REPLY_TO_NAME", fromName);

    const keyInfo = getBrevoApiKey();

    logEmail("email_api_send_start", {
      toDomain: emailDomain(to),
      endpoint,
      fromDomain: emailDomain(fromEmail),
      replyToDomain: emailDomain(replyToEmail),
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
      replyTo: { email: replyToEmail, name: replyToName },
      to: [{ email: to }],
      subject: params.subject,
      textContent: params.textContent,
      htmlContent: params.htmlContent,
      headers: params.headers || {},
    };

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
  const subject = `You received a thankümail`;

  const showAmount = shouldShowAmount(args.amountCents);

  const textLines: string[] = [`You received a thankümail`, ``];
  if (showAmount) textLines.push(`Amount: ${money(args.amountCents)}`);
  if (args.message) textLines.push(`Message: ${args.message}`);
  textLines.push(``, `Claim: ${claimUrl}`);
  const textContent = textLines.filter(Boolean).join("\n");

  const inner = `
    <div style="margin:0 0 6px; font-family:'Quicksand','DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-weight:700; color:#111; font-size:14px;">
      thankümail
    </div>

    <h2 style="margin:0 0 12px; font-family:'Outfit','DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:26px; line-height:1.2; font-weight:800; color:#111;">
      You received a thankümail 🎁
    </h2>

    ${
      showAmount
        ? `<p style="margin:0 0 10px; font-size:14px; color:#111;"><b>Amount:</b> ${money(args.amountCents)}</p>`
        : ``
    }

    ${
      args.message
        ? `<p style="margin:0 0 8px; font-size:14px; color:#111;"><b>Message:</b></p>
           <div style="margin:0 0 16px; padding:12px 14px; border:1px solid #e5e7eb; border-radius:12px; background:#ffffff;">
             <div style="font-size:14px; color:#374151; font-style:italic;">"${escapeHtml(args.message)}"</div>
           </div>`
        : ""
    }

    <p style="margin:0 0 16px">
      <a href="${claimUrl}" style="display:inline-block; padding:12px 16px; background:#111; color:#fff; text-decoration:none; border-radius:14px; font-weight:800; font-size:14px; font-family:'Outfit','DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        Accept your thankümail →
      </a>
    </p>

    <p style="margin:0; font-size:12px; color:#6b7280;">
      This message was sent anonymously.
    </p>
  `;

  const htmlContent = htmlDoc(inner);

  const r = await sendBrevoEmail({
    to: args.to,
    subject,
    textContent,
    htmlContent,
    headers: { "X-thankümail-PublicId": args.publicId, "X-thankümail-Kind": "gift" },
  });

  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

export async function sendReminderEmail(args: SendReminderEmailArgs): Promise<{ ok: boolean; error?: string }> {
  const claimUrl = toAbsoluteLink(args.claimUrl);
  const subject = `Reminder: your thankümail is waiting`;

  const showAmount = shouldShowAmount(args.amountCents);

  const textLines: string[] = [`Your thankümail is still waiting.`, ``];
  if (showAmount) textLines.push(`Amount: ${money(args.amountCents)}`);
  textLines.push(``, `Claim: ${claimUrl}`);
  const textContent = textLines.filter(Boolean).join("\n");

  const inner = `
    <div style="margin:0 0 6px; font-family:'Quicksand','DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-weight:700; color:#111; font-size:14px;">
      thankümail
    </div>

    <h2 style="margin:0 0 12px; font-family:'Outfit','DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:24px; line-height:1.2; font-weight:800; color:#111;">
      Your thankümail is still waiting 💛
    </h2>

    ${
      showAmount
        ? `<p style="margin:0 0 10px; font-size:14px; color:#111;"><b>Amount:</b> ${money(args.amountCents)}</p>`
        : ``
    }

    <p style="margin:0 0 16px">
      <a href="${claimUrl}" style="display:inline-block; padding:12px 16px; background:#111; color:#fff; text-decoration:none; border-radius:14px; font-weight:800; font-size:14px; font-family:'Outfit','DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        Accept your thankümail →
      </a>
    </p>

    <p style="margin:0; font-size:12px; color:#6b7280;">
      This message was sent anonymously.
    </p>
  `;

  const htmlContent = htmlDoc(inner);

  const r = await sendBrevoEmail({
    to: args.to,
    subject,
    textContent,
    htmlContent,
    headers: { "X-thankümail-PublicId": args.publicId, "X-thankümail-Kind": "reminder" },
  });

  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

export async function sendReturnToSenderEmail(
  args: SendReturnToSenderEmailArgs,
): Promise<{ ok: boolean; error?: string }> {
  const subject = `Your thankümail update`;

  const showAmount = shouldShowAmount(args.amountCents);

  const textLines: string[] = [`Your thankümail could not be completed.`, ``, `Public ID: ${args.publicId}`];
  if (showAmount) textLines.push(`Amount: ${money(args.amountCents)}`);
  if (args.reason) textLines.push(`Reason: ${args.reason}`);
  const textContent = textLines.filter(Boolean).join("\n");

  const inner = `
    <div style="margin:0 0 6px; font-family:'Quicksand','DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-weight:700; color:#111; font-size:14px;">
      thankümail
    </div>

    <h2 style="margin:0 0 12px; font-family:'Outfit','DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:24px; line-height:1.2; font-weight:800; color:#111;">
      Your thankümail update
    </h2>

    <p style="margin:0 0 8px; font-size:14px; color:#111;"><b>Public ID:</b> ${escapeHtml(args.publicId)}</p>

    ${
      showAmount
        ? `<p style="margin:0 0 8px; font-size:14px; color:#111;"><b>Amount:</b> ${money(args.amountCents)}</p>`
        : ``
    }

    ${args.reason ? `<p style="margin:0 0 8px; font-size:14px; color:#111;"><b>Reason:</b> ${escapeHtml(args.reason)}</p>` : ""}
  `;

  const htmlContent = htmlDoc(inner);

  const r = await sendBrevoEmail({
    to: args.to,
    subject,
    textContent,
    htmlContent,
    headers: { "X-thankümail-PublicId": args.publicId, "X-thankümail-Kind": "return_to_sender" },
  });

  return r.ok ? { ok: true } : { ok: false, error: r.error };
}
