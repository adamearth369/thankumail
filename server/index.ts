import express from "express";
import nodemailer from "nodemailer";

const app = express();

/* BASIC HEALTH CHECK */
app.get("/", (_req, res) => {
  res.send("ThankuMail server is running");
});

/* SMTP TRANSPORT */
const transporter = nodemailer.createTransport({
  host: process.env.BREVO_SMTP_HOST || "smtp-relay.brevo.com",
  port: Number(process.env.BREVO_SMTP_PORT || 587),
  secure: false,
  auth: {
    user: process.env.BREVO_SMTP_USER || "apikey",
    pass: process.env.BREVO_SMTP_KEY,
  },
});

/* EMAIL TEST ENDPOINT */
app.get("/__email_test", async (req, res) => {
  try {
    const to = req.query.to as string;
    if (!to) {
      return res.status(400).send("Missing ?to=email");
    }

    const info = await transporter.sendMail({
      from: `"${process.env.FROM_NAME || "ThankuMail"}" <${process.env.FROM_EMAIL || "noreply@thankumail.com"}>`,
      to,
      subject: "ThankuMail SMTP test",
      text: "If you received this, SMTP works.",
    });

    res.send(`SENT: ${info.messageId}`);
  } catch (err: any) {
    res.status(500).send(err?.message || String(err));
  }
});

/* REQUIRED FOR REPLIT */
const PORT = Number(process.env.PORT) || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
