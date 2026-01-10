import express from "express";
import cors from "cors";
import path from "path";
import { createServer } from "http";

import { registerRoutes } from "./routes";

const app = express();

// Change this string any time you want to prove a deploy changed
const INDEX_MARKER = "INDEX_MARKER_v2_2026-01-10";

/* -------------------- middleware -------------------- */
app.use(cors());
app.use(express.json());

/* -------------------- start -------------------- */
async function main() {
  const httpServer = createServer(app);

  // Register API routes FIRST
  await registerRoutes(httpServer, app);

  // Force /health to include an index marker so we can prove THIS file is deployed
  // (This will override earlier /health handlers if any exist.)
  app.get(["/health", "/__health"], (_req, res) => {
    res.json({
      ok: true,
      marker:
        process.env.DEPLOY_MARKER ||
        process.env.MARKER ||
        "IDX_v3_entryfix_2026-01-09",
      indexMarker: INDEX_MARKER,
    });
  });

  // IMPORTANT: Never serve SPA for /api/*
  // If an /api route doesn't match, return JSON 404 (not index.html).
  app.all("/api/*", (req, res) => {
    res.status(404).json({ message: "Not found" });
  });

  /* -------------------- static + spa fallback -------------------- */
  // NOTE: dist/index.cjs lives in dist/, so __dirname === dist at runtime
  const publicDir = path.join(__dirname, "public");

  // Static assets
  app.use(express.static(publicDir));

  // SPA fallback (must be LAST)
  app.get("*", (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });

  const PORT = process.env.PORT || 10000;
  httpServer.listen(PORT, () => {
    console.log(
      `ThankuMail server running on port ${PORT} (${process.env.DEPLOY_MARKER || "IDX_v3_entryfix_2026-01-09"})`,
    );
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
