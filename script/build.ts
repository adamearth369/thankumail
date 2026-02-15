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
  const outDir = path.resolve(root, "dist");
  ensureDir(outDir);

  // 🚨 STATIC SITE FIX
  // When BUILD_CLIENT=true we MUST build Vite and copy its output to /dist
  if (envTrue(process.env.BUILD_CLIENT)) {
    console.log("building client with vite...");
    run("npx vite build");

    // Vite outputs to client/dist by default in this project
    const viteOut = path.resolve(root, "client", "dist");

    if (!fs.existsSync(viteOut)) {
      throw new Error("Vite build did not produce client/dist");
    }

    // wipe /dist then copy client build into it (this is what Render serves)
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.cpSync(viteOut, outDir, { recursive: true });

    console.log("client build copied to /dist (static site ready)");
    return; // IMPORTANT: do not bundle server for static site
  }

  // ---- Web Service build (server only) ----
  await esbuild.build({
    entryPoints: [path.resolve(root, "server", "index.ts")],
    outfile: path.resolve(outDir, "index.cjs"),
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
