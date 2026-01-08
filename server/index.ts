// WHERE TO PASTE: server/index.ts
// ACTION: COPY/PASTE ENTIRE FILE — REPLACE EVERYTHING

import express from "express";
import path from "path";
import Stripe from "stripe";
import type { Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";

const app = express();

/**
 * Stripe webhook MUST be defined BEFORE express.json()
 * so Stripe signature verification can use the raw body.
 */
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: "2019-09-09",
});

app.post(
  "/api/webhooks/stripe",
  express.raw({ type: "application/json" }),
  (req: Request, res: Response) => {
    const sig = req.headers["stripe-signature"];

    if (!sig || Array.isArray(sig)) {
      return res.status(400).send("missing_signature");
    }

    try {
      stripe.webhooks.constructEvent(
        req.body, // raw Buffer
        sig,
        process.env.STRIPE_WEBHOOK_SECRET as string
      );
    } catch (e) {
      return res.status(400).send("invalid_signature");
    }

    return res.status(200).send("ok");
  }
);

// Normal JSON parsing for the rest of the app
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Health checks (MUST be before static + fallback)
app.get("/__health", (_req: Request, res: Response) => res.status(200).json({ ok: true }));
app.get("/health", (_req: Request, res: Response) => res.status(200).json({ ok: true }));

// API routes
try {
  // IMPORTANT: routes.ts expects registerRoutes(httpServer, app)
  // If your routes.ts is the "Server, app" version, it must be called from the createServer flow.
  // If your routes.ts is the "app only" version, this is correct.
  (registerRoutes as unknown as (app: Express) => void)(app);
} catch (e) {
  console.error("Route registration failed:", e);
}

// Static + root fallback
const publicDir = path.resolve(process.cwd(), "dist", "public");
app.use(express.static(publicDir));

app.get("*", (req: Request, res: Response) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  return res.sendFile(path.join(publicDir, "index.html"));
});

// Error handler (last)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", err);
  return res.status(500).json({ error: "Internal Server Error" });
});

// Render-compatible listen
const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`serving on port ${PORT}`);
});
