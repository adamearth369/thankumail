import express from "express";
import cors from "cors";
import path from "path";
import { createServer } from "http";

// NOTE: routes live in server/, not src/
import { registerRoutes } from "../server/routes";

const app = express();

// IMPORTANT for Render / proxies so req.ip works correctly (rate limiting)
app.set("trust proxy", 1);

/* -------------------- middleware -------------------- */
app.use(cors());
app.use(express.json());

function mountStaticAndSpa(app: express.Express) {
  // dist/index.cjs lives in dist/, and client build outputs to dist/public
  const publicDir = path.join(__dirname, "public");

  // Static assets
  app.use(express.static(publicDir));

  // SPA fallback LAST
  app.get("*", (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });
}

async function main() {
  const httpServer = createServer(app);

  // Register ALL API routes first
  await registerRoutes(httpServer, app);

  // Hard rule: /api must never serve the SPA
  // Covers: /api, /api/, /api/anything...
  app.all("/api", (_req, res) => res.status(404).json({ message: "Not found" }));
  app.all("/api/*", (_req, res) => res.status(404).json({ message: "Not found" }));

  // Now mount static + SPA fallback
  mountStaticAndSpa(app);

  const PORT = process.env.PORT || 10000;
  httpServer.listen(PORT, () => {
    console.log(`ThankuMail server running on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
