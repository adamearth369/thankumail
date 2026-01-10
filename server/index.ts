import express from "express";
import cors from "cors";
import path from "path";
import { createServer } from "http";

import { registerRoutes } from "./routes";

const app = express();

/* -------------------- middleware -------------------- */
app.use(cors());
app.use(express.json());

/* -------------------- start -------------------- */
async function main() {
  const httpServer = createServer(app);

  // Register API routes FIRST
  await registerRoutes(httpServer, app);

  // IMPORTANT: Never serve SPA for /api/*
  // If an /api route doesn't match, return JSON 404 (not index.html).
  app.all("/api/*", (req, res) => {
    res.status(404).json({ message: "Not found" });
  });

  /* -------------------- static + spa fallback -------------------- */
  // NOTE: dist/index.cjs lives in dist/, so __dirname === dist at runtime
  const publicDir = path.join(__dirname, "public");
  app.use(express.static(publicDir));

  // SPA fallback (must be LAST)
  app.get("*", (req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });

  const PORT = process.env.PORT || 10000;
  httpServer.listen(PORT, () => {
    console.log(`ThankuMail server running on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
