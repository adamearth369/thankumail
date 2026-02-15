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

  // This is the directory Render Static Site serves in this repo:
  // Vite is currently outputting to: dist/public
  const distDir = path.resolve(root, "dist");
  const publicDir = path.resolve(distDir, "public");

  ensureDir(distDir);

  // STATIC SITE BUILD: build Vite and ensure output is dist/public
  if (envTrue(process.env.BUILD_CLIENT)) {
    console.log("building client with vite...");
    run("npx vite build");

    if (!fs.existsSync(publicDir)) {
      throw new Error("Vite build did not produce dist/public");
    }

    // Render Static Site typically serves a single publish directory.
    // We want the publish dir to contain index.html + assets/*
    // So we mirror dist/public -> dist (index.html at dist/index.html).
    const indexHtml = path.resolve(publicDir, "index.html");
    if (!fs.existsSync(indexHtml)) {
      throw new Error("Vite build missing dist/public/index.html");
    }

    // Clean dist root but preserve that we're about to move content into it
    // Approach: move dist/public/* up to dist/*
    const tmp = path.resolve(root, ".tm_public_tmp");

    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });

    // copy dist/public -> tmp
    fs.cpSync(publicDir, tmp, { recursive: true });

    // wipe dist, recreate
    fs.rmSync(distDir, { recursive: true, force: true });
    fs.mkdirSync(distDir, { recursive: true });

    // copy tmp -> dist
    fs.cpSync(tmp, distDir, { recursive: true });

    fs.rmSync(tmp, { recursive: true, force: true });

    console.log("client build ready in /dist (index.html + assets/)");
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
