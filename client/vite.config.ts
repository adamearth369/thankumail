import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import path from "path";
import fs from "fs";

function writeVersionFile() {
  return {
    name: "write-version-json",
    buildStart() {
      const commit = process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || "dev";
      fs.mkdirSync(path.resolve(__dirname, "public"), { recursive: true });
      fs.writeFileSync(
        path.resolve(__dirname, "public/version.json"),
        JSON.stringify({ commit, builtAt: new Date().toISOString() }, null, 2)
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwind(), writeVersionFile()],
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@shared": path.resolve(__dirname, "../shared"),
    },
  },
});