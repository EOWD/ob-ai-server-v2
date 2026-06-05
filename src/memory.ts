// Session memory backed by SQLite (see db.ts for the Postgres migration note).
// Three layers:
//   1. verbatim window  — last MAX_TURNS turns, replayed to the model
//   2. rolling summary  — older turns compressed into session_state.summary
//   3. session state    — durable facts for THIS conversation (active cart id)

import { db } from "./db.js";

export interface StoredMessage {
  id?: number;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface RecentProduct {
  id: string;
  title: string;
  url?: string;
  /** One-time purchasable variants, so follow-up turns can cart by id */
  variants?: { id: string; title: string }[];
}

export interface SessionState {
  cartId?: string;
  summary?: string;
  summarizedThrough: number;
  userId?: string;
  recentProducts: RecentProduct[];
}

export const MAX_TURNS = 20; // user+assistant pairs kept verbatim

const insertMsg = db.prepare(
  "INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
);
const selectRecent = db.prepare(
  "SELECT id, role, content, created_at FROM messages WHERE session_id = ? AND id > ? ORDER BY id ASC",
);
const deleteMsgs = db.prepare("DELETE FROM messages WHERE session_id = ?");
const selectState = db.prepare("SELECT * FROM session_state WHERE session_id = ?");
const upsertState = db.prepare(`
  INSERT INTO session_state (session_id, user_id, cart_id, summary, summarized_through, recent_products, updated_at)
  VALUES (@sessionId, @userId, @cartId, @summary, @summarizedThrough, @recentProducts, @updatedAt)
  ON CONFLICT(session_id) DO UPDATE SET
    user_id = COALESCE(excluded.user_id, session_state.user_id),
    cart_id = COALESCE(excluded.cart_id, session_state.cart_id),
    summary = COALESCE(excluded.summary, session_state.summary),
    summarized_through = MAX(excluded.summarized_through, session_state.summarized_through),
    recent_products = COALESCE(excluded.recent_products, session_state.recent_products),
    updated_at = excluded.updated_at
`);
const deleteState = db.prepare("DELETE FROM session_state WHERE session_id = ?");

export const memory = {
  /** Turns newer than the summary cutoff, capped at the verbatim window. */
  async getHistory(sessionId: string): Promise<StoredMessage[]> {
    const state = await this.getState(sessionId);
    const rows = selectRecent.all(sessionId, state.summarizedThrough) as any[];
    const msgs = rows.map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      timestamp: r.created_at,
    })) as StoredMessage[];
    return msgs.slice(-MAX_TURNS * 2);
  },

  /** Full uncompressed backlog (used by the summarizer). */
  async getUnsummarized(sessionId: string): Promise<StoredMessage[]> {
    const state = await this.getState(sessionId);
    const rows = selectRecent.all(sessionId, state.summarizedThrough) as any[];
    return rows.map((r) => ({ id: r.id, role: r.role, content: r.content, timestamp: r.created_at }));
  },

  async append(sessionId: string, msg: StoredMessage): Promise<void> {
    insertMsg.run(sessionId, msg.role, msg.content, msg.timestamp);
  },

  async clear(sessionId: string): Promise<void> {
    deleteMsgs.run(sessionId);
    deleteState.run(sessionId);
  },

  async getState(sessionId: string): Promise<SessionState> {
    const row = selectState.get(sessionId) as any;
    let recentProducts: RecentProduct[] = [];
    try {
      recentProducts = row?.recent_products ? JSON.parse(row.recent_products) : [];
    } catch {
      /* corrupt JSON — start fresh */
    }
    return {
      cartId: row?.cart_id ?? undefined,
      summary: row?.summary ?? undefined,
      summarizedThrough: row?.summarized_through ?? 0,
      userId: row?.user_id ?? undefined,
      recentProducts,
    };
  },

  async saveState(
    sessionId: string,
    patch: Partial<{
      cartId: string;
      summary: string;
      summarizedThrough: number;
      userId: string;
      recentProducts: RecentProduct[];
    }>,
  ): Promise<void> {
    upsertState.run({
      sessionId,
      userId: patch.userId ?? null,
      cartId: patch.cartId ?? null,
      summary: patch.summary ?? null,
      summarizedThrough: patch.summarizedThrough ?? 0,
      recentProducts: patch.recentProducts ? JSON.stringify(patch.recentProducts.slice(0, 8)) : null,
      updatedAt: Date.now(),
    });
  },
};
