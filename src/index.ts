import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";

import { registerRoutes } from "./server/routes";
import { sendGiftEmail } from "./server/email";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);

app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 5000);
const BASE_URL = process.env.BASE_URL || "https://thankumail.onrender.com";
const DEBUG_TOKEN = process.env.DEBUG_ROUTES_TOKEN || "";

/* ---------------------------------------------------
   🔒 DEBUG ROUTE GUARD
--------------------------------------------------- */
function debugGuard(req: express.Request, res: express.Response): boolean {
  const token = String(req.query.token ?? "");
  if (!DEBUG_TOKEN || token !== DEBUG_TOKEN) {
    res.status(404).type("text/plain").send("Not found");
    return false;
  }
  return true;
}

/* ---------------------------------------------------
   🔍 DEBUG ROUTES (TOKEN REQUIRED)
--------------------------------------------------- */

app.get("/__marker", (req, res) => {
  if (!debugGuard(req, res)) return;
  res.type("text/plain").send("IDX_v2_emailtest_2026-01-09_17:40");
});

app.get("/__where", (req, res) => {
  if (!debugGuard(req, res)) return;

  const publicDir = path.join(__dirname, "public");
  const indexPath = path.join(publicDir, "index.html");

  res.json({
    cwd: process.cwd(),
    publicDir,
    indexPath,
    publicDirExists: true,
    indexExists: true,
    renderCommit: process.env.RENDER_GIT_COMMIT || "unknown",
  });
});

app.get("/__email_test", async (req, res) => {
  if (!debugGuard(req, res)) return;

  const to = String(req.query.to ?? "").trim();
  if (!to || !to.includes("@")) {
    return res
      .status(400)
      .type("text/plain")
      .send("BAD_REQUEST: provide ?to=email@example.com");
  }

  try {
    const result = await sendGiftEmail({
      to,
      claimLink: `${BASE_URL}/claim/demo`,
      message: "If you received this, Brevo API sending works.",
      amountCents: 1000,
    });

    res.type("text/plain").send(`SENT_OK: ${JSON.stringify(result)}`);
  } catch (err: any) {
    res
      .status(500)
      .type("text/plain")
      .send(`EMAIL_TEST_ERROR: ${err?.message || String(err)}`);
  }
});

/* ---------------------------------------------------
   ❤️ HEALTH
--------------------------------------------------- */
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/__health", (_req, res) => {
  res.json({ ok: true });
});

/* ---------------------------------------------------
   🚀 API ROUTES
--------------------------------------------------- */
registerRoutes(server, app);

/* ---------------------------------------------------
   🌐 STATIC FRONTEND
--------------------------------------------------- */
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

/* ---------------------------------------------------
   ▶️ START SERVER
--------------------------------------------------- */
server.listen(PORT, () => {
  console.log(`ThankuMail server running on port ${PORT}`);
});
