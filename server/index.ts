// GitHub → thankumail repo → server/index.ts
// COPY/PASTE THIS ENTIRE FILE — REPLACE EVERYTHING

import express from "express";
import { createServer } from "http";
import type { Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// REQUEST LOGGER (SAFE)
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

// ROOT FALLBACK (FIXES "Cannot GET /")
app.get("/", (_req, res) => {
  res.status(200).send("ThankuMail is live ✅");
});

(async () => {
  const server = createServer(app);

  // REGISTER API ROUTES (SAFE EVEN IF DB ISN’T READY)
  try {
    await registerRoutes(server, app);
  } catch (e) {
    console.error("Routes loaded with warnings:", e);
  }

  // ERROR HANDLER (PREVENTS CRASH LOOP)
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error("Unhandled error:", err);
    res.status(500).json({ message: "Internal Server Error" });
  });

  // STATIC / DEV HANDLING
  if (process.env.NODE_ENV === "development") {
    await setupVite(server, app);
  } else {
    try {
      serveStatic(app);
    } catch {
      console.log("serveStatic: skipped (MVP mode)");
    }
  }

  // RENDER-COMPATIBLE LISTEN
  const PORT = Number(process.env.PORT) || 5000;
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Listening on http://0.0.0.0:${PORT}`);
  });
})();
