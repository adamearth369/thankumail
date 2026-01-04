import express, { type Request, Response, NextFunction } from "express";
import { createServer } from "http";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic } from "./vite";
import path from "path";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Simple request logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    if (req.path.startsWith("/api")) {
      console.log(`${req.method} ${req.path} ${res.statusCode} in ${duration}ms`);
    }
  });
  next();
});

(async () => {
  const server = await registerRoutes(createServer(app), app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    res.status(status).json({ message: err.message || "Internal Server Error" });
  });

  if (app.get("env") === "development") {
    // We'll try to re-enable setupVite if it works, or fallback to a basic static server
    try {
      await setupVite(server, app);
    } catch (e) {
      console.error("Vite setup failed, falling back to basic static serving:", e);
      app.use(express.static(path.resolve(process.cwd(), "client")));
      app.get("*", (_req, res) => {
        res.sendFile(path.resolve(process.cwd(), "client", "index.html"));
      });
    }
  } else {
    serveStatic(app);
  }

  const PORT = Number(process.env.PORT) || 5000;
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`serving on port ${PORT}`);
  });
})();
