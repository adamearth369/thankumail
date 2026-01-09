import express from "express";
import cors from "cors";
import path from "path";
import { createServer } from "http";

import { registerRoutes } from "../server/routes";

const app = express();

app.set("trust proxy", 1);

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

const publicDir = path.join(process.cwd(), "dist", "public");
const indexPath = path.join(publicDir, "index.html");

app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/__health", (_req, res) => res.json({ ok: true }));

app.get("/__where", (_req, res) => {
  res.json({
    cwd: process.cwd(),
    publicDir,
    indexPath,
    publicDirExists: require("fs").existsSync(publicDir),
    indexExists: require("fs").existsSync(indexPath),
    renderCommit: process.env.RENDER_GIT_COMMIT || null,
  });
});

app.get("/__email_test", async (req, res) => {
  try {
    const to = String(req.query.to || "");
    if (!to) return res.status(400).send("Missing ?to=email");

    const apiKey = process.env.BREVO_API_KEY || "";
    if (!apiKey) return res.status(500).send("Missing BREVO_API_KEY");

    const senderEmail = process.env.FROM_EMAIL || "noreply@thankumail.com";
    const senderName = process.env.FROM_NAME || "ThankuMail";

    const r = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "api-key": apiKey,
      },
      body: JSON.stringify({
        sender: { name: senderName, email: senderEmail },
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

app.use(express.static(publicDir));

const httpServer = createServer(app);

async function main() {
  try {
    await registerRoutes(httpServer, app);
  } catch (e) {
    console.error("registerRoutes failed:", e);
  }

  // IMPORTANT: don't let SPA fallback swallow /api or /__ routes
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api") || req.path.startsWith("/__")) return next();
    return res.sendFile(indexPath);
  });

  const port = Number(process.env.PORT || 5000);
  httpServer.listen(port, "0.0.0.0", () => {
    console.log(`ThankuMail server running on port ${port}`);
  });
}

main();
