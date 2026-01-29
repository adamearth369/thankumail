// WHERE TO PASTE: server/index.ts
// ACTION: Full file replacement (paste exactly)

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { registerRoutes } from "./routes";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_VERSION = "api_index_v2026-01-28_001";

function log(event: string, fields: Record<string, any> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

process.on("uncaughtException", (err) => {
  console.error("uncaughtException", err);
});
process.on("unhandledRejection", (err) => {
  console.error("unhandledRejection", err);
});

const app = express();

// Render/Proxy friendly
app.set("trust proxy", 1);

// Body parsing
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Register API routes FIRST
registerRoutes(app);

// Health root (useful when static is miswired)
app.get("/health", (_req, res) => res.json({ ok: true, app: APP_VERSION }));

// Serve built client (dist/public)
const publicDir = path.resolve(__dirname, "..", "dist", "public");
app.use(express.static(publicDir));

// SPA fallback for non-API GETs
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(publicDir, "index.html"));
});

// Bind to Render port
const port = Number(process.env.PORT || 5000);
app.listen(port, "0.0.0.0", () => {
  log("listening", { port, app: APP_VERSION });
});
