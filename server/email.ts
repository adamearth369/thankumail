import SibApiV3Sdk from 'sib-api-v3-sdk';

const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;

const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

export async function sendGiftEmail(recipientEmail: string, claimLink: string, amount: number) {
  if (!process.env.BREVO_API_KEY) {
    console.warn("BREVO_API_KEY not set, skipping email sending");
    return;
  }

  const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
  sendSmtpEmail.subject = "You've got a gift! 🎁";
  sendSmtpEmail.htmlContent = `
    <html>
      <body>
        <h1>You've received a gift from ThanküMail!</h1>
        <p>Someone sent you a digital gift worth <strong>$${(amount / 100).toFixed(2)}</strong>.</p>
        <p>Click the link below to claim it:</p>
        <a href="${claimLink}">${claimLink}</a>
      </body>
    </html>
  `;
  sendSmtpEmail.sender = { "name": "ThanküMail", "email": "noreply@thankumail.com" };
  sendSmtpEmail.to = [{ "email": recipientEmail }];

  try {
    await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log(`Email sent successfully to ${recipientEmail}`);
  } catch (error) {
    console.error("Error sending email via Brevo:", error);
  }
}
