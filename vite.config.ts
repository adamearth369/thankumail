import { defineConfig } from "vite";

// NOTE: We intentionally avoid top-level await here because Render loads Vite config
// through an esbuild CJS transform, and top-level await breaks in that mode.

export default defineConfig(async () => {
  const plugins: any[] = [];

  // Only load Replit-only plugins when running inside Replit
  const isReplit = Boolean(process.env.REPL_ID || process.env.REPLIT_ENVIRONMENT);

  if (isReplit) {
    try {
      const cartographer = await import("@replit/vite-plugin-cartographer").then(
        (m: any) => m.cartographer?.()
      );
      if (cartographer) plugins.push(cartographer);
    } catch {
      // ignore if not installed
    }

    try {
      const devBanner = await import("@replit/vite-plugin-dev-banner").then(
        (m: any) => m.devBanner?.()
      );
      if (devBanner) plugins.push(devBanner);
    } catch {
      // ignore if not installed
    }
  }

  return {
    plugins,
    server: {
      host: "0.0.0.0",
      port: 5173,
      strictPort: true
    }
  };
});
