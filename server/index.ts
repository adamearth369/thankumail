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

function isEmail(s: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function toAbsoluteClaimLink(claimLink: string) {
  if (!claimLink) return claimLink;
  if (/^https?:\/\//i.test(claimLink)) return claimLink;

  const base = env("BASE_URL", "").replace(/\/+$/, "");
  if (!base) return claimLink;

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

function logEmail(event: string, fields: Record<string, any> = {}) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...fields,
    }),
  );
}

function redact(s: string) {
  if (!s) return "";
  if (s.length <= 8) return "***";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

export async function sendGiftEmail(args: SendGiftEmailArgs): Promise<SendGiftEmailResult> {
  const started = Date.now();

  try {
    const to = (args.to || "").trim();
    if (!isEmail(to)) {
      return { ok: false, error: `Invalid recipient email: "${to}"` };
    }

    // For Brevo API sending, use BREVO_API_KEY (recommended).
    // If user only set BREVO_SMTP_KEY, we fall back to it, but API key is preferred.
    const apiKey = env("BREVO_API_KEY") || env("BREVO_SMTP_KEY");
    if (!apiKey) {
      return { ok: false, error: "Missing BREVO_API_KEY" };
    }

    const fromEmail = env("FROM_EMAIL", "noreply@thankumail.com");
    const fromName = env("FROM_NAME", "ThankuMail");

    const dollars = (args.amountCents / 100).toFixed(2);
    const claimUrl = toAbsoluteClaimLink(args.claimLink);

    const subject = `You received a ThanküMail gift ($${dollars})`;

    const textContent = [
      `You received a ThanküMail gift!`,
      ``,
      `Amount: $${dollars}`,
      `Message: ${args.message}`,
      ``,
      `Claim here: ${claimUrl}`,
    ].join("\n");

    const htmlContent = `
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

    const endpoint = env("BREVO_API_ENDPOINT", "https://api.brevo.com/v3/smtp/email");

    logEmail("email_api_send_start", {
      to,
      fromEmail,
      endpoint,
      apiKey: redact(apiKey),
    });

    // IMPORTANT: Brevo API uses header "api-key"
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
        subject,
        textContent,
        htmlContent,
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
        to,
        status: resp.status,
        body: bodyJson ?? bodyText?.slice(0, 500),
        ms: Date.now() - started,
      });
      return { ok: false, error: `Brevo API error (${resp.status})` };
    }

    const messageId = (bodyJson && (bodyJson.messageId || bodyJson["messageId"])) || "unknown";

    logEmail("email_api_send_ok", {
      to,
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
