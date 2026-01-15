type SendGiftEmailArgs = {
  to: string;
  claimUrl: string;
  message: string;
  amountCents: number;
};

const BREVO_API_KEY = process.env.BREVO_API_KEY || "";
const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";

const FROM_EMAIL = process.env.EMAIL_FROM || "noreply@thankumail.com";
const FROM_NAME = process.env.EMAIL_FROM_NAME || "ThankuMail";

function nowIso() {
  return new Date().toISOString();
}

function logEvent(event: string, fields: Record<string, any> = {}) {
  console.log(JSON.stringify({ ts: nowIso(), event, ...fields }));
}

function formatAmount(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function domainOf(email: string) {
  const parts = (email || "").split("@");
  return parts.length === 2 ? parts[1] : "";
}

export async function sendGiftEmail(args: SendGiftEmailArgs) {
  const { to, claimUrl, message, amountCents } = args;
  const toDomain = domainOf(to);

  if (!BREVO_API_KEY) {
    logEvent("email_skipped_no_api_key", { toDomain });
    return;
  }

  const payload = {
    sender: { email: FROM_EMAIL, name: FROM_NAME },
    to: [{ email: to }],
    subject: "Someone sent you a ThankuMail 💛",
    htmlContent: `
      <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; line-height:1.5; max-width:600px">
        <h2 style="margin:0 0 12px">You’ve received a ThankuMail 💛</h2>

        <p style="margin:0 0 8px">
          <strong>${formatAmount(amountCents)}</strong> has been sent to you.
        </p>

        ${
          message
            ? `<p style="margin:0 0 16px; font-style:italic; color:#555">“${message}”</p>`
            : ""
        }

        <p style="margin:0 0 20px">
          <a href="${claimUrl}"
             style="display:inline-block;padding:12px 18px;background:#111;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">
            Open your ThankuMail
          </a>
        </p>

        <p style="margin:0 0 16px; font-size:13px; color:#666">
          If the button doesn’t work, copy and paste this link:<br/>
          ${claimUrl}
        </p>

        <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>

        <p style="margin:0; font-size:13px; color:#777">
          ThankuMail is a simple way for someone to send a message of kindness along with a gift.
          <br/>
          No pressure to claim it — and we’ll never ask for personal information.
        </p>
      </div>
    `,
  };

  const started = Date.now();

  logEvent("email_api_send_start", {
    toDomain,
    fromEmail: FROM_EMAIL,
    endpoint: BREVO_ENDPOINT,
  });

  const res = await fetch(BREVO_ENDPOINT, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "api-key": BREVO_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  const ms = Date.now() - started;

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logEvent("email_api_send_failed", {
      toDomain,
      status: res.status,
      ms,
      response: text.slice(0, 300),
    });
    throw new Error(`Brevo send failed ${res.status}`);
  }

  const json: any = await res.json().catch(() => null);

  logEvent("email_api_send_ok", {
    toDomain,
    messageId: json?.messageId || null,
    ms,
  });
}
