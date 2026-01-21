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

async function main() {
  // 1) Build client (uses your existing vite config)
  run("npx vite build");

  // 2) Bundle server explicitly from server/index.ts -> dist/index.cjs
  const root = process.cwd();
  const outDir = path.resolve(root, "dist");
  ensureDir(outDir);

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
      // keep node_modules as externals (faster, smaller)
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
