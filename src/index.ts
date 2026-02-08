import express from "express";
import cors from "cors";
import path from "path";
import { createServer } from "http";

import apiRouter from "../server/routes";
import { ensureTables } from "../server/db";

const app = express();

// IMPORTANT for Render / proxies so req.ip works correctly (rate limiting)
app.set("trust proxy", 1);

/* -------------------- middleware -------------------- */
app.use(cors());
app.use(express.json());

/* -------------------- API routes FIRST -------------------- */
app.use(apiRouter);

// Hard rule: /api must never serve the SPA fallback
app.all("/api", (_req, res) => res.status(404).json({ message: "Not found" }));
app.all("/api/*", (_req, res) => res.status(404).json({ message: "Not found" }));

function mountStaticAndSpa(app: express.Express) {
  // dist/public (client build output)
  const publicDir = path.join(process.cwd(), "dist", "public");

  // Static assets
  app.use(express.static(publicDir));

  // SPA fallback LAST
  app.get("*", (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });
}

async function main() {
  await ensureTables();

  // Mount static + SPA fallback AFTER API
  mountStaticAndSpa(app);

  const httpServer = createServer(app);
  const PORT = process.env.PORT || 10000;

  httpServer.listen(PORT, () => {
    console.log(`thankÜmail server running on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
