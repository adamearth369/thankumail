import { build as viteBuild } from "vite";
import esbuild from "esbuild";

async function buildClient() {
  await viteBuild({
    root: "client",
    build: {
      outDir: "../dist/public",
      emptyOutDir: true,
    },
  });
}

async function buildServer() {
  await esbuild.build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: "dist/index.cjs",
    external: [
      "cors",
      "nodemailer",
      "@getbrevo/brevo",
      "sib-api-v3-sdk",
    ],
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
