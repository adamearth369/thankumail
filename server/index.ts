// WHERE TO PASTE: server/index.ts
// ACTION: COPY/PASTE ENTIRE FILE — REPLACE EVERYTHING

import express from "express";
import path from "path";
import { createServer } from "http";
import Stripe from "stripe";
import type { Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";

const app = express();

/* =========================
   1) STRIPE WEBHOOK (RAW)
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
   4) SERVER + ROUTES
   ========================= */
(async () => {
  const server = createServer(app);

  try {
    // IMPORTANT: routes.ts expects (httpServer, app)
    await registerRoutes(server, app);
  } catch (e) {
    console.error("Routes loaded with warnings:", e);
  }

  /* =========================
     5) STATIC + FALLBACK
     ========================= */
  const publicDir = path.resolve(process.cwd(), "dist", "public");
  app.use(express.static(publicDir));

  app.get("*", (req: Request, res: Response) => {
    if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
    return res.sendFile(path.join(publicDir, "index.html"));
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
  const PORT = Number(process.env.PORT) || 5000;
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`serving on port ${PORT}`);
  });
})();
