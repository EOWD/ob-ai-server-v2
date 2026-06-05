// search_articles — semantic search over the Organic's Best editorial content
// (doctor-authored guides) in the Pinecone "blog-openai" index
// (text-embedding-3-large, 3072d). Migrated from the legacy Gemini index
// via scripts/reembed-blog.ts.

import { Pinecone } from "@pinecone-database/pinecone";
import OpenAI from "openai";
import { config } from "../config.js";

const pinecone = new Pinecone({ apiKey: config.pineconeApiKey });
const blogIndex = pinecone.Index(config.pineconeBlogIndex);
const openai = new OpenAI({ apiKey: config.openaiApiKey });

const EMBED_MODEL = "text-embedding-3-large";

export interface ArticleChunk {
  title: string;
  url: string;
  date: string;
  text: string;
  score: number;
}

export async function searchArticles(query: string, topK = 4): Promise<ArticleChunk[] | { error: string }> {
  if (!config.openaiApiKey) {
    return { error: "Article search is unavailable (no embedding API key configured). Answer from general knowledge and say you could not check the store's articles." };
  }
  const emb = await openai.embeddings.create({ model: EMBED_MODEL, input: query });
  const result = await blogIndex.query({
    vector: emb.data[0].embedding,
    topK,
    includeMetadata: true,
  });
  return (result.matches || []).map((m) => ({
    title: String(m.metadata?.title || ""),
    url: String(m.metadata?.url || ""),
    date: String(m.metadata?.date || ""),
    text: String(m.metadata?.text || ""),
    score: m.score || 0,
  }));
}
