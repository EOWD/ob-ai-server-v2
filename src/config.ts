import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Local server-v2/.env wins; fall back to the repo-root .env
dotenv.config({ path: path.join(__dirname, "../.env") });
dotenv.config({ path: path.join(__dirname, "../../.env") });

function required(name: string, fallbackNames: string[] = []): string {
  for (const n of [name, ...fallbackNames]) {
    const v = process.env[n];
    if (v) return v;
  }
  throw new Error(`Missing required env var: ${name}`);
}

export const config = {
  port: Number(process.env.PORT || 3000),
  anthropicApiKey: required("ANTHROPIC_API_KEY", ["ne_key_claude"]),
  shopifyDomain: required("SHOPIFY_DOMAIN"),
  pineconeApiKey: required("PINECONE_API_KEY"),
  // blog-openai: text-embedding-3-large vectors (see scripts/reembed-blog.ts)
  pineconeBlogIndex: process.env.PINECONE_BLOG_INDEX || "blog-openai",
  corsOrigins: (process.env.CORS_ORIGINS || "https://sghwtrade-demo.netlify.app,http://localhost:5173")
    .split(",")
    .map((s) => s.trim()),
  model: process.env.CLAUDE_MODEL || "claude-opus-4-8",
  // LLM_PROVIDER=anthropic (default) | openai
  provider: (process.env.LLM_PROVIDER || "anthropic") as "anthropic" | "openai",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiModel: process.env.OPENAI_MODEL || "gpt-4o",
} as const;

export const MCP_ENDPOINT = `https://${config.shopifyDomain}/api/mcp`;
