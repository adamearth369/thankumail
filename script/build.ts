// WHERE TO PASTE: script/build.ts
// ACTION: Full file replacement (paste exactly)

import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import esbuild from "esbuild";

function run(cmd: string) {
  execSync(cmd, { stdio: "inherit" });
}

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function envTrue(v: string | undefined) {
  return String(v || "").toLowerCase() === "true";
}

async function main() {
  const root = process.cwd();

  // Vite is configured to output here:
  // vite.config.ts -> build.outDir = dist/public
  const distDir = path.resolve(root, "dist");
  const publicDir = path.resolve(distDir, "public");

  // STATIC SITE BUILD: build Vite and KEEP output in dist/public
  if (envTrue(process.env.BUILD_CLIENT)) {
    ensureDir(distDir);

    console.log("building client with vite...");
    run("npx vite build");

    // Must exist for Render Static Site publish dir = dist/public
    if (!fs.existsSync(publicDir)) {
      throw new Error("Vite build did not produce dist/public");
    }

    const indexHtml = path.resolve(publicDir, "index.html");
    if (!fs.existsSync(indexHtml)) {
      throw new Error("Vite build missing dist/public/index.html");
    }

    console.log("client build ready in dist/public (index.html + assets/)");
    return;
  }

  // WEB SERVICE BUILD: server bundle only
  ensureDir(distDir);

  await esbuild.build({
    entryPoints: [path.resolve(root, "server", "index.ts")],
    outfile: path.resolve(distDir, "index.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    sourcemap: false,
    logLevel: "info",
    external: [
      "pg",
      "pg-native",
      "drizzle-orm",
      "drizzle-zod",
      "express",
      "express-rate-limit",
      "express-session",
      "connect-pg-simple",
      "cors",
      "nodemailer",
      "twilio",
      "ws",
      "zod",
    ],
  });

  console.log("server build complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
