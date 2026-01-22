import express from "express";
import cors from "cors";
import path from "path";
import { registerRoutes } from "./routes";

const app = express();

/* -------------------- proxy + basics -------------------- */
app.set("trust proxy", 1); // Render sets X-Forwarded-* headers
app.disable("x-powered-by");

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

/* -------------------- CORS (for UI -> API cross-domain) -------------------- */
app.use(
  cors({
    origin: true, // reflect request origin
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-admin-token"],
  })
);
// handle preflight
app.options("*", cors());

/* -------------------- paths -------------------- */
const publicDir = path.resolve(process.cwd(), "dist", "public");

/* -------------------- debug /where -------------------- */
app.get("/__where", (_req, res) => {
  res.json({
    ok: true,
    nodeEnv: process.env.NODE_ENV,
    cwd: process.cwd(),
    publicDir,
  });
});

/* -------------------- health -------------------- */
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/api/health", (_req, res) => res.json({ ok: true }));

/* -------------------- API routes FIRST -------------------- */
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
  console.log(`listening on ${port}`);
});
