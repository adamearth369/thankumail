import type { Server } from "http";
import type { Express } from "express";

export function log(message: string) {
  console.log(message);
}

// MVP-safe no-op: prevents missing export crashes.
// Later, we can restore real Vite middleware.
export async function setupVite(_server: Server, _app: Express) {
  log("setupVite: skipped (MVP mode)");
}

export function serveStatic(_app: Express) {
  log("serveStatic: skipped (MVP mode)");
}
