import express, { type Request, Response, NextFunction } from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import { registerRoutes } from "./routes";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Simple health endpoint (proves server + file paths)
app.get("/__where", (_req, res) => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const publicDir = path.join(__dirname, "..", "dist", "public");
  res.json({ publicDir });
});

(async () => {
  const server = createServer(app);

  // 1) API routes first
  await registerRoutes(server, app);

  // 2) Serve built React frontend from dist/public
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const publicDir = path.join(__dirname, "..", "dist", "public");

  app.use(express.static(publicDir));

  // SPA fallback (anything not /api goes to index.html)
  app.get(/^\/(?!api).*/, (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });

  // Error handler last
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    res.status(status).json({ message });
  });

  const PORT = Number(process.env.PORT) || 5000;
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`serving on port ${PORT}`);
  });
})();
