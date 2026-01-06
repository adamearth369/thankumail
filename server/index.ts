import express, { type Request, Response, NextFunction } from "express";
import { createServer } from "http";
import path from "path";
import { registerRoutes } from "./routes";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Project root
const ROOT_DIR = process.cwd();

// Built frontend location
const publicDir = path.join(ROOT_DIR, "dist", "public");

// FAST health endpoint for deploy checks
app.get("/", (_req, res) => {
  res.status(200).send("OK");
});

// Debug endpoint
app.get("/__where", (_req, res) => {
  res.json({ publicDir, ROOT_DIR });
});

(async () => {
  const server = createServer(app);
  const PORT = Number(process.env.PORT) || 10000;

  // START LISTENING FIRST (do not block deploy health checks)
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`serving on port ${PORT}`);
  });

  // Initialize API routes AFTER listen (do not await)
  registerRoutes(server, app).catch((err) =>
    console.error("registerRoutes failed:", err),
  );

  // Serve built React frontend
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
})();
