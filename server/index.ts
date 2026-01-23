import express from "express";
import path from "path";
import { registerRoutes } from "./routes";

const app = express();

/* -------------------- VERSION MARKER -------------------- */
const API_VERSION = "api_index_v2026-01-23_002";

/* -------------------- proxy + basics -------------------- */
app.set("trust proxy", 1); // required for Render + express-rate-limit
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

/* -------------------- CORS (UI -> API preview) -------------------- */
const ALLOWED = new Set(["https://thankumail-ui.onrender.com", "https://thankumail.com"]);

app.use((req, res, next) => {
  const origin = String(req.headers.origin || "");
  if (origin && ALLOWED.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-admin-token");
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

/* -------------------- debug /__where -------------------- */
const publicDir = path.resolve(process.cwd(), "dist", "public");
app.get("/__where", (_req, res) => {
  res.json({
    ok: true,
    version: API_VERSION,
    nodeEnv: process.env.NODE_ENV,
    cwd: process.cwd(),
    publicDir,
  });
});

/* -------------------- health (non-api) -------------------- */
app.get("/health", (_req, res) => res.json({ ok: true, version: API_VERSION }));

/* -------------------- SERVER-AUTH PRICING GUARD -------------------- */
/**
 * Forces amount to server minimum BEFORE hitting /api/gifts.
 */
const MIN_AMOUNT_CENTS = 1000;
app.use((req, _res, next) => {
  if (req.method === "POST" && req.path === "/api/gifts") {
    if (req.body && typeof req.body === "object") {
      req.body.amount = MIN_AMOUNT_CENTS;
    }
  }
  next();
});

/* -------------------- API routes FIRST -------------------- */
/**
 * IMPORTANT:
 * Do NOT define /api/version or /api/health here.
 * routes.ts owns /api/version and /api/health so they reflect ROUTES_VERSION.
 */
registerRoutes(app);

/* -------------------- static + SPA fallback (LAST) -------------------- */
app.use(
  express.static(publicDir, {
    index: false,
    maxAge: "1h",
  })
);

// Never serve SPA for API paths
app.get(/^\/api\/.*/, (_req, res) => {
  res.status(404).json({ message: "Not found" });
});

// SPA fallback for everything else
app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

/* -------------------- listen -------------------- */
const port = Number(process.env.PORT || 10000);
app.listen(port, "0.0.0.0", () => {
  console.log(`listening on ${port} (${API_VERSION})`);
});
