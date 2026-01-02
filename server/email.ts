import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: 'smtp-relay.brevo.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.BREVO_EMAIL,
    pass: process.env.BREVO_SMTP_KEY || process.env.BREVO_API_KEY
  }
});

export async function sendGiftEmail(recipientEmail: string, claimLink: string, amount: number) {
  if (!process.env.BREVO_EMAIL || !(process.env.BREVO_SMTP_KEY || process.env.BREVO_API_KEY)) {
    console.warn("Email credentials missing, skipping email sending");
    return;
  }

  const mailOptions = {
    from: `"ThanküMail" <${process.env.BREVO_EMAIL}>`,
    to: recipientEmail,
    subject: "You've got a gift! 🎁",
    html: `
      <html>
        <body style="font-family: sans-serif; line-height: 1.6; color: #333;">
          <div style="max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
            <h1 style="color: #7c3aed; margin-top: 0;">You've received a gift from ThanküMail!</h1>
            <p>Someone sent you a digital gift worth <strong>$${(amount / 100).toFixed(2)}</strong>.</p>
            <p>Click the button below to claim it:</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${claimLink}" style="background-color: #7c3aed; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Claim Your Gift</a>
            </div>
            <p style="font-size: 0.875rem; color: #64748b;">If the button doesn't work, copy and paste this link into your browser:</p>
            <p style="font-size: 0.875rem; word-break: break-all;"><a href="${claimLink}">${claimLink}</a></p>
          </div>
        </body>
      </html>
    `
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`Email sent successfully: ${info.messageId}`);
  } catch (error) {
    console.error("Error sending email via nodemailer:", error);
  }
}
