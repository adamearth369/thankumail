  // WHERE TO PASTE: server/index.ts
  // ACTION: Full file replacement (paste exactly)

  import express, { type Express, type Request, type Response, type NextFunction } from "express";
  import path from "path";
  import fs from "fs";
  import { registerRoutes } from "./routes";

  /* -------------------- VERSION -------------------- */
  const INDEX_VERSION = "api_index_v2026-01-29_004";

  /* -------------------- APP -------------------- */
  const app: Express = express();

  // Trust proxy so x-forwarded-* works behind Render/Cloudflare
  app.set("trust proxy", 1);

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true }));

  /* -------------------- HEALTH -------------------- */
  app.get("/health", (_req, res) => {
    res.json({ ok: true, indexVersion: INDEX_VERSION });
  });

  /* -------------------- API ROUTES FIRST -------------------- */
  const httpServer = registerRoutes(app);

  /* -------------------- STATIC + SPA FALLBACK -------------------- */
  // IMPORTANT: do NOT use import.meta.url / fileURLToPath (breaks under CJS bundles)
  // Use process.cwd() so it works on Render.
  const publicDir = path.join(process.cwd(), "dist", "public");
  const indexHtml = path.join(publicDir, "index.html");

  if (fs.existsSync(publicDir)) {
    app.use(
      express.static(publicDir, {
        index: false, // we control SPA fallback below
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
  const PORT = Number(process.env.PORT || 5000);
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`listening on ${PORT} (${INDEX_VERSION})`);
  });
