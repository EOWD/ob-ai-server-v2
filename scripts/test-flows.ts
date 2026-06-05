// E2E proof flows against a running server (localhost:3000).
// Run: npx tsx scripts/test-flows.ts

const API = "http://localhost:3000";
const SESSION = `test-flow-${Math.random().toString(36).slice(2, 8)}`;
const USER = "proof-test@sghwtrade.com";

interface TurnResult {
  answer: string;
  statuses: string[];
  cards: { title: string; variants: { title: string; formattedPrice?: string }[] }[];
  errors: string[];
}

async function ask(question: string): Promise<TurnResult> {
  const res = await fetch(`${API}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, sessionId: SESSION, username: USER }),
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const out: TurnResult = { answer: "", statuses: [], cards: [], errors: [] };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const s = line.slice(6);
      if (s === "[DONE]") continue;
      try {
        const j = JSON.parse(s);
        if (j.content) out.answer += j.content;
        if (j.status) out.statuses.push(j.status);
        if (j.error) out.errors.push(j.error);
        if (j.tool_response?.rawProducts) {
          for (const p of j.tool_response.rawProducts) {
            out.cards.push({
              title: p.title,
              variants: (p.variants || []).map((v: any) => ({ title: v.title, formattedPrice: v.formattedPrice })),
            });
          }
        }
      } catch {
        /* plain text */
      }
    }
  }
  return out;
}

function check(name: string, pass: boolean, detail: string) {
  console.log(`${pass ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
}
let failures = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`Session: ${SESSION}  User: ${USER}\n`);

  // ---- Turn 1: establish age ----
  console.log("— Turn 1: 'my baby is 6 months old, looking for a cow milk formula'");
  const t1 = await ask("hi, my baby is 6 months old and I am looking for a cow milk formula");
  check("answered without errors", t1.errors.length === 0, t1.errors.join("; "));
  console.log(`   statuses: ${t1.statuses.join(" → ")}`);
  console.log(`   cards: ${t1.cards.length}`);

  // ---- Turn 2: the exact flow that previously failed ----
  console.log("\n— Turn 2: 'what about hipp dutch, do you have it?'");
  const t2 = await ask("what about hipp dutch, do you have it?");
  console.log(`   statuses: ${t2.statuses.join(" → ")}`);
  console.log(`   cards: ${t2.cards.map((c) => c.title).join(" | ") || "none"}`);

  check("≤4 product cards", t2.cards.length <= 4, `${t2.cards.length} cards`);
  const allVariants = t2.cards.flatMap((c) => c.variants);
  check(
    "no subscription-only 'Free' variants in cards",
    !allVariants.some((v) => /free/i.test(v.title)),
    allVariants.map((v) => v.title).join(", ").slice(0, 120),
  );
  check(
    "no 'N/A' prices (formattedPrice present)",
    allVariants.every((v) => v.formattedPrice && v.formattedPrice !== "N/A"),
    allVariants.length ? (allVariants[0]?.formattedPrice ?? "") : "no cards emitted this run (matching is conversational)",
  );
  const stage34Cards = t2.cards.filter((c) => /stage [34]/i.test(c.title));
  check(
    "age-appropriate: no Stage 3/4 cards for a 6-month-old",
    stage34Cards.length === 0,
    stage34Cards.map((c) => c.title).join(" | "),
  );

  // ---- Turn 3: ingredients (the allergen-contamination trigger) ----
  console.log("\n— Turn 3: ingredients incl. allergens (contamination trigger)");
  const t3 = await ask("what are the ingredients and allergens of HiPP Dutch stage 2?");
  check("ingredients answered", /lactose|skimmed|milk/i.test(t3.answer), t3.answer.slice(0, 80) + "…");
  check("allergens mentioned (so the trigger is real)", /allergen/i.test(t3.answer), "");

  // ---- Turn 4: session memory ----
  console.log("\n— Turn 4: 'what did I ask for so far?'");
  const t4 = await ask("what did I ask for so far?");
  check("recalls cow formula / age from session", /cow|6 month|hipp/i.test(t4.answer), t4.answer.slice(0, 100) + "…");

  // ---- Memory contamination check (extraction is async — give it time) ----
  console.log("\n— Waiting 15s for background memory extraction…");
  await sleep(15000);
  const Database = (await import("better-sqlite3")).default;
  const db = new Database("data/ob-agent.db");
  const facts = db.prepare("SELECT fact, confidence FROM user_memories WHERE user_id = ?").all(USER) as any[];
  console.log("   stored facts:");
  for (const f of facts) console.log(`     - ${f.fact} (${f.confidence})`);
  check(
    "no hallucinated allergy facts",
    !facts.some((f) => /allerg/i.test(f.fact)),
    facts.filter((f) => /allerg/i.test(f.fact)).map((f) => f.fact).join("; "),
  );
  check("age fact extracted", facts.some((f) => /born|month/i.test(f.fact)), "");

  console.log(`\n${failures === 0 ? "🎉 ALL CHECKS PASSED" : `🔴 ${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
