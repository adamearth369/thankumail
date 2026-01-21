import express from "express";
import path from "path";

const app = express();

/* ✅ REQUIRED on Render (fixes express-rate-limit crash with X-Forwarded-For) */
app.set("trust proxy", 1);

/* -------------------- basics -------------------- */
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

/**
 * Public assets are emitted to dist/public by script/build.ts.
 * This must work in BOTH dev and production builds.
 */
const publicDir = path.resolve(process.cwd(), "dist", "public");

/* -------------------- debug /__where -------------------- */
app.get("/__where", (_req, res) => {
  res.json({
    ok: true,
    nodeEnv: process.env.NODE_ENV,
    cwd: process.cwd(),
    publicDir,
  });
});

/* -------------------- health (non-spa) -------------------- */
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/api/health", (_req, res) => res.json({ ok: true }));

/* -------------------- API routes FIRST -------------------- */
async function main() {
  const mod = await import("./routes");
  const router = mod.default; // routes.ts exports default router
  app.use(router);

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
}

main().catch((e) => {
  console.error("Fatal boot error:", e);
  process.exit(1);
});
