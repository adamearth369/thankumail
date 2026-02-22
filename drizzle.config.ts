// WHERE TO PASTE: drizzle.config.ts
// ACTION: Full file replacement (paste exactly)

import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

// Force SSL for Render Postgres
const dbUrl =
  process.env.DATABASE_URL.includes("sslmode=")
    ? process.env.DATABASE_URL
    : `${process.env.DATABASE_URL}?sslmode=require`;

export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: dbUrl,
  },
});