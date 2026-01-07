import express from "express";
import { createServer } from "http";
import type { Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;

  res.on("finish", () => {
    if (path.startsWith("/api")) {
      log(`${req.method} ${path} ${res.statusCode} in ${Date.now() - start}ms`);
    }
  });

  next();
});

app.get("/", (_req, res) => {
  res.status(200).send("ThankuMail is live ✅");
});

app.get("/__health", (_req, res) => {
  res.status(200).json({ ok: true });
});

(async () => {
  const server = createServer(app);

  // Register app routes (includes /api/*)
  try {
    await registerRoutes(server, app);
  } catch (e) {
    console.error("Routes loaded with warnings:", e);
  }

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error("Unhandled error:", err);
    res.status(500).json({ message: "Internal Server Error" });
  });

  if (process.env.NODE_ENV === "development") {
    await setupVite(server, app);
  } else {
    try {
      serveStatic(app);
    } catch {
      console.log("serveStatic: skipped (MVP mode)");
    }
  }

  const PORT = Number(process.env.PORT) || 5000;
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Listening on http://0.0.0.0:${PORT}`);
  });
})();
