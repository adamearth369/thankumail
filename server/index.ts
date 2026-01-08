import express from "express";
import { createServer } from "http";
import type { Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import Stripe from "stripe";

const app = express();

/**
 * STRIPE WEBHOOK (MUST BE BEFORE express.json())
 * - Uses raw body
 * - Verifies signature
 * - Returns 200 quickly
 */
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2025-01-27.acacia",
});

app.post("/api/webhooks/stripe", express.raw({ type: "*/*" }), (req, res) => {
  const sig = req.headers["stripe-signature"];

  if (!sig || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(400).send("Missing Stripe signature/secret");
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig as string,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err: any) {
    console.error("Stripe webhook signature verify failed:", err?.message || err);
    return res.status(400).send("Invalid signature");
  }

  // Minimal handling for now — just acknowledge receipt
  // (You can expand this later to fulfill gifts/payments, etc.)
  try {
    if (event.type === "payment_intent.succeeded") {
      // You can inspect event.data.object as Stripe.PaymentIntent
      // const pi = event.data.object as Stripe.PaymentIntent;
      // TODO: connect to your gift fulfillment logic
    }
    return res.status(200).json({ received: true });
  } catch (err: any) {
    console.error("Stripe webhook handler error:", err?.message || err);
    // Still return 200 to avoid retries while you iterate (Stripe best practice during rollout)
    return res.status(200).json({ received: true });
  }
});

// Normal parsers AFTER webhook
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
