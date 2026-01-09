import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";

import { registerRoutes } from "../server/routes";

const app = express();

app.use(cors());
app.use(express.json());

const publicDir = path.join(__dirname, "public");
const indexPath = path.join(publicDir, "index.html");

// Serve static assets
app.use(express.static(publicDir));

// Diagnostics (always available)
app.get("/__where", (req, res) => {
  res.json({
    __dirname,
    publicDir,
    indexPath,
    publicDirExists: fs.existsSync(publicDir),
    indexExists: fs.existsSync(indexPath),
    renderCommit: process.env.RENDER_GIT_COMMIT || null,
  });
});

async function main() {
  // Register API routes FIRST
  await registerRoutes({} as any, app as any);

  // Health routes AFTER registerRoutes, BEFORE SPA fallback (cannot be swallowed)
  app.get("/health", (req, res) => res.json({ ok: true }));
  app.get("/__health", (req, res) => res.json({ ok: true }));

  // SPA fallback LAST
  app.get("*", (req, res) => {
    if (!fs.existsSync(indexPath)) {
      return res.status(500).send("Frontend not built yet (missing dist/public/index.html).");
    }
    return res.sendFile(indexPath);
  });

  const PORT = process.env.PORT || 10000;
  app.listen(PORT, () => console.log(`ThankuMail server running on port ${PORT}`));
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
