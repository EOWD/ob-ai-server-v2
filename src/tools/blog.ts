// search_articles — semantic search over the Organic's Best editorial content
// (doctor-authored guides) in the Pinecone "blog-openai" index
// (text-embedding-3-large, 3072d). Migrated from the legacy Gemini index
// via scripts/reembed-blog.ts.
//
// BACKUP: new articles aren't in Pinecone until (re)embedded, so we also run a
// live Shopify Storefront keyword search (articles(query:)) and merge in any
// articles the embeddings didn't already cover. Keyword match is weaker than
// semantic, but it guarantees freshly-published guides are never invisible.

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
  /** Featured image URL for rendering article cards (null if none / not embedded). */
  imageUrl: string | null;
  /** Where this result came from: the embedding index vs. live Shopify search. */
  source: "embedded" | "live";
}

/** Extract a stable article handle from a URL (last non-empty path segment),
 *  so we can dedupe Pinecone results against live ones regardless of URL shape. */
function handleFromUrl(url: string): string {
  try {
    const path = url.split("?")[0].split("#")[0].replace(/\/+$/, "");
    return path.split("/").pop()?.toLowerCase() || url.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/** Semantic search over the embedded blog corpus (Pinecone). */
async function searchEmbedded(query: string, topK: number): Promise<ArticleChunk[]> {
  if (!config.openaiApiKey) return [];
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
    imageUrl: m.metadata?.image ? String(m.metadata.image) : null,
    source: "embedded" as const,
  }));
}

const ARTICLE_FIELDS = `
  title
  handle
  onlineStoreUrl
  excerpt
  content(truncateAt: 2000)
  publishedAt
  image { url }
  blog { handle }
`;

// Relevance-ranked keyword search (for topical questions).
const LIVE_ARTICLES_QUERY = `
  query SearchArticles($query: String!, $first: Int!) {
    articles(first: $first, query: $query, sortKey: RELEVANCE) {
      edges { node { ${ARTICLE_FIELDS} } }
    }
  }
`;

// Newest-first by publish date (for "latest / newest / recent articles" intent).
// Embeddings have no notion of recency, so this is the only correct source for it.
const LATEST_ARTICLES_QUERY = `
  query LatestArticles($first: Int!) {
    articles(first: $first, sortKey: PUBLISHED_AT, reverse: true) {
      edges { node { ${ARTICLE_FIELDS} } }
    }
  }
`;

/** Live search over Shopify blog articles — the backup for articles not yet
 *  embedded. `recent` switches from relevance ranking to newest-by-date.
 *  Best-effort: returns [] on any failure so it never blocks. */
async function searchLive(query: string, first: number, recent = false): Promise<ArticleChunk[]> {
  const token = process.env.SHOPIFY_STOREFRONT_TOKEN;
  if (!token) return [];
  try {
    const body = recent
      ? { query: LATEST_ARTICLES_QUERY, variables: { first } }
      : { query: LIVE_ARTICLES_QUERY, variables: { query, first } };
    const res = await fetch(`https://${config.shopifyDomain}/api/2024-04/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": token,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return [];
    const json: any = await res.json();
    const edges = json?.data?.articles?.edges ?? [];
    return edges.map((e: any) => {
      const n = e.node ?? {};
      const url =
        n.onlineStoreUrl ||
        (n.blog?.handle && n.handle
          ? `https://${config.shopifyDomain}/blogs/${n.blog.handle}/${n.handle}`
          : "");
      return {
        title: String(n.title || ""),
        url,
        date: String(n.publishedAt || ""),
        text: String(n.excerpt || n.content || ""),
        score: 0,
        imageUrl: n.image?.url || null,
        source: "live" as const,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Search editorial articles. Runs the semantic (embedded) and live (Shopify
 * keyword) searches in parallel, then returns the embedded matches plus any
 * live articles the embeddings didn't already cover (deduped by handle).
 */
export async function searchArticles(
  query: string,
  topK = 4,
  recent = false,
): Promise<ArticleChunk[] | { error: string }> {
  // Recency intent ("latest/newest articles") can only come from a date-sorted
  // live query — embeddings have no sense of "newest". Return those directly.
  if (recent) {
    const latest = await searchLive(query, Math.max(topK, 6), true).catch(() => [] as ArticleChunk[]);
    return latest.length
      ? latest
      : { error: "Couldn't load the latest articles right now." };
  }

  const [embedded, live] = await Promise.all([
    searchEmbedded(query, topK).catch(() => [] as ArticleChunk[]),
    searchLive(query, topK).catch(() => [] as ArticleChunk[]),
  ]);

  // Embedded chunks don't carry an image; borrow it from the live result for the
  // same article (by handle) so article cards still get a thumbnail.
  const liveByHandle = new Map(live.map((a) => [handleFromUrl(a.url), a]));
  for (const a of embedded) {
    if (!a.imageUrl) a.imageUrl = liveByHandle.get(handleFromUrl(a.url))?.imageUrl ?? null;
  }

  const seen = new Set(embedded.map((a) => handleFromUrl(a.url)));
  const merged = [...embedded];
  for (const a of live) {
    const h = handleFromUrl(a.url);
    if (!h || seen.has(h)) continue; // already covered by the embedded results
    seen.add(h);
    merged.push(a);
  }

  if (merged.length === 0) {
    return {
      error:
        "Article search returned nothing (embeddings + live search both empty). Answer from general knowledge and say you couldn't find a store article on this.",
    };
  }
  return merged;
}

/**
 * Fill in missing featured images on article cards via one batched
 * blog.articleByHandle lookup. Embedded (Pinecone) results don't carry an image,
 * so this gives doctor-authored guides a thumbnail too. Mutates `cards` in place;
 * best-effort (no-op on any failure).
 */
export async function hydrateArticleImages(
  cards: { url: string; image?: string | null }[],
): Promise<void> {
  const token = process.env.SHOPIFY_STOREFRONT_TOKEN;
  if (!token) return;
  const meta: { alias: string; card: { image?: string | null } }[] = [];
  const parts: string[] = [];
  cards.forEach((c, i) => {
    if (c.image || !c.url) return;
    const m = c.url.match(/\/blogs\/([^/]+)\/([^/?#]+)/i);
    if (!m) return;
    const alias = `a${i}`;
    parts.push(
      `${alias}: blog(handle: ${JSON.stringify(m[1])}) { articleByHandle(handle: ${JSON.stringify(m[2])}) { image { url } } }`,
    );
    meta.push({ alias, card: c });
  });
  if (!parts.length) return;
  try {
    const res = await fetch(`https://${config.shopifyDomain}/api/2024-04/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": token,
      },
      body: JSON.stringify({ query: `query Hydrate {\n${parts.join("\n")}\n}` }),
    });
    if (!res.ok) return;
    const json: any = await res.json();
    for (const { alias, card } of meta) {
      const url = json?.data?.[alias]?.articleByHandle?.image?.url;
      if (url) card.image = url;
    }
  } catch {
    // best-effort
  }
}
