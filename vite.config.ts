import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// NOTE: Replit-only plugins removed so Render builds won't fail.

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, "client"),
  base: "/",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "client", "src"),
      "@shared": path.resolve(__dirname, "shared"),
    },
  },
  build: {
    outDir: path.resolve(__dirname, "dist", "public"),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
