import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export const db = drizzle(pool);

// AUTO-MIGRATION (SAFE, ONE-TIME)
export async function ensureTables() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS gifts (
        id SERIAL PRIMARY KEY,
        public_id TEXT NOT NULL UNIQUE,
        recipient_email TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        amount INTEGER NOT NULL,
        is_claimed BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        claimed_at TIMESTAMPTZ NULL
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS gifts_public_id_idx ON gifts(public_id);
    `);

    console.log("Database tables ensured");
  } catch (err) {
    console.error("DB init skipped:", err);
  }
}
