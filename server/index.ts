import express from "express";
import { createServer } from "http";
import type { Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";

const app = express();

// ---- JSON WITH RAW BODY CAPTURE (FOR WEBHOOK SIGNATURE VERIFICATION) ----
app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf; // Buffer
    },
  })
);

app.use(express.urlencoded({ extended: false }));

// ---- SAFE IN-MEMORY RATE LIMITER (NO NEW DEPENDENCIES) ----
type RateLimitOptions = {
  windowMs: number;
  max: number;
  message: any;
};

function createRateLimiter(opts: RateLimitOptions) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = `${req.ip}:${req.baseUrl || ""}${req.path || ""}`;

    const current = hits.get(key);
    if (!current || current.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + opts.windowMs });
      return next();
    }

    current.count += 1;
    if (current.count > opts.max) {
      const retryAfterSec = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSec));
      return res.status(429).json(opts.message);
    }

    return next();
  };
}

const giftLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: "Too many requests. Please wait a minute." },
});

const claimLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "Too many attempts. Please slow down." },
});

// Apply by path so it works regardless of how routes are registered
app.use("/api/gifts", giftLimiter);
app.use("/api/claim", claimLimiter);
app.use("/api/claim/", claimLimiter);

// ---- STRUCTURED EVENT LOGGING (SAFE) ----
const logEvent = (type: string, data: Record<string, any> = {}) => {
  try {
    console.log(
      JSON.stringify({
        time: new Date().toISOString(),
        type,
        ...data,
      })
    );
  } catch {
    // never throw from logging
  }
};

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;

  res.on("finish", () => {
    const ms = Date.now() - start;

    if (path.startsWith("/api")) {
      log(`${req.method} ${path} ${res.statusCode} in ${ms}ms`);
      logEvent("api_request", {
        method: req.method,
        path,
        status: res.statusCode,
        ms,
        ip: req.ip,
      });
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
    logEvent("routes_loaded_with_warnings", { error: (e as any)?.message || String(e) });
  }

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error("Unhandled error:", err);
    logEvent("unhandled_error", { error: err?.message || String(err) });
    res.status(500).json({ message: "Internal Server Error" });
  });

  if (process.env.NODE_ENV === "development") {
    await setupVite(server, app);
  } else {
    try {
      serveStatic(app);
    } catch {
      console.log("serveStatic: skipped (MVP mode)");
      logEvent("serveStatic_skipped", {});
    }
  }

  const PORT = Number(process.env.PORT) || 5000;
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Listening on http://0.0.0.0:${PORT}`);
    logEvent("server_listening", { port: PORT });
  });
})();
