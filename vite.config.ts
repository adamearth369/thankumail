import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

export default defineConfig(async () => {
  const plugins: any[] = [react(), runtimeErrorOverlay()];

  // Only load Replit-only plugins in Replit dev
  if (process.env.NODE_ENV !== "production" && process.env.REPL_ID !== undefined) {
    const carto = await import("@replit/vite-plugin-cartographer");
    const banner = await import("@replit/vite-plugin-dev-banner");
    plugins.push(carto.cartographer(), banner.devBanner());
  }

  return {
    plugins,
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "client", "src"),
        "@shared": path.resolve(import.meta.dirname, "shared"),
        "@assets": path.resolve(import.meta.dirname, "attached_assets"),
      },
    },
    root: path.resolve(import.meta.dirname, "client"),
    build: {
      outDir: path.resolve(import.meta.dirname, "dist/public"),
      emptyOutDir: true,
    },
    server: {
      fs: {
        strict: true,
        deny: ["**/.*"],
      },
    },
  };
});
