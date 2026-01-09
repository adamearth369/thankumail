import { build as viteBuild } from "vite";
import esbuild from "esbuild";

async function buildClient() {
  // Runs Vite production build -> dist/public
  await viteBuild({
    root: "client",
    build: {
      outDir: "../dist/public",
      emptyOutDir: true,
    },
  });
}

async function buildServer() {
  // Bundle server entry -> dist/index.cjs
  await esbuild.build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: "dist/index.cjs",
    // Do NOT externalize runtime deps like cors
  });
}

async function main() {
  console.log("building client...");
  await buildClient();

  console.log("building server...");
  await buildServer();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
