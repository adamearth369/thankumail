import express from "express";
import cors from "cors";
import path from "path";
import { createServer } from "http";

import { registerRoutes } from "./routes";

const app = express();

// Bump this anytime to prove deploy updated
const INDEX_MARKER = "INDEX_MARKER_v3_2026-01-10";

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

  // Health marker to prove THIS src/index.ts is deployed/bundled
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

  // Hard rule: /api must never serve the SPA
  // Covers: /api, /api/, /api/anything...
  app.all("/api", (_req, res) =>
    res.status(404).json({ message: "Not found" }),
  );
  app.all("/api/*", (_req, res) =>
    res.status(404).json({ message: "Not found" }),
  );

  // Now mount static + SPA fallback
  mountStaticAndSpa(app);

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
