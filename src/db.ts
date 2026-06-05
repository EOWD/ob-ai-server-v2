// SQLite storage (dev). Schema is plain SQL kept Postgres-portable —
// production migration is: swap better-sqlite3 for pg in this file and
// memory.ts/user-memory.ts; the rest of the app only sees the interfaces.

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "../data");
fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, "ob-agent.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);

CREATE TABLE IF NOT EXISTS session_state (
  session_id TEXT PRIMARY KEY,
  user_id TEXT,
  cart_id TEXT,
  summary TEXT,            -- rolling summary of turns older than the verbatim window
  summarized_through INTEGER DEFAULT 0,  -- messages.id covered by the summary
  recent_products TEXT,    -- JSON [{id,title,url}] of recently discussed products
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  fact TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',  -- baby_profile | dietary | preferences | logistics | other
  confidence TEXT NOT NULL DEFAULT 'inferred', -- explicit | inferred
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_user ON user_memories(user_id);
`);

// Migrations for existing dev databases (no-ops when already applied)
try {
  db.exec("ALTER TABLE session_state ADD COLUMN recent_products TEXT");
} catch {
  /* column already exists */
}
