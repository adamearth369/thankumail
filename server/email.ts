import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.BREVO_SMTP_HOST || 'smtp-relay.brevo.com',
  port: parseInt(process.env.BREVO_SMTP_PORT || '587'),
  secure: false,
  auth: {
    user: process.env.BREVO_SMTP_USER || process.env.BREVO_EMAIL,
    pass: process.env.BREVO_SMTP_KEY
  },
  tls: {
    rejectUnauthorized: false
  }
});

export async function sendGiftEmail(recipientEmail: string, claimLink: string, amount: number, message?: string) {
  const fromEmail = process.env.FROM_EMAIL || process.env.BREVO_EMAIL;
  const fromName = process.env.FROM_NAME || "ThanküMail";
  
  if (!fromEmail || !process.env.BREVO_SMTP_KEY) {
    console.warn("Email credentials missing, skipping email sending");
    return;
  }

  const amountFormatted = (amount / 100).toFixed(2);
  const mailOptions = {
    from: `"${fromName}" <${fromEmail}>`,
    to: recipientEmail,
    subject: 'You have a gift waiting 🎁',
    text: `You received an anonymous gift of $${amountFormatted}.

${message ? `Message:
"${message}"` : ''}

Claim it here:
${claimLink}`,
    html: `
      <h2>You received a gift 🎁</h2>
      <p><strong>Amount:</strong> $${amountFormatted}</p>
      ${message ? `<p><strong>Message:</strong></p><p>${message}</p>` : ''}
      <p><a href="${claimLink}">👉 Claim your gift</a></p>
    `
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`Email sent successfully: ${info.messageId}`);
  } catch (error) {
    console.error("Error sending email via nodemailer:", error);
  }
}
