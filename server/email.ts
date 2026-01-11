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
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((s || "").trim());
}

function firstNonEmpty(...vals: Array<string | undefined | null>) {
  for (const v of vals) {
    const s = (v ?? "").trim();
    if (s) return s;
  }
  return "";
}

function toAbsoluteClaimLink(claimLink: string) {
  if (!claimLink) return claimLink;
  if (/^https?:\/\//i.test(claimLink)) return claimLink;

  // prefer PUBLIC_BASE_URL, then BASE_URL
  const base = firstNonEmpty(env("PUBLIC_BASE_URL"), env("BASE_URL")).replace(/\/+$/, "");
  if (!base) return claimLink;

  const path = claimLink.startsWith("/") ? claimLink : `/${claimLink}`;
  return `${base}${path}`;
}

function escapeHtml(input: string) {
  return (input || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function redact(s: string) {
  if (!s) return "";
  if (s.length <= 8) return "***";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function logEmail(event: string, fields: Record<string, any> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

function parseBrevoError(bodyJson: any, bodyText: string, status: number) {
  const msg =
    (bodyJson && typeof bodyJson.message === "string" && bodyJson.message) ||
    (bodyJson && typeof bodyJson.error === "string" && bodyJson.error) ||
    "";

  const code =
    (bodyJson && typeof bodyJson.code === "string" && bodyJson.code) ||
    (bodyJson && typeof bodyJson.errorCode === "string" && bodyJson.errorCode) ||
    "";

  const hint = (() => {
    if (status === 401) return "Check BREVO_API_KEY (wrong key or key revoked).";
    if (status === 403) return "Blocked (permissions / sender not verified / plan limit).";
    if (status === 400) return "Bad request (sender/to/subject/content).";
    if (status === 429) return "Rate limited (retry).";
    if (status >= 500) return "Brevo server error (retry).";
    return "";
  })();

  const compact =
    msg || code
      ? `${msg}${code ? ` (${code})` : ""}${hint ? ` — ${hint}` : ""}`
      : `${(bodyText || "").slice(0, 160)}${hint ? ` — ${hint}` : ""}`;

  return `Brevo API error (${status}): ${compact || "unknown error"}`;
}

export async function sendGiftEmail(args: SendGiftEmailArgs): Promise<SendGiftEmailResult> {
  const started = Date.now();

  try {
    const to = (args.to || "").trim();
    if (!isEmail(to)) return { ok: false, error: `Invalid recipient email: "${to}"` };

    const apiKey = env("BREVO_API_KEY");
    if (!apiKey) return { ok: false, error: "Missing BREVO_API_KEY" };

    // Require verified sender
    const fromEmail = env("FROM_EMAIL", "");
    if (!fromEmail) {
      return { ok: false, error: "Missing FROM_EMAIL (must be a verified sender in Brevo)" };
    }
    const fromName = env("FROM_NAME", "ThanküMail");

    // Optional but recommended
    const replyToEmail = env("REPLY_TO_EMAIL", "");
    const replyToName = env("REPLY_TO_NAME", fromName);

    const dollars = ((Number(args.amountCents) || 0) / 100).toFixed(2);
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

    const safeMsg = escapeHtml(args.message);

    const htmlContent = `
<div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; line-height:1.45; color:#0f172a">
  <div style="max-width:560px; margin:0 auto; padding:18px 10px">
    <h2 style="margin:0 0 12px; font-size:20px">You received a ThanküMail gift 🎁</h2>
    <p style="margin:0 0 8px"><b>Amount:</b> $${dollars}</p>
    <p style="margin:0 0 8px"><b>Message:</b></p>
    <div style="margin:0 0 16px; padding:14px 16px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:14px; color:#111827">
      <div style="font-style: italic">“${safeMsg}”</div>
    </div>
    <p style="margin:0 0 16px">
      <a href="${claimUrl}" style="display:inline-block; padding:12px 16px; background:#7c3aed; color:#fff; text-decoration:none; border-radius:14px; font-weight:800">
        Claim your gift →
      </a>
    </p>
    <p style="margin:0; color:#64748b; font-size:13px">
      If you did not expect this, you can ignore this email.
    </p>
  </div>
</div>
`.trim();

    const endpoint = env("BREVO_API_ENDPOINT", "https://api.brevo.com/v3/smtp/email");

    const maxAttempts = 2;
    const timeoutMs = Number(env("BREVO_HTTP_TIMEOUT_MS", "8000")) || 8000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      logEmail("email_api_send_start", {
        attempt,
        to,
        fromEmail,
        endpoint,
        apiKey: redact(apiKey),
      });

      try {
        const payload: any = {
          sender: { email: fromEmail, name: fromName },
          to: [{ email: to }],
          subject,
          textContent,
          htmlContent,
        };

        if (replyToEmail) payload.replyTo = { email: replyToEmail, name: replyToName };

        const resp = await fetchWithTimeout(
          endpoint,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "api-key": apiKey,
              Accept: "application/json",
            },
            body: JSON.stringify(payload),
          },
          timeoutMs,
        );

        const bodyText = await resp.text();
        let bodyJson: any = null;
        try {
          bodyJson = bodyText ? JSON.parse(bodyText) : null;
        } catch {
          bodyJson = null;
        }

        if (!resp.ok) {
          const errMsg = parseBrevoError(bodyJson, bodyText, resp.status);

          logEmail("email_api_send_attempt_failed", {
            attempt,
            to,
            status: resp.status,
            body: bodyJson ?? bodyText?.slice(0, 500),
            ms: Date.now() - started,
          });

          const retryable = resp.status === 429 || resp.status >= 500;
          if (retryable && attempt < maxAttempts) {
            await sleep(350);
            continue;
          }

          return { ok: false, error: errMsg };
        }

        const messageId = (bodyJson && (bodyJson.messageId || bodyJson["messageId"])) || "unknown";

        logEmail("email_api_send_ok", { attempt, to, messageId, ms: Date.now() - started });

        return { ok: true, messageId: String(messageId) };
      } catch (err: any) {
        const msg = String(err?.message || err);

        logEmail("email_api_send_attempt_crash", {
          attempt,
          to,
          message: msg,
          code: err?.code,
          ms: Date.now() - started,
        });

        const retryable = /abort/i.test(msg) || /timeout/i.test(msg) || /network/i.test(msg);
        if (retryable && attempt < maxAttempts) {
          await sleep(350);
          continue;
        }

        return { ok: false, error: msg };
      }
    }

    return { ok: false, error: "Email send failed (exhausted retries)" };
  } catch (err: any) {
    const msg = String(err?.message || err);
    logEmail("email_api_crash", { message: msg, code: err?.code, ms: Date.now() - started });
    return { ok: false, error: msg };
  }
}
