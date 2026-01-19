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
        sender_email TEXT NULL,
        recipient_email TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        amount INTEGER NOT NULL,
        is_claimed BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        claimed_at TIMESTAMPTZ NULL,
        reminder_count INTEGER NOT NULL DEFAULT 0,
        last_reminder_sent_at TIMESTAMPTZ NULL,
        returned_to_sender_at TIMESTAMPTZ NULL
      );
    `);

    // Ensure columns exist (for older deployments)
    await pool.query(`ALTER TABLE gifts ADD COLUMN IF NOT EXISTS sender_email TEXT NULL;`);
    await pool.query(`ALTER TABLE gifts ADD COLUMN IF NOT EXISTS reminder_count INTEGER NOT NULL DEFAULT 0;`);
    await pool.query(`ALTER TABLE gifts ADD COLUMN IF NOT EXISTS last_reminder_sent_at TIMESTAMPTZ NULL;`);
    await pool.query(`ALTER TABLE gifts ADD COLUMN IF NOT EXISTS returned_to_sender_at TIMESTAMPTZ NULL;`);

    await pool.query(`CREATE INDEX IF NOT EXISTS gifts_public_id_idx ON gifts(public_id);`);

    console.log("Database tables ensured");
  } catch (err) {
    console.error("DB init skipped:", err);
  }
}
