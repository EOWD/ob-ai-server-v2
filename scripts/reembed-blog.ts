// One-off migration: re-embed the existing "blog" index (Gemini embedding-001,
// 768d) into "blog-openai" (text-embedding-3-large, 3072d) using the chunk
// text already stored in Pinecone metadata. No Shopify fetching required.
//
// Run: npx tsx scripts/reembed-blog.ts

import { Pinecone } from "@pinecone-database/pinecone";
import OpenAI from "openai";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });
dotenv.config({ path: path.join(__dirname, "../../.env") });

const SOURCE_INDEX = "blog";
const TARGET_INDEX = "blog-openai";
const EMBED_MODEL = "text-embedding-3-large"; // 3072 dims
const BATCH = 50;

const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

async function ensureTargetIndex() {
  const { indexes } = await pc.listIndexes();
  if (indexes?.some((i) => i.name === TARGET_INDEX)) {
    console.log(`Index ${TARGET_INDEX} already exists`);
    return;
  }
  console.log(`Creating index ${TARGET_INDEX} (3072d, cosine, serverless)...`);
  await pc.createIndex({
    name: TARGET_INDEX,
    dimension: 3072,
    metric: "cosine",
    spec: { serverless: { cloud: "aws", region: "us-east-1" } },
    waitUntilReady: true,
  });
}

async function main() {
  await ensureTargetIndex();
  const source = pc.Index(SOURCE_INDEX);
  const target = pc.Index(TARGET_INDEX);

  let paginationToken: string | undefined;
  let done = 0;
  let skipped = 0;

  do {
    const page = await source.listPaginated({ limit: 100, paginationToken });
    const ids = (page.vectors ?? []).map((v) => v.id!);
    paginationToken = page.pagination?.next;
    if (!ids.length) break;

    const fetched = await source.fetch(ids);
    const records = Object.values(fetched.records ?? {});

    for (let i = 0; i < records.length; i += BATCH) {
      const slice = records.filter((r) => r.metadata?.text).slice(i, i + BATCH);
      if (!slice.length) continue;

      const inputs = slice.map((r) => {
        const m = r.metadata as any;
        return `Article: ${m.title}\n${m.text}`;
      });

      const emb = await openai.embeddings.create({ model: EMBED_MODEL, input: inputs });

      await target.upsert(
        slice.map((r, j) => ({
          id: r.id,
          values: emb.data[j].embedding,
          metadata: r.metadata,
        })),
      );
      done += slice.length;
    }
    skipped += records.filter((r) => !r.metadata?.text).length;
    process.stdout.write(`\rMigrated ${done} chunks (skipped ${skipped})...`);
  } while (paginationToken);

  console.log(`\n✅ Done. ${done} chunks re-embedded into ${TARGET_INDEX} (${skipped} skipped, no text).`);
}

main().catch((err) => {
  console.error("\n❌ Migration failed:", err);
  process.exit(1);
});
