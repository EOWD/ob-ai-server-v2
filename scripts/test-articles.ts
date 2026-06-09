// Article-grounding eval: fact-checks the agent's answers against the REAL
// article content, and scores multi-turn follow-up behavior.
//
// For each turn we: (1) ask the live agent, (2) capture the article cards it
// emitted + the links in its answer, (3) pull the actual article text from
// Shopify (the cited ones + the top matches for the question), (4) hand both to
// a strong judge model that checks grounding, factual accuracy, hallucinations,
// follow-up context retention, and tone/safety.
//
// Run (agent must be running on :3000, OPENAI/ANTHROPIC key in env):
//   npx tsx scripts/test-articles.ts
//   npx tsx scripts/test-articles.ts --verbose
//
import "../src/config.js"; // loads .env (SHOPIFY_*, OPENAI/ANTHROPIC keys)
import { searchArticles } from "../src/tools/blog.js";
import { executeTool } from "../src/tools/index.js";

export {};

const API = process.env.AGENT_URL || "http://localhost:3000";
const DOMAIN = process.env.SHOPIFY_DOMAIN!;
const SF_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN!;
const JUDGE_MODEL = process.env.JUDGE_MODEL || "gpt-4o";
const VERBOSE = process.argv.includes("--verbose");
// Optional: pass a number to limit how many cases run (cheap smoke test), e.g. `... 1`.
const LIMIT = Number(process.argv.find((a) => /^\d+$/.test(a))) || Infinity;
// Optional: --grep=<substr> runs only cases whose name matches (case-insensitive).
const GREP = (process.argv.find((a) => a.startsWith("--grep=")) || "").slice(7).toLowerCase();
const RUN = Math.random().toString(36).slice(2, 7);

// ── agent transport ────────────────────────────────────────────────────────
interface ArticleCard { title: string; url: string; image?: string | null; excerpt?: string }
interface ProductCard { id: string; title: string; url?: string }
interface TurnOut {
  answer: string;
  statuses: string[];
  articleCards: ArticleCard[];
  productCards: ProductCard[];
  errors: string[];
}

async function ask(sessionId: string, user: string, question: string): Promise<TurnOut> {
  const res = await fetch(`${API}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, sessionId, username: user }),
  });
  if (!res.ok || !res.body) throw new Error(`/ask HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const out: TurnOut = { answer: "", statuses: [], articleCards: [], productCards: [], errors: [] };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop()!;
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const s = line.slice(6);
      if (s === "[DONE]") continue;
      try {
        const j = JSON.parse(s);
        if (j.content) out.answer += j.content;
        if (j.status) out.statuses.push(j.status);
        if (j.tool_response?.type === "article_list") out.articleCards.push(...(j.tool_response.articles ?? []));
        if (j.tool_response?.type === "product_list") {
          for (const p of j.tool_response.rawProducts ?? []) {
            if (p?.id) out.productCards.push({ id: String(p.id), title: String(p.title || ""), url: p.url });
          }
        }
        if (j.error) out.errors.push(j.error);
      } catch {
        /* ignore non-JSON */
      }
    }
  }
  return out;
}

// ── ground truth: pull the real article text ─────────────────────────────────
function parseBlogArticle(url: string): { blog: string; handle: string } | null {
  const m = url.match(/\/blogs\/([^/]+)\/([^/?#]+)/i);
  return m ? { blog: m[1], handle: m[2] } : null;
}

/** Fetch full article bodies by URL via aliased blog.articleByHandle. */
async function fetchArticleTexts(urls: string[]): Promise<Record<string, { title: string; text: string }>> {
  const uniq = [...new Set(urls)].slice(0, 6);
  const parts: { alias: string; url: string }[] = [];
  const gql: string[] = [];
  uniq.forEach((url, i) => {
    const p = parseBlogArticle(url);
    if (!p) return;
    const alias = `a${i}`;
    parts.push({ alias, url });
    gql.push(`${alias}: blog(handle: ${JSON.stringify(p.blog)}) { articleByHandle(handle: ${JSON.stringify(p.handle)}) { title content(truncateAt: 6000) } }`);
  });
  if (!gql.length) return {};
  const res = await fetch(`https://${DOMAIN}/api/2024-04/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Storefront-Access-Token": SF_TOKEN },
    body: JSON.stringify({ query: `query { ${gql.join("\n")} }` }),
  });
  const json: any = await res.json();
  const out: Record<string, { title: string; text: string }> = {};
  for (const { alias, url } of parts) {
    const node = json?.data?.[alias]?.articleByHandle;
    if (node) out[url] = { title: String(node.title || ""), text: String(node.content || "") };
  }
  return out;
}

/** Collect source material: the articles the agent cited + the top matches for
 *  the question (so we can also catch when it grounded on the WRONG article). */
async function gatherSources(question: string, cited: ArticleCard[]): Promise<{ title: string; url: string; text: string }[]> {
  const search = await searchArticles(question, 3).catch(() => []);
  const searchUrls = Array.isArray(search) ? search.map((a) => a.url) : [];
  const urls = [...cited.map((c) => c.url), ...searchUrls].filter(Boolean);
  const texts = await fetchArticleTexts(urls);
  return Object.entries(texts).map(([url, v]) => ({ url, title: v.title, text: v.text }));
}

/** Pull the REAL product data (price, availability, variants, product_knowledge
 *  metafields, subscription offers) for the products the answer is about — the
 *  same source the agent grounds on — so product claims are checkable too.
 *
 *  Resolves products from BOTH the emitted cards AND any /products/<handle>
 *  links in the answer text, so we still get ground truth when the agent states
 *  product facts without carding them (exactly the T3 case we want to verify). */
async function gatherProductSources(
  cards: ProductCard[],
  answer: string,
  question: string,
): Promise<{ title: string; data: string }[]> {
  const ids = new Map<string, string>(); // product_id -> title
  for (const c of cards) ids.set(c.id, c.title);

  // Resolve product handles mentioned in the answer to ids via search_catalog.
  const handles = [...new Set([...answer.matchAll(/\/products\/([a-z0-9-]+)/gi)].map((m) => m[1].toLowerCase()))];
  for (const h of handles) {
    try {
      const r = await executeTool("search_catalog", { query: h.replace(/-/g, " ") });
      const arr = JSON.parse(r.resultForModel);
      const match = (Array.isArray(arr) ? arr : []).find((p: any) => String(p.url || "").toLowerCase().includes(h));
      if (match?.id && !ids.has(match.id)) ids.set(match.id, match.title || h);
    } catch {
      /* skip */
    }
  }

  const out: { title: string; data: string }[] = [];

  // Catalog is the source of truth for what EXISTS (and newer than articles), so
  // search it for the question's topic and include the matches — this confirms
  // real products (e.g. ready-to-feed lines) instead of false-flagging them.
  try {
    const r = await executeTool("search_catalog", { query: question });
    const arr = JSON.parse(r.resultForModel);
    if (Array.isArray(arr) && arr.length) {
      const list = arr.map((p: any) => ({ title: p.title, available: p.available, url: p.url }));
      out.push({
        title: "CATALOG MATCHES (products that exist for this topic — authoritative)",
        data: JSON.stringify(list, null, 2),
      });
      for (const p of arr.slice(0, 4)) if (p?.id && !ids.has(p.id)) ids.set(p.id, p.title);
    }
  } catch {
    /* skip */
  }

  const strip = (s: any) => String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  for (const [id, title] of [...ids].slice(0, 4)) {
    try {
      const r = await executeTool("get_product_details", { product_id: id });
      const d = JSON.parse(r.resultForModel);
      const pk = d.product_knowledge || {};
      // Focus the ground truth on verifiable facts (full INGREDIENTS, nutrition,
      // age/stage), and drop the huge reviews/description blobs that would
      // otherwise truncate the ingredients out of the slice.
      d.product_knowledge = {
        Ingredients: strip(pk["Ingredients"]).slice(0, 2000),
        "Nutrition facts": strip(pk["Nutrition facts"]).slice(0, 800),
        "Stage / age range": strip(pk["Stage / age range"]).slice(0, 200),
      };
      out.push({ title: title || d.title || "product", data: JSON.stringify(d).slice(0, 5500) });
    } catch {
      /* skip */
    }
  }
  return out;
}

// ── judge (capable model, structured JSON) ───────────────────────────────────
interface Verdict {
  grounded: boolean;
  accuracy: number; // 1-5
  used_store_data: boolean;
  product_claims_ok: boolean; // product facts match PRODUCT sources; true if no product claims
  context_retained: boolean; // follow-ups: did it use prior turns; true for first turn
  tone_safety_ok: boolean;
  hallucinations: string[];
  verdict: "pass" | "warn" | "fail";
  notes: string;
}

async function judge(args: {
  history: { q: string; a: string }[];
  question: string;
  answer: string;
  isFollowUp: boolean;
  citedTitles: string[];
  sources: { title: string; url: string; text: string }[];
  productSources: { title: string; data: string }[];
}): Promise<Verdict> {
  const sourceBlock = args.sources.length
    ? args.sources.map((s, i) => `### ARTICLE ${i + 1}: ${s.title}\n${s.text.slice(0, 5000)}`).join("\n\n")
    : "(no store articles found for this topic)";
  const productBlock = args.productSources.length
    ? args.productSources.map((p, i) => `### PRODUCT ${i + 1}: ${p.title}\n${p.data}`).join("\n\n")
    : "(no product data — answer made no product claims, or none were carded)";
  const historyBlock = args.history.length
    ? args.history.map((h, i) => `Turn ${i + 1} USER: ${h.q}\nTurn ${i + 1} ASSISTANT: ${h.a}`).join("\n\n")
    : "(none — this is the first turn)";

  const system = `You are a STRICT fact-checker for an Organic's Best baby-formula shopping assistant. The assistant grounds ADVICE in the store's doctor-authored ARTICLES and grounds PRODUCT facts (price, availability, age/stage, ingredients, variants, subscription offers) in live PRODUCT data. Both ground-truth sets are provided below. Judge ONLY against these SOURCES and the conversation — do not use outside knowledge to fill gaps in the assistant's favor. A claim is a "hallucination" if it is stated as fact but is NOT supported by any SOURCE (article OR product), or contradicts one. Be skeptical; default to flagging unsupported specifics (prices, ages/stages, ingredients, medical claims). It is FINE for a product question to be grounded in PRODUCT data rather than articles. Output ONLY JSON.`;

  const user = `CONVERSATION SO FAR:\n${historyBlock}\n\nCURRENT QUESTION (${args.isFollowUp ? "FOLLOW-UP" : "first turn"}):\n${args.question}\n\nASSISTANT ANSWER TO JUDGE:\n${args.answer}\n\nARTICLES THE ASSISTANT CITED (as cards): ${args.citedTitles.join("; ") || "(none)"}\n\n=== ARTICLE SOURCES (ground truth for advice) ===\n${sourceBlock}\n\n=== PRODUCT SOURCES (ground truth for product facts) ===\n${productBlock}\n\nReturn JSON with EXACTLY these keys:
{
  "grounded": boolean,            // are the answer's factual claims supported by the ARTICLE or PRODUCT sources?
  "accuracy": 1-5,                // 5 = fully matches sources, 1 = contradicts/invents
  "used_store_data": boolean,     // did it rely on the store's articles or product data (not generic web knowledge)?
  "product_claims_ok": boolean,   // every product fact (price, availability, age/stage, ingredients, offers) matches a PRODUCT source. true if the answer made NO product claims
  "context_retained": boolean,    // FOLLOW-UP only: did it correctly use earlier turns (resolve "it/that one", no contradiction)? true if first turn
  "tone_safety_ok": boolean,      // appropriate persona; proper caution on medical topics (allergy/CMPA → defer to doctor); no overreach
  "hallucinations": [string],     // specific claims not supported by any SOURCE (empty if none)
  "verdict": "pass" | "warn" | "fail",
  "notes": string                 // one or two sentences of rationale
}`;

  const raw = await judgeComplete(system, user);
  try {
    const j = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, ""));
    return {
      grounded: !!j.grounded,
      accuracy: Number(j.accuracy) || 0,
      used_store_data: !!j.used_store_data,
      product_claims_ok: j.product_claims_ok !== false,
      context_retained: j.context_retained !== false,
      tone_safety_ok: !!j.tone_safety_ok,
      hallucinations: Array.isArray(j.hallucinations) ? j.hallucinations : [],
      verdict: ["pass", "warn", "fail"].includes(j.verdict) ? j.verdict : "warn",
      notes: String(j.notes || ""),
    };
  } catch {
    return { grounded: false, accuracy: 0, used_store_data: false, product_claims_ok: false, context_retained: false, tone_safety_ok: false, hallucinations: ["judge parse error"], verdict: "fail", notes: raw.slice(0, 200) };
  }
}

async function judgeComplete(system: string, user: string): Promise<string> {
  if (process.env.OPENAI_API_KEY) {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const res = await client.chat.completions.create({
      model: JUDGE_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    return res.choices[0]?.message?.content ?? "{}";
  }
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  const res = await client.messages.create({
    model: process.env.JUDGE_CLAUDE_MODEL || "claude-opus-4-8",
    max_tokens: 1500,
    system,
    messages: [{ role: "user", content: `${user}\n\nReturn ONLY the JSON object.` }],
  });
  return res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
}

// ── test cases: article-grounded, multi-turn ─────────────────────────────────
interface Case { name: string; turns: string[] }
const CASES: Case[] = [
  {
    name: "HiPP vs Holle (comparison + follow-ups)",
    turns: [
      "What's the main difference between HiPP and Holle formula?",
      "Which of those two is gentler for a baby with a sensitive tummy?",
      "Does that one come in a stage 1?",
    ],
  },
  {
    name: "Goat milk formula (advice + medical nuance)",
    turns: [
      "Is goat milk formula a good option for babies?",
      "Can it be used if my baby has a cow's milk allergy?",
    ],
  },
  {
    name: "Stage transition (advice + personalized follow-up)",
    turns: [
      "When should I switch my baby from stage 1 to stage 2 formula?",
      "My baby is 5 months old — should I switch now?",
    ],
  },
  {
    name: "Ready-to-feed (newer/live article grounding)",
    turns: [
      "Tell me about ready to feed formula and when it's useful.",
      "Which brands here offer ready to feed?",
    ],
  },
  {
    name: "EU organic certification (knowledge grounding)",
    turns: ["What makes European organic baby formula different from US formula?"],
  },
  {
    name: "Ingredients — palm oil / fish oil (Kendamil, vegetarian)",
    turns: [
      "Does Kendamil Organic formula contain palm oil?",
      "And is there any fish oil in it?",
    ],
  },
  {
    name: "Ingredients — HiPP vs Holle oils",
    turns: [
      "What oils are in HiPP Dutch stage 1 formula?",
      "Does Holle Goat formula contain palm oil?",
    ],
  },
];

// ── run ──────────────────────────────────────────────────────────────────────
interface TurnResult { q: string; a: string; cited: string[]; v: Verdict }
const all: { name: string; turns: TurnResult[] }[] = [];

console.log(`\n🔬 Article-grounding eval  (agent: ${API}, judge: ${process.env.OPENAI_API_KEY ? JUDGE_MODEL : "claude"})\n`);

const RUN_CASES = CASES.filter((c) => !GREP || c.name.toLowerCase().includes(GREP)).slice(0, LIMIT);
for (const cas of RUN_CASES) {
  console.log(`\n▶ ${cas.name}`);
  const sid = `art-${RUN}-${CASES.indexOf(cas)}`;
  const user = `${sid}@t.com`;
  const history: { q: string; a: string }[] = [];
  const turnResults: TurnResult[] = [];
  // Products surfaced earlier in the case — a follow-up ("does that one come in
  // stage 1?") refers back to them, so they're part of its ground truth too.
  const caseProductCards: ProductCard[] = [];

  for (let t = 0; t < cas.turns.length; t++) {
    const q = cas.turns[t];
    const out = await ask(sid, user, q);
    if (out.errors.length) console.log(`   ⚠️ agent error: ${out.errors.join("; ")}`);
    caseProductCards.push(...out.productCards);
    const [sources, productSources] = await Promise.all([
      gatherSources(q, out.articleCards),
      gatherProductSources(caseProductCards, out.answer, q),
    ]);
    const v = await judge({
      history: [...history],
      question: q,
      answer: out.answer,
      isFollowUp: t > 0,
      citedTitles: out.articleCards.map((c) => c.title),
      sources,
      productSources,
    });
    history.push({ q, a: out.answer });
    turnResults.push({ q, a: out.answer, cited: out.articleCards.map((c) => c.title), v });

    const icon = v.verdict === "pass" ? "✅" : v.verdict === "warn" ? "🟡" : "❌";
    console.log(
      `   ${icon} T${t + 1} acc=${v.accuracy}/5 grounded=${v.grounded ? "Y" : "N"} ` +
        `usedData=${v.used_store_data ? "Y" : "N"} productOk=${v.product_claims_ok ? "Y" : "N"} ` +
        `${t > 0 ? `context=${v.context_retained ? "Y" : "N"} ` : ""}` +
        `safe=${v.tone_safety_ok ? "Y" : "N"} art=${turnResults[t].cited.length} prod=${out.productCards.length}`,
    );
    if (v.hallucinations.length) console.log(`        ⚠ hallucinations: ${v.hallucinations.join(" | ")}`);
    if (VERBOSE) {
      console.log(`        Q: ${q}`);
      console.log(`        cited: ${turnResults[t].cited.join("; ") || "(none)"}`);
      console.log(`        notes: ${v.notes}`);
      console.log(`        A: ${out.answer.slice(0, 400).replace(/\n/g, " ")}…`);
    }
  }
  all.push({ name: cas.name, turns: turnResults });
}

// ── report ─────────────────────────────────────────────────────────────────
const flat = all.flatMap((c) => c.turns);
const pass = flat.filter((t) => t.v.verdict === "pass").length;
const warn = flat.filter((t) => t.v.verdict === "warn").length;
const fail = flat.filter((t) => t.v.verdict === "fail").length;
const avgAcc = (flat.reduce((s, t) => s + t.v.accuracy, 0) / (flat.length || 1)).toFixed(2);
const grounded = flat.filter((t) => t.v.grounded).length;
const usedData = flat.filter((t) => t.v.used_store_data).length;
const productOk = flat.filter((t) => t.v.product_claims_ok).length;
const ctxTurns = all.flatMap((c) => c.turns.slice(1));
const ctxOk = ctxTurns.filter((t) => t.v.context_retained).length;
const halluc = flat.reduce((s, t) => s + t.v.hallucinations.length, 0);

console.log(`\n${"─".repeat(60)}`);
console.log(`SUMMARY — ${flat.length} turns across ${all.length} cases`);
console.log(`  ✅ pass ${pass}   🟡 warn ${warn}   ❌ fail ${fail}`);
console.log(`  avg accuracy: ${avgAcc}/5`);
console.log(`  grounded: ${grounded}/${flat.length}   used store data: ${usedData}/${flat.length}   product claims ok: ${productOk}/${flat.length}`);
console.log(`  follow-up context retained: ${ctxOk}/${ctxTurns.length}`);
console.log(`  total hallucinations flagged: ${halluc}`);
console.log(`${"─".repeat(60)}\n`);

process.exit(fail > 0 ? 1 : 0);
