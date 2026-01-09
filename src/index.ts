import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";

import { registerRoutes } from "../server/routes";

const app = express();

/* -------------------- middleware -------------------- */
app.use(cors());
app.use(express.json());

/* -------------------- static + spa fallback -------------------- */
/**
 * IMPORTANT:
 * When bundled, this file becomes dist/index.cjs.
 * At runtime, __dirname === /opt/render/project/src/dist
 * Built client lives in dist/public/*
 */
const publicDir = path.join(__dirname, "public");
const indexPath = path.join(publicDir, "index.html");

// Serve static assets if they exist
app.use(express.static(publicDir));

// Helpful diagnostics
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

// If the frontend isn't built, return a clear message (prevents confusing 404s)
app.get("/__frontend", (req, res) => {
  if (!fs.existsSync(indexPath)) {
    return res
      .status(500)
      .send(
        "Frontend not built yet (missing dist/public/index.html). Fix Render build to generate it.",
      );
  }
  return res.sendFile(indexPath);
});

async function main() {
  // Register API routes
  // NOTE: registerRoutes signature in your code is (httpServer, app)
  // but it only uses app; pass a dummy server as any to keep it simple.
  await registerRoutes({} as any, app as any);

  // SPA fallback (only if built)
  app.get("*", (req, res) => {
    if (!fs.existsSync(indexPath)) {
      return res
        .status(500)
        .send(
          "Frontend not built yet (missing dist/public/index.html). Fix Render build to generate it.",
        );
    }
    return res.sendFile(indexPath);
  });

  const PORT = process.env.PORT || 10000;
  app.listen(PORT, () => {
    console.log(`ThankuMail server running on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
