import express from "express";
import path from "path";
import router from "./routes";

const app = express();

/* -------------------- basics -------------------- */
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

/**
 * Public assets are emitted to dist/public by script/build.ts.
 * Keep this CJS-safe (no import.meta usage).
 */
const publicDir = path.resolve(process.cwd(), "dist", "public");

/* -------------------- debug /where (JSON) -------------------- */
app.get("/__where", (_req, res) => {
  res.json({
    ok: true,
    nodeEnv: process.env.NODE_ENV,
    cwd: process.cwd(),
    publicDir,
  });
});

/* -------------------- health (JSON) -------------------- */
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/api/health", (_req, res) => res.json({ ok: true }));

/* -------------------- API routes FIRST -------------------- */
app.use(router);

/* -------------------- static + SPA fallback (LAST) -------------------- */
app.use(
  express.static(publicDir, {
    index: false,
    maxAge: "1h",
  })
);

// Never serve SPA for API paths (return JSON 404 instead)
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
