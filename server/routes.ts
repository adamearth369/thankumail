import type { Express } from "express";
import type { Server } from "http";
import crypto from "crypto";
import { z } from "zod";
import { db } from "./db";
import { gifts } from "@shared/schema";
import { eq } from "drizzle-orm";
import { sendGiftEmail } from "./email";

/* -------------------- STRUCTURED LOGGING -------------------- */
function logEvent(event: string, fields: Record<string, any> = {}) {
  const payload = {
    ts: new Date().toISOString(),
    event,
    ...fields,
  };
  // Render logs love single-line JSON
  console.log(JSON.stringify(payload));
}

function safeStr(v: any) {
  return typeof v === "string" ? v : "";
}

function getBaseUrl(req: any) {
  // Prefer explicit env if set, otherwise infer from request
  const envBase = process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "";
  if (envBase) return envBase.replace(/\/+$/, "");
  const proto = (req.headers["x-forwarded-proto"] || "https").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return `${proto}://${host}`.replace(/\/+$/, "");
}

/* -------------------- SAFE SEED (DOES NOT CRASH) -------------------- */
async function seed() {
  // Skip entirely if db query layer isn't ready
  if (!(db as any)?.query?.gifts?.findFirst) {
    logEvent("seed_skipped", { reason: "db_query_layer_not_ready" });
    return;
  }

  try {
    const existing = await (db as any).query.gifts.findFirst();
    if (!existing) {
      const publicId = "demo-gift";
      await db.insert(gifts).values({
        publicId,
        recipientEmail: "demo@example.com",
        message: "Here's a little thank you for trying out ThanküMail! 🎁",
        amount: 1000,
        isClaimed: false,
      });
      logEvent("seed_inserted", { publicId });
    } else {
      logEvent("seed_noop", { reason: "already_has_rows" });
    }
  } catch (e: any) {
    logEvent("seed_error", { error: safeStr(e?.message || e) });
  }
}

/* -------------------- SCHEMAS -------------------- */
const CreateGiftSchema = z.object({
  recipientEmail: z.string().email(),
  message: z.string().min(1).max(1000),
  amount: z.number().int().min(1000), // cents, min $10
});

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  // Never crash deploy if DB/table isn't ready
  try {
    await seed();
  } catch (e: any) {
    logEvent("seed_crash_prevented", { error: safeStr(e?.message || e) });
  }

  /* -------------------- HEALTH -------------------- */
  app.get(["/health", "/__health"], (_req, res) => {
    res.json({
      ok: true,
      // Hardcoded marker to PROVE this exact file is deployed
      routesMarker: "ROUTES_MARKER_v1_2026-01-10",
      marker: process.env.DEPLOY_MARKER || process.env.MARKER || undefined,
    });
  });

  /* -------------------- CREATE GIFT -------------------- */
  app.post("/api/gifts", async (req, res) => {
    const requestId = safeStr(req.headers["x-request-id"] || req.headers["cf-ray"] || "");

    try {
      const parsed = CreateGiftSchema.safeParse(req.body);
      if (!parsed.success) {
        logEvent("gift_create_validation_failed", {
          requestId,
          issues: parsed.error.issues,
        });
        return res.status(400).json({ error: "Invalid payload", issues: parsed.error.issues });
      }

      const { recipientEmail, message, amount } = parsed.data;

      const publicId = crypto.randomBytes(6).toString("hex"); // 12 chars
      const baseUrl = getBaseUrl(req);
      const claimLink = `${baseUrl}/claim/${publicId}`;

      await db.insert(gifts).values({
        publicId,
        recipientEmail,
        message,
        amount,
        isClaimed: false,
      });

      logEvent("gift_created", {
        requestId,
        publicId,
        amount,
        recipientEmail,
      });

      // Try email, but NEVER block creation
      try {
        const info = await sendGiftEmail({
          to: recipientEmail,
          claimLink,
          message,
          amountCents: amount,
        });

        logEvent("email_send_ok", {
          requestId,
          publicId,
          to: recipientEmail,
          messageId: safeStr((info as any)?.messageId),
        });
      } catch (e: any) {
        logEvent("email_send_failed", {
          requestId,
          publicId,
          to: recipientEmail,
          error: safeStr(e?.message || e),
        });
        // Do not fail the request
      }

      return res.json({ success: true, giftId: publicId, claimLink: `/claim/${publicId}` });
    } catch (e: any) {
      logEvent("gift_create_error", { error: safeStr(e?.message || e) });
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /* -------------------- GET GIFT -------------------- */
  app.get("/api/gifts/:publicId", async (req, res) => {
    const requestId = safeStr(req.headers["x-request-id"] || req.headers["cf-ray"] || "");
    const publicId = req.params.publicId;

    try {
      const row = await db.query.gifts.findFirst({
        where: eq(gifts.publicId, publicId),
      });

      if (!row) {
        logEvent("gift_get_not_found", { requestId, publicId });
        return res.status(404).json({ error: "Not found" });
      }

      logEvent("gift_get_ok", { requestId, publicId, isClaimed: (row as any).isClaimed });

      return res.json({
        id: (row as any).id,
        publicId: (row as any).publicId,
        recipientEmail: (row as any).recipientEmail,
        message: (row as any).message,
        amount: (row as any).amount,
        isClaimed: (row as any).isClaimed,
        createdAt: (row as any).createdAt,
        claimedAt: (row as any).claimedAt,
      });
    } catch (e: any) {
      logEvent("gift_get_error", { requestId, publicId, error: safeStr(e?.message || e) });
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /* -------------------- CLAIM GIFT -------------------- */
  app.post("/api/gifts/:publicId/claim", async (req, res) => {
    const requestId = safeStr(req.headers["x-request-id"] || req.headers["cf-ray"] || "");
    const publicId = req.params.publicId;

    logEvent("claim_attempt", { requestId, publicId });

    try {
      const row = await db.query.gifts.findFirst({
        where: eq(gifts.publicId, publicId),
      });

      if (!row) {
        logEvent("claim_not_found", { requestId, publicId });
        return res.status(404).send("<h2>Gift not found</h2>");
      }

      if ((row as any).isClaimed) {
        logEvent("claim_already_claimed", { requestId, publicId });
        return res.status(400).send("<h2>This gift has already been claimed 🎁</h2>");
      }

      await db
        .update(gifts)
        .set({ isClaimed: true, claimedAt: new Date() as any })
        .where(eq(gifts.publicId, publicId));

      logEvent("claim_success", { requestId, publicId, amount: (row as any).amount });

      const dollars = (((row as any).amount || 0) / 100).toFixed(2);
      const msg = escapeHtml((row as any).message || "");

      return res.status(200).send(`
        <div style="font-family: sans-serif; text-align: center; padding: 50px;">
          <h1>🎉 Gift Claimed!</h1>
          <p><strong>Amount:</strong> $${dollars}</p>
          <p><strong>Message:</strong></p>
          <p style="font-style: italic; color: #666;">"${msg}"</p>
          <p>Thank you for using ThanküMail.</p>
          <a href="/" style="display: inline-block; margin-top: 20px; color: #7c3aed; text-decoration: none; font-weight: bold;">
            Send a gift yourself →
          </a>
        </div>
      `);
    } catch (e: any) {
      logEvent("claim_error", { requestId, publicId, error: safeStr(e?.message || e) });
      return res.status(500).send("<h2>Internal server error</h2>");
    }
  });

  return httpServer;
}

function escapeHtml(input: string) {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
