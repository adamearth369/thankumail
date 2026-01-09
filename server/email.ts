import brevo from "@getbrevo/brevo";

/**
 * Sends a gift email via Brevo Transactional Email API.
 * Uses these env vars (Render + Replit Secrets):
 * - BREVO_API_KEY   (required)
 * - FROM_EMAIL      (required)
 * - FROM_NAME       (optional)
 */
export async function sendGiftEmail(
  to: string,
  claimLink: string,
  amountCents: number,
  message: string
) {
  const apiKey = process.env.BREVO_API_KEY || "";
  const fromEmail = process.env.FROM_EMAIL || "";
  const fromName = process.env.FROM_NAME || "ThankuMail";

  if (!apiKey) throw new Error("Missing BREVO_API_KEY");
  if (!fromEmail) throw new Error("Missing FROM_EMAIL");

  const amount = `$${(Number(amountCents || 0) / 100).toFixed(2)}`;

  const subject = `You received a ThankuMail gift (${amount})`;

  // Plain text (safe, deliverability-friendly)
  const textContent =
    `You received a ThankuMail gift.\n\n` +
    `Claim it here:\n${claimLink}\n\n` +
    `Message:\n${(message || "").trim() || "(no message)"}\n`;

  // HTML (simple, safe)
  const htmlContent = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.5;color:#111;">
      <h2 style="margin:0 0 12px;">You received a ThankuMail gift (${amount})</h2>
      <p style="margin:0 0 12px;">Click below to claim it:</p>
      <p style="margin:0 0 16px;">
        <a href="${claimLink}" style="display:inline-block;padding:10px 14px;border-radius:10px;background:#7c3aed;color:#fff;text-decoration:none;font-weight:700;">
          Claim your gift
        </a>
      </p>
      <p style="margin:0 0 8px;"><strong>Message:</strong></p>
      <div style="padding:12px;border:1px solid #eee;border-radius:12px;background:#fafafa;">
        ${(message || "").trim() ? (message || "").trim().replace(/</g, "&lt;").replace(/>/g, "&gt;") : "(no message)"}
      </div>
      <p style="margin:16px 0 0;color:#666;font-size:12px;">
        If you did not expect this email, you can ignore it.
      </p>
    </div>
  `;

  const client = brevo.ApiClient.instance;
  client.authentications["api-key"].apiKey = apiKey;

  const apiInstance = new brevo.TransactionalEmailsApi();

  await apiInstance.sendTransacEmail({
    sender: { email: fromEmail, name: fromName },
    to: [{ email: to }],
    subject,
    textContent,
    htmlContent,
  });
}
