import express from "express";
import { createServer } from "http";
import path from "path";
import fs from "fs";
import type { Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";

const app = express();

/* =========================
   1) STRIPE WEBHOOK (RAW BODY)
   - Must be BEFORE express.json()
   - Lazy-import Stripe so missing deps won't crash deploy
   ========================= */
app.post(
  "/api/webhooks/stripe",
  express.raw({ type: "application/json" }),
  async (req: Request, res: Response) => {
    const sig = req.headers["stripe-signature"];
    if (!sig || Array.isArray(sig)) return res.status(400).send("missing_signature");

    const secret = process.env.STRIPE_WEBHOOK_SECRET || "";
    const apiKey = process.env.STRIPE_SECRET_KEY || "";
    if (!secret || !apiKey) return res.status(500).send("stripe_not_configured");

    try {
      const mod: any = await import("stripe").catch(() => null);
      const StripeCtor = mod?.default || mod;
      if (!StripeCtor) return res.status(500).send("stripe_module_missing");

      const stripe = new StripeCtor(apiKey, { apiVersion: "2019-09-09" });

      stripe.webhooks.constructEvent(
        req.body, // raw Buffer
        sig,
        secret
      );

      return res.status(200).send("ok");
    } catch {
      return res.status(400).send("invalid_signature");
    }
  }
);

/* =========================
   2) BODY PARSERS (JSON)
   ========================= */
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

/* =========================
   3) HEALTH (BEFORE STATIC)
   ========================= */
app.get("/__health", (_req: Request, res: Response) => res.status(200).json({ ok: true }));
app.get("/health", (_req: Request, res: Response) => res.status(200).json({ ok: true }));

(async () => {
  const server = createServer(app);

  /* =========================
     4) ROUTES (MUST PASS server, app)
     ========================= */
  try {
    await registerRoutes(server, app);
  } catch (e) {
    console.error("Route registration failed:", e);
  }

  /* =========================
     5) STATIC (ONLY IF IT EXISTS)
     Fixes Render ENOENT when dist/public isn't built/deployed
     ========================= */
  const publicDir = path.resolve(process.cwd(), "dist", "public");
  const indexHtml = path.join(publicDir, "index.html");
  const hasIndex = fs.existsSync(indexHtml);

  if (hasIndex) {
    app.use(express.static(publicDir));
  }

  // Root + SPA fallback (only if index exists)
  app.get("*", (req: Request, res: Response) => {
    if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
    if (!hasIndex) return res.status(200).send("ThankuMail API is live ✅ (client not built on this deploy)");
    return res.sendFile(indexHtml);
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
  const PORT = Number(process.env.PORT || 5000);
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on ${PORT}`);
  });
})();
