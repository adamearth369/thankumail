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

const EMAIL_VERSION = "email_v2026-02-14_005";

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
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      emailVersion: EMAIL_VERSION,
      ...fields,
    }),
  );
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
      error:
        "BREVO_API_KEY is missing (BREVO_SMTP_KEY is set, but the API endpoint requires an API v3 key)",
      note: "BREVO_SMTP_KEY_present_but_rejected",
    };
  }

  return { ok: false, error: "Missing BREVO_API_KEY", note: "no_brevo_keys_present" };
}

/* -------------------- EMAIL STYLE -------------------- */
function publicSite() {
  return (env("PUBLIC_SITE_URL") || "https://thankumail.com").replace(/\/+$/, "");
}

function wordmarkUrl() {
  return `${publicSite()}/images/thankumail-wordmark.png`;
}

function fontCss() {
  const base = publicSite();

  // Best-effort: many clients support @font-face; Gmail may still fall back.
  return `
  @font-face {
    font-family: 'TM Quicksand';
    font-style: normal;
    font-weight: 600;
    src: url('${base}/fonts/quicksand-600.woff2') format('woff2');
  }
  @font-face {
    font-family: 'TM DM Sans';
    font-style: normal;
    font-weight: 400;
    src: url('${base}/fonts/dm-sans-400.woff2') format('woff2');
  }
  @font-face {
    font-family: 'TM DM Sans';
    font-style: normal;
    font-weight: 500;
    src: url('${base}/fonts/dm-sans-500.woff2') format('woff2');
  }

  :root { color-scheme: light; supported-color-schemes: light; }

  body, table, td, div, p, a, span, h1, h2, h3 {
    font-family: 'TM DM Sans', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
    -webkit-text-size-adjust: 100%;
    text-size-adjust: 100%;
  }

  .tm-wordmark {
    font-family: 'TM Quicksand', 'TM DM Sans', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
    font-weight: 600 !important;
    letter-spacing: 0.2px;
  }

  .tm-title {
    font-family: 'TM DM Sans', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
    font-weight: 800 !important;
  }

  .tm-btn {
    font-family: 'TM DM Sans', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
    font-weight: 800 !important;
  }
  `;
}

function htmlDoc(inner: string) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
  <title>thankümail</title>
  <style type="text/css">
  ${fontCss()}
  </style>
</head>
<body style="margin:0; padding:0; background:#ffffff;">
  <div style="margin:0; padding:0; background:#ffffff;">
    ${inner}
  </div>
</body>
</html>`;
}

function shell(args: {
  title: string;
  bodyHtml: string;
  ctaHref: string;
  ctaLabel: string;
  note?: string;
}) {
  const logo = wordmarkUrl();

  return htmlDoc(`
  <div style="padding:18px; background:#ffffff; color:#0f172a;">
    <div style="max-width:640px; margin:0 auto;">
      <div style="margin:2px 0 14px; text-align:center;">
        <img src="${logo}" alt="thankümail" width="220" style="display:block; margin:0 auto; height:auto; border:0; outline:none; text-decoration:none;" />
      </div>

      <h1 class="tm-title" style="margin:0 0 12px; font-size:28px; line-height:1.2; color:#0f172a; text-align:center;">
        ${escapeHtml(args.title)}
      </h1>

      <div style="max-width:520px; margin:0 auto;">
        ${args.bodyHtml}

        <div style="margin:18px 0 0; text-align:center;">
          <a href="${args.ctaHref}"
             class="tm-btn"
             style="display:inline-block; padding:14px 18px; background:#0b1220; color:#ffffff; text-decoration:none; border-radius:14px; font-size:14px; letter-spacing:0.2px;">
            ${escapeHtml(args.ctaLabel)} →
          </a>
        </div>

        <div style="margin:14px 0 0; font-size:12px; color:#6b7280; text-align:center;">
          ${escapeHtml(args.note || "This message was sent anonymously.")}
        </div>
      </div>
    </div>
  </div>
  `);
}

function messageCard(message: string) {
  const safe = escapeHtml(message || "");
  return `
  <div style="margin:0 0 10px; font-size:14px; color:#0f172a; font-weight:700;">Message</div>
  <div style="margin:0 0 6px; padding:14px 16px; border:1px solid #e5e7eb; border-radius:14px; background:#ffffff;">
    <div style="font-size:15px; color:#111827; font-style:italic; line-height:1.5;">
      "${safe}"
    </div>
  </div>
  `;
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

    const fromEmail = env("FROM_EMAIL", "no-reply@thankumail.com");
    const fromName = env("FROM_NAME", "thankümail");

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
      const bodyPreview = (bodyJson ? JSON.stringify(bodyJson) : bodyText || "")
        .toString()
        .slice(0, 800);

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
  const textContent = textLines.join("\n"); // keep intended blank lines

  const bodyHtml = `
    ${args.message ? messageCard(args.message) : ""}
    <div style="margin:0; font-size:12px; color:#6b7280;">
      ${showAmount ? `A gift is included.` : `A note, sent with care.`}
    </div>
  `;

  const htmlContent = shell({
    title: "You received a thankümail 🎁",
    bodyHtml,
    ctaHref: claimUrl,
    ctaLabel: "Accept your thankümail",
    note: "This message was sent anonymously.",
  });

  const r = await sendBrevoEmail({
    to: args.to,
    subject,
    textContent,
    htmlContent,
    headers: { "X-thankümail-PublicId": args.publicId, "X-thankümail-Kind": "gift" },
  });

  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

export async function sendReminderEmail(
  args: SendReminderEmailArgs,
): Promise<{ ok: boolean; error?: string }> {
  const claimUrl = toAbsoluteLink(args.claimUrl);
  const subject = `Reminder: your thankümail is waiting`;

  const showAmount = shouldShowAmount(args.amountCents);

  const textLines: string[] = [`Your thankümail is still waiting.`, ``];
  if (showAmount) textLines.push(`Amount: ${money(args.amountCents)}`);
  textLines.push(``, `Claim: ${claimUrl}`);
  const textContent = textLines.join("\n"); // keep intended blank lines

  const bodyHtml = `
    <div style="margin:0 0 10px; font-size:14px; color:#111827;">
      Your thankümail is still waiting.
    </div>
    <div style="margin:0; font-size:12px; color:#6b7280;">
      ${showAmount ? `A gift is included.` : `A note, sent with care.`}
    </div>
  `;

  const htmlContent = shell({
    title: "Your thankümail is still waiting 💛",
    bodyHtml,
    ctaHref: claimUrl,
    ctaLabel: "Accept your thankümail",
    note: "This message was sent anonymously.",
  });

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
  const textContent = textLines.join("\n"); // keep intended blank lines

  const reasonHtml = args.reason
    ? `<div style="margin:10px 0 0; padding:12px 14px; border:1px solid #e5e7eb; border-radius:14px; background:#ffffff;">
         <div style="font-size:12px; color:#6b7280; font-weight:700; margin:0 0 6px;">Reason</div>
         <div style="font-size:14px; color:#111827;">${escapeHtml(args.reason)}</div>
       </div>`
    : "";

  const bodyHtml = `
    <div style="margin:0; font-size:14px; color:#111827;">
      Your thankümail could not be completed.
    </div>
    <div style="margin:10px 0 0; font-size:12px; color:#6b7280;">
      Public ID: <span style="color:#111827; font-weight:700;">${escapeHtml(args.publicId)}</span>
    </div>
    ${reasonHtml}
  `;

  const htmlContent = htmlDoc(`
    <div style="padding:18px; background:#ffffff; color:#0f172a;">
      <div style="max-width:640px; margin:0 auto;">
        <div style="margin:2px 0 14px; text-align:center;">
          <img src="${wordmarkUrl()}" alt="thankümail" width="220" style="display:block; margin:0 auto; height:auto; border:0; outline:none; text-decoration:none;" />
        </div>

        <h1 class="tm-title" style="margin:0 0 12px; font-size:24px; line-height:1.2; color:#0f172a; text-align:center;">
          Your thankümail update
        </h1>

        <div style="max-width:520px; margin:0 auto;">
          ${bodyHtml}
        </div>

        <div style="margin:14px 0 0; font-size:12px; color:#6b7280; text-align:center;">
          This message was sent anonymously.
        </div>
      </div>
    </div>
  `);

  const r = await sendBrevoEmail({
    to: args.to,
    subject,
    textContent,
    htmlContent,
    headers: { "X-thankümail-PublicId": args.publicId, "X-thankümail-Kind": "return_to_sender" },
  });

  return r.ok ? { ok: true } : { ok: false, error: r.error };
}
