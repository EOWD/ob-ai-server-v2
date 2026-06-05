# ob-agent-v2

Organic's Best AI shopping agent — TypeScript rewrite using an agentic tool-use
loop with the Shopify Storefront MCP endpoint and the store's Pinecone blog index.

## Providers

Switchable via `LLM_PROVIDER` env var:

- `anthropic` (default) — Claude (`CLAUDE_MODEL`, default `claude-opus-4-8`), with
  prompt caching (system prompt + tools + conversation prefix) and adaptive thinking.
- `openai` — OpenAI (`OPENAI_MODEL`, default `gpt-4o`).

Both share the same tools, memory, system prompt, and SSE wire protocol.

## Tools

| Tool | Backend |
|---|---|
| `search_articles` | Pinecone `blog` index (Gemini embedding-001) — needs `GEMINI_API_KEY` |
| `search_catalog` | Store MCP `https://{SHOPIFY_DOMAIN}/api/mcp` |
| `get_product_details` | Store MCP — live price/stock |
| `update_cart` / `get_cart` | Store MCP — returns checkout URL |
| `search_shop_policies_and_faqs` | Store MCP |

## Run

```sh
npm install
npm run dev          # tsx watch, port 3000 (PORT to override)
```

Env is read from `server-v2/.env` first, then the repo root `.env`.
Required: `ANTHROPIC_API_KEY` (or legacy `ne_key_claude`), `SHOPIFY_DOMAIN`,
`PINECONE_API_KEY`. Optional: `OPENAI_API_KEY`, `GEMINI_API_KEY`, `CORS_ORIGINS`.

## SSE wire protocol (matches the existing React widget)

```
data: {"content": "<text delta>"}
data: {"status": "searching_products" | "searching_blogs" | ... | "completed"}
data: {"tool_response": {"type": "product_list", "rawProducts": [...]}}
data: {"error": "..."}
data: [DONE]
```

## Memory (SQLite dev / Postgres-portable schema)

Storage: `data/ob-agent.db` (better-sqlite3, WAL). Three layers:

1. **Verbatim window** — last 20 turns per session (`messages` table), replayed
   to the model with a prompt-cache breakpoint.
2. **Rolling summary** — older turns compressed into `session_state.summary`
   by a small background model; long chats never fall off a cliff.
3. **Session state** — active `cart_id` persisted so "add one more" reuses the
   same cart across turns and restarts.
4. **User memory** — durable facts per `username` (`user_memories` table),
   extracted after each turn (baby birth window, dietary needs, brand
   preferences, shipping country) and injected into the next session's context.

The injected context goes into the *user turn* (`<session_context>` block),
never the system prompt — the system prompt stays frozen for prompt caching.

History endpoints: `GET/DELETE /api/messages/:sessionId`.
Production migration: replace better-sqlite3 with pg in `db.ts` — schema is
portable SQL and the rest of the app only sees the `memory` interface.
