import express, { type Request, Response, NextFunction } from "express";
import { createServer } from "http";
import { registerRoutes } from "./routes";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Log API requests (only /api to reduce noise)
app.use((req, res, next) => {
  const start = Date.now();
  const reqPath = req.path;
  let resBody: any = undefined;

  const originalResJson = res.json.bind(res);
  res.json = function (body: any) {
    resBody = body;
    return originalResJson(body);
  } as any;

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (reqPath.startsWith("/api")) {
      let logLine = `${req.method} ${reqPath} ${res.statusCode} in ${duration}ms`;
      if (resBody !== undefined) logLine += ` :: ${JSON.stringify(resBody)}`;
      if (logLine.length > 180) logLine = logLine.slice(0, 177) + "...";
      console.log(logLine);
    }
  });

  next();
});

(async () => {
  // Create HTTP server + register API routes
  const server = await registerRoutes(createServer(app), app);

  // Built frontend directory (Vite build output)
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const publicDir = path.join(__dirname, "..", "dist", "public");

  // Debug endpoint: confirms what directory we are serving
  app.get("/__where", (_req, res) => {
    res.json({ publicDir });
  });

  // Serve static assets (JS/CSS/images)
  app.use(express.static(publicDir));

  // Guaranteed root handler
  app.get("/", (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });

  // SPA fallback for all non-API routes
  app.get(/^\/(?!api).*/, (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });

  // Error handler (after routes)
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err?.status || err?.statusCode || 500;
    const message = err?.message || "Internal Server Error";
    res.status(status).json({ message });
  });

  const PORT = Number(process.env.PORT) || 5000;
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`serving on port ${PORT}`);
    console.log(`static from: ${publicDir}`);
  });
})().catch((e) => {
  console.error("Startup error:", e);
  process.exit(1);
});
