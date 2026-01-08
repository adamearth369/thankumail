// WHERE TO PASTE: server/index.ts
import express from "express";
import path from "path";
import Stripe from "stripe";
import type { Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";

const app = express();

/**
 * Stripe Webhook MUST be registered BEFORE express.json()
 * so we can validate the raw body signature.
 */
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, { apiVersion: "2019-09-09" });

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
    } catch {
      return res.status(400).send("invalid_signature");
    }

    return res.status(200).send("ok");
  }
);

// Normal JSON parsing for the rest of the app
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Health check
app.get("/health", (_req: Request, res: Response) => res.status(200).json({ ok: true }));

// API routes (safe registration)
try {
  registerRoutes(app);
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
  console.log(`Server listening on ${PORT}`);
});
