import express, { type Express, type Request, type Response, type NextFunction } from "express";
import path from "path";
import fs from "fs";
import { registerRoutes } from "./routes";

/* -------------------- VERSION -------------------- */
const INDEX_VERSION = "api_index_v2026-02-22_001";
const COMMIT = process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || "";

/* -------------------- APP -------------------- */
const app: Express = express();

app.set("trust proxy", 1);

/* -------------------- COMMIT HEADER -------------------- */
app.use((_req, res, next) => {
  if (COMMIT) res.setHeader("X-Commit", COMMIT);
  res.setHeader("X-Api-Version", INDEX_VERSION);
  next();
});

/* -------------------- CORS -------------------- */
const ALLOWED_ORIGINS = new Set<string>(["https://thankumail.com", "https://www.thankumail.com"]);

function setCors(req: Request, res: Response) {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-user-id, x-admin-token");
    res.setHeader("Access-Control-Max-Age", "600");

    // allow browser JS to read these response headers cross-origin
    res.setHeader("Access-Control-Expose-Headers", "x-commit, x-api-version, X-Commit, X-Api-Version");
  }
}

app.use((req: Request, res: Response, next: NextFunction) => {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

/* -------------------- BODY PARSING -------------------- */
/**
 * Stripe webhook signature verification requires access to the raw request body bytes.
 * We capture raw bytes for ALL application/json requests into req.rawBody.
 */
app.use(
  express.json({
    limit: "1mb",
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: true }));

/* -------------------- HEALTH -------------------- */
app.get("/health", (_req, res) => {
  res.json({ ok: true, indexVersion: INDEX_VERSION, commit: COMMIT });
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

/* -------------------- LISTEN -------------------- */
const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`listening on ${PORT} (${INDEX_VERSION})`);
});