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
  secure: Number(process.env.BREVO_SMTP_PORT) === 465,
  auth: {
    user: process.env.BREVO_SMTP_USER || "apikey",
    pass: process.env.BREVO_SMTP_KEY,
  },
  tls: {
    rejectUnauthorized: false
  }
});

/* EMAIL TEST ENDPOINT */
app.get("/app.get("/__email_test", async (req, res) => {
  try {
    const to = String(req.query.to || "");
    if (!to) return res.status(400).send("Missing ?to=email");

    const r = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "api-key": process.env.BREVO_API_KEY || "",
      },
      body: JSON.stringify({
        sender: {
          name: process.env.FROM_NAME || "ThankuMail",
          email: process.env.FROM_EMAIL || "noreply@thankumail.com",
        },
        to: [{ email: to }],
        subject: "ThankuMail API test",
        textContent: "If you received this, Brevo API sending works.",
      }),
    });

    const body = await r.text();
    if (!r.ok) return res.status(500).send(`BREVO_API_ERROR ${r.status}: ${body}`);

    return res.send(`SENT_OK: ${body}`);
  } catch (e: any) {
    return res.status(500).send(String(e?.message || e));
  }
});



/* REQUIRED FOR REPLIT */
const PORT = Number(process.env.PORT) || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
