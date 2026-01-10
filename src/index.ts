import express from "express";
import path from "path";
import http from "http";
import cors from "cors";

import { registerRoutes } from "../server/routes";
import { sendGiftEmail } from "../server/email";

const app = express();

// ---- middleware ----
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// ---- marker (optional) ----
const MARKER = process.env.MARKER || "IDX_v3_entryfix_2026-01-09";

// ---- health routes ----
app.get("/health", (_req, res) => res.json({ ok: true, marker: MARKER }));
app.get("/__health", (_req, res) => res.json({ ok: true, marker: MARKER }));

// ---- debug routes gating ----
function debugAllowed(req: express.Request) {
  // In production: require token
  const token = process.env.DEBUG_ROUTES_TOKEN;
  if (process.env.NODE_ENV === "production") {
    if (!token) return false;
    const q = String(req.query.token || "");
    return q === token;
  }
  // Non-production: allow
  return true;
}

// __marker (debug)
app.get("/__marker", (req, res) => {
  if (!debugAllowed(req)) return res.status(404).send("Not found");
  res.type("text/plain").send(MARKER);
});

// __where (debug)
app.get("/__where", (req, res) => {
  if (!debugAllowed(req)) return res.status(404).send("Not found");

  const publicDir = path.join(__dirname, "public");
  const indexPath = path.join(publicDir, "index.html");

  res.json({
    marker: MARKER,
    __dirname,
    cwd: process.cwd(),
    publicDir,
    indexPath,
    publicDirExists: safeExists(publicDir),
    indexExists: safeExists(indexPath),
    renderCommit:
      process.env.RENDER_GIT_COMMIT ||
      process.env.RENDER_COMMIT ||
      process.env.GIT_COMMIT ||
      null,
  });
});

// __email_test (debug)
app.get("/__email_test", async (req, res) => {
  if (!debugAllowed(req)) return res.status(404).send("Not found");

  const to = String(req.query.to || "");
  if (!to || !to.includes("@")) {
    return res
      .status(400)
      .type("text/plain")
      .send(
        'BREVO_API_ERROR 400: {"code":"invalid_parameter","message":"email is not valid in to"}',
      );
  }

  try {
    // Minimal smoke-test using your existing email sender
    const out = await sendGiftEmail({
      to,
      claimLink: "/claim/demo-email-test",
      message: "If you received this, Brevo API sending works.",
      amountCents: 1000,
    });

    res.type("text/plain").send(`SENT_OK: ${JSON.stringify(out)}`);
  } catch (err: any) {
    res
      .status(500)
      .type("text/plain")
      .send(`SENT_FAIL: ${err?.message || String(err)}`);
  }
});

// ---- server routes ----
const httpServer = http.createServer(app);
registerRoutes(httpServer, app).catch((err) => {
  console.error("registerRoutes failed", err);
});

// ---- static + SPA fallback ----
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir, { maxAge: 0 }));

app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

const port = Number(process.env.PORT) || 5000;
httpServer.listen(port, "0.0.0.0", () => {
  console.log(`ThankuMail server running on port ${port} (${MARKER})`);
});

function safeExists(p: string) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("fs");
    return fs.existsSync(p);
  } catch {
    return false;
  }
}
