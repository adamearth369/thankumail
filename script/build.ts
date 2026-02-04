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
  const outDir = path.resolve(root, "dist");
  ensureDir(outDir);

  // IMPORTANT:
  // Render Web Service deploys must NOT fail because Vite/Tailwind/PostCSS changes.
  // We only build the client when explicitly requested (e.g., local or Static Site builds).
  //
  // To build client manually:
  //   BUILD_CLIENT=true npm run build
  //
  // On Render Web Service:
  //   leave BUILD_CLIENT unset (default false)
  if (envTrue(process.env.BUILD_CLIENT)) {
    run("npx vite build");
  } else {
    console.log("skipping client build (set BUILD_CLIENT=true to enable)");
  }

  // Bundle server -> dist/index.cjs (CJS) to match Render start command
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

  console.log("build complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
