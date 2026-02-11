import express, { type Express, type Request, type Response, type NextFunction } from "express";
import path from "path";
import fs from "fs";
import { registerRoutes } from "./routes";

/* -------------------- VERSION -------------------- */
const INDEX_VERSION = "api_index_v2026-02-11_001";

/* -------------------- APP -------------------- */
const app: Express = express();

// Trust proxy so x-forwarded-* works behind Render/Cloudflare
app.set("trust proxy", 1);

/* -------------------- CORS (THANKUMAIL.COM -> API) -------------------- */
const ALLOWED_ORIGINS = new Set<string>(["https://thankumail.com", "https://www.thankumail.com"]);

app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-token");
  }

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  next();
});

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

/* -------------------- HEALTH -------------------- */
app.get("/health", (_req, res) => {
  res.json({ ok: true, indexVersion: INDEX_VERSION });
});

/* -------------------- API ROUTES FIRST -------------------- */
registerRoutes(app);

/* -------------------- STATIC + SPA FALLBACK -------------------- */
const publicDir = path.join(process.cwd(), "dist", "public");
const indexHtml = path.join(publicDir, "index.html");

if (fs.existsSync(publicDir)) {
  app.use(
    express.static(publicDir, {
      index: false,
      maxAge: "1h",
      etag: true,
    }),
  );
}

// SPA fallback (NEVER for /api/*)
app.get("*", (req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith("/api/")) return next();
  if (req.path === "/health") return next();

  if (fs.existsSync(indexHtml)) return res.sendFile(indexHtml);
  return res.status(404).send("Not found");
});

/* -------------------- ERROR HANDLER -------------------- */
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("unhandled_error", err?.stack || err);
  res.status(500).json({ ok: false, error: "Server error", indexVersion: INDEX_VERSION });
});

/* -------------------- LISTEN (RENDER) -------------------- */
const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`listening on ${PORT} (${INDEX_VERSION})`);
});
