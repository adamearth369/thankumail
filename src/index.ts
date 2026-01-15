import express from "express";
import cors from "cors";
import path from "path";
import { createServer } from "http";

// Import the default router from server/routes.ts
import apiRouter from "../server/routes";

const app = express();

// IMPORTANT for Render / proxies so req.ip works correctly (rate limiting)
app.set("trust proxy", 1);

/* -------------------- middleware -------------------- */
app.use(cors());
app.use(express.json());

// Register ALL API routes first (no SPA interference)
app.use(apiRouter);

// Hard rule: /api must never serve the SPA fallback
app.all("/api", (_req, res) => res.status(404).json({ message: "Not found" }));
app.all("/api/*", (_req, res) => res.status(404).json({ message: "Not found" }));

function mountStaticAndSpa(app: express.Express) {
  // In the built server, __dirname points to dist/ and client outputs to dist/public
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
