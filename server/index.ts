import express from "express";
import path from "path";
import { createServer } from "http";
import fs from "fs";
import Stripe from "stripe";
import type { Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";

const app = express();

/* =========================
   1) STRIPE WEBHOOK (RAW)
   MUST be BEFORE express.json()
   ========================= */
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
    } catch {
      return res.status(400).send("invalid_signature");
    }

    return res.status(200).send("ok");
  }
);

/* =========================
   2) BODY PARSERS (JSON)
   ========================= */
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

/* =========================
   3) HEALTH (BEFORE STATIC)
   ========================= */
app.get("/__health", (_req: Request, res: Response) => res.status(200).json({ ok: true }));
app.get("/health", (_req: Request, res: Response) => res.status(200).json({ ok: true }));

/* =========================
   4) HTTP SERVER + ROUTES
   ========================= */
const server = createServer(app);

(async () => {
  try {
    // routes.ts expects (httpServer, app)
    await registerRoutes(server as any, app as any);
  } catch (e) {
    console.error("Route registration failed:", e);
  }

  /* =========================
     5) STATIC + FALLBACK
     - Prevent ENOENT if dist/public missing on Render
     ========================= */
  const publicDir = path.resolve(process.cwd(), "dist", "public");
  const indexHtml = path.join(publicDir, "index.html");

  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
  }

  app.get("*", (req: Request, res: Response) => {
    if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });

    if (fs.existsSync(indexHtml)) {
      return res.sendFile(indexHtml);
    }

    return res.status(404).send("Client not built (missing dist/public/index.html)");
  });

  /* =========================
     6) ERROR HANDLER (LAST)
     ========================= */
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("Unhandled error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  });

  /* =========================
     7) LISTEN (RENDER)
     ========================= */
  const PORT = Number(process.env.PORT || 10000);
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`serving on port ${PORT}`);
  });
})().catch((e) => {
  console.error("Fatal startup error:", e);
  process.exit(1);
});
