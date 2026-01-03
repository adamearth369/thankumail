import type { Express } from "express";

export async function setupVite(_app: Express) {
  // No-op in MVP mode (prevents missing export crashes).
  // When you're ready to re-enable Vite middleware, we can add it back safely.
  return;
}

export function serveStatic(_app: Express) {
  // No-op in MVP mode.
  return;
}

export function log(message: string) {
  console.log(message);
}

