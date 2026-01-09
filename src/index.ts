import express from "express";
import cors from "cors";
import path from "path";
import { existsSync } from "fs";
import { createServer } from "http";
import { registerRoutes } from "../server/routes";

/**
 * DEBUG ROUTES POLICY
 * - In production: DISABLED by default
 * - Enable explicitly by setting ENABLE_DEBUG_ROUTES="true"
 */
const IS_PROD = process.env.NODE_ENV === "production";
const DEBUG_ENABLED = !IS_PROD || process.env.ENABLE_DEBUG_ROUTES === "true";

const MARKER =
  process.env.__MARKER ||
  `IDX_v2_emailtest_${new Date().toISOString().slice(0, 10)}_${new Date()
    .toISOString()
    .slice(11, 16)
    .replace(":", "-")}`;

async function main() {
  const app = express();

  // Trust proxy so x-forwarded-proto/host works behind Render/Cloudflare
  app.set("trust proxy", 1);

  // JSON + CORS
  app.use(express.json({ limit: "1mb" }));
  app.use(
    cors({
      origin: "*",
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    }),
  );

  // Health endpoints (always available)
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/__health", (_req, res) => res.json({ ok: true }));

  const httpServer = createServer(app);

  // Register API routes
  await registerRoutes(httpServer, app);

  // Static public directory (built by Vite into dist/public)
  const cwd = process.cwd(); // on Render: /opt/render/project/src
  const publicDir = path.join(cwd, "dist", "public");
  const indexPath = path.join(publicDir, "index.html");

  // Debug endpoints (locked down in production unless ENABLE_DEBUG_ROUTES=true)
  if (DEBUG_ENABLED) {
    app.get("/__marker", (_req, res) => res.type("text/plain").send(MARKER));

    app.get("/__where", (_req, res) => {
      res.json({
        marker: MARKER,
        cwd,
        publicDir,
        indexPath,
        publicDirExists: existsSync(publicDir),
        indexExists: existsSync(indexPath),
        renderCommit: process.env.RENDER_GIT_COMMIT || null,
        nodeEnv: process.env.NODE_ENV || null,
      });
    });

    // Brevo API send test (NOT SMTP) — only enabled when DEBUG_ENABLED
    app.get("/__email_test", async (req, res) => {
      try {
        const to = String(req.query.to ?? "").trim();

        // basic sanity validation (fast + prevents Brevo 400 spam)
        if (!to || !to.includes("@") || to.startsWith("YOUR_EMAIL")) {
          return res
            .status(400)
            .type("text/plain")
            .send("BAD_REQUEST: provide a valid ?to=email@example.com");
        }

        const result = await sendGiftEmail({
          to,
          claimLink: `${process.env.BASE_URL || "https://thankumail.onrender.com"}/claim/demo`,
          message: "If you received this, Brevo API sending works.",
          amountCents: 1000,
        });

        return res
          .status(200)
          .type("text/plain")
          .send(`SENT_OK: ${JSON.stringify(result)}`);
      } catch (e: any) {
        return res
          .status(500)
          .type("text/plain")
          .send(`EMAIL_TEST_ERROR: ${e?.message || String(e)}`);
      }
    });

    // In production, hide these routes unless explicitly enabled
    app.get(["/__marker", "/__where", "/__email_test"], (_req, res) =>
      res.status(404).send("Not found"),
    );
  }

  // Serve static + SPA fallback
  if (existsSync(publicDir) && existsSync(indexPath)) {
    app.use(express.static(publicDir));

    // SPA fallback (must be after APIs and static)
    app.get("*", (req, res) => {
      // Never hijack API routes
      if (req.path.startsWith("/api")) return res.status(404).send("Not found");
      res.sendFile(indexPath);
    });
  }

  const port = Number(process.env.PORT || 5000);
  httpServer.listen(port, "0.0.0.0", () => {
    console.log(`ThankuMail server running on port ${port} (${MARKER})`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
