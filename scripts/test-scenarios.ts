// Multi-scenario E2E suite with explicit expectations.
// Run: npx tsx scripts/test-scenarios.ts   (server must be running on :3000)

export {}; // top-level await requires module context

const API = "http://localhost:3000";
const RUN = Math.random().toString(36).slice(2, 7);

interface TurnOut {
  answer: string;
  statuses: string[];
  chips: string[];
  cards: { title: string; variants: any[]; subscriptionOffers?: any[] }[];
  errors: string[];
}

async function ask(sessionId: string, user: string, question: string): Promise<TurnOut> {
  const res = await fetch(`${API}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, sessionId, username: user }),
  });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const out: TurnOut = { answer: "", statuses: [], chips: [], cards: [], errors: [] };
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
        // Suggestions are {label, product?} (cart-add chips carry a product); tolerate legacy strings.
        if (j.suggestions) out.chips = j.suggestions.map((x: any) => (typeof x === "string" ? x : x.label));
        if (j.error) out.errors.push(j.error);
        if (j.tool_response?.rawProducts) out.cards.push(...j.tool_response.rawProducts);
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

type Check = { name: string; pass: boolean; detail?: string };
const results: { scenario: string; checks: Check[] }[] = [];
const c = (name: string, pass: boolean, detail = ""): Check => ({ name, pass, detail });

async function scenario(name: string, fn: () => Promise<Check[]>) {
  process.stdout.write(`\n▶ ${name}\n`);
  try {
    const checks = await fn();
    results.push({ scenario: name, checks });
    for (const ch of checks) console.log(`  ${ch.pass ? "✅" : "❌"} ${ch.name}${ch.detail ? ` — ${ch.detail}` : ""}`);
  } catch (err: any) {
    results.push({ scenario: name, checks: [c("scenario crashed", false, err?.message)] });
    console.log(`  💥 crashed: ${err?.message}`);
  }
}

// ---------------------------------------------------------------------------

await scenario("1. Finder: toddler + constipation + goat + palm-oil-free", async () => {
  const sid = `sc1-${RUN}`,
    u = `sc1-${RUN}@t.com`;
  // One-shot free text: the finder is adaptive, so scripted Q&A answers can
  // land on the wrong question. The full profile up front is deterministic.
  let final = await ask(
    sid,
    u,
    "Help me pick a formula: my daughter is 14 months old, struggles with constipation, we want a goat milk formula and it must be palm-oil free.",
  );
  // if it still asks a follow-up, close it out
  if (!final.cards.length && /\?/.test(final.answer)) final = await ask(sid, u, "no other preferences, please recommend");
  const titles = final.cards.map((x) => x.title);
  return [
    c("recommends goat formula", /goat/i.test(final.answer), final.answer.slice(0, 60)),
    c("age-correct stage (no Pre/Stage 1/2 cards)", !titles.some((t) => /stage (pre|1|2)\b/i.test(t)), titles.join(" | ")),
    c("≤2 cards at consultation close", final.cards.length <= 2, `${final.cards.length}`),
    c("no invented 'Stage 4 Dutch'", !/stage 4.*dutch|dutch.*stage 4/i.test(final.answer)),
  ];
});

await scenario("2. Finder: suspected milk allergy → safety rails", async () => {
  const sid = `sc2-${RUN}`,
    u = `sc2-${RUN}@t.com`;
  await ask(sid, u, "help me choose a formula");
  await ask(sid, u, "0-6 months");
  let final = await ask(sid, u, "we suspect a milk allergy, she gets a rash");
  const sawPediatrician = () => /pediatric/i.test(final.answer);
  let pediatricianMentioned = sawPediatrician();
  // Elicit a concrete product direction (caution-first answers are valid too)
  if (!/\bHA\b|hypoallergenic/i.test(final.answer)) {
    final = await ask(sid, u, "which of your formulas would be gentlest while we wait for the doctor appointment?");
  }
  pediatricianMentioned = pediatricianMentioned || sawPediatrician();
  return [
    c("mentions pediatrician", pediatricianMentioned),
    c("suggests HA / hypoallergenic direction when asked for products", /\bHA\b|hypoallergenic/i.test(final.answer), final.answer.slice(0, 100)),
  ];
});

await scenario("3. Cart: specific add → checkout; ambiguous add → confirm", async () => {
  const sid = `sc3-${RUN}`,
    u = `sc3-${RUN}@t.com`;
  const add = await ask(sid, u, "add one can of HiPP Dutch stage 1 to my cart");
  const ambiguous = await ask(`sc3b-${RUN}`, u, "add to cart");
  return [
    c("specific add returns checkout link", /checkout|\/cart\/c\//i.test(add.answer), add.answer.slice(0, 60)),
    c("cart tool used", add.statuses.includes("updating_cart"), add.statuses.join("→")),
    c("ambiguous add asks for confirmation, no cart call", !ambiguous.statuses.includes("updating_cart") && /\?/.test(ambiguous.answer)),
  ];
});

await scenario("4. Cart continuity: 'make it two' reuses the cart", async () => {
  const sid = `sc4-${RUN}`,
    u = `sc4-${RUN}@t.com`;
  const Database = (await import("better-sqlite3")).default;
  const db = new Database("data/ob-agent.db");
  const cartIdInDb = () => (db.prepare("SELECT cart_id FROM session_state WHERE session_id = ?").get(sid) as any)?.cart_id;

  const a = await ask(sid, u, "add one can of HiPP Dutch stage 1 to my cart");
  const cartAfterAdd = cartIdInDb();
  const b = await ask(sid, u, "make it two cans");
  const cartAfterUpdate = cartIdInDb();
  return [
    c("cart created on add", !!cartAfterAdd && a.statuses.includes("updating_cart")),
    // The invariant: the persisted cart id does not change when quantities update
    c("same cart id across turns (DB)", !!cartAfterAdd && cartAfterAdd === cartAfterUpdate, `${cartAfterAdd} vs ${cartAfterUpdate}`),
    c("cart tool used on update", b.statuses.some((s) => s.includes("cart")), b.statuses.join("→")),
  ];
});

await scenario("5. Shipping: US flat rate + threshold upsell; DE free", async () => {
  const us = await ask(`sc5-${RUN}`, `sc5-${RUN}@t.com`, "how much is shipping to the US?");
  const upsell = await ask(`sc5-${RUN}`, `sc5-${RUN}@t.com`, "whats my total for 3 cans of HiPP Dutch stage 2 shipped to the US?");
  let de = await ask(`sc5c-${RUN}`, `sc5-${RUN}@t.com`, "how much is shipping to Germany for one can of HiPP Dutch stage 2?");
  // conversational variance: if it asked a clarifying question, answer it once
  if (!/free|0[.,]00/i.test(de.answer)) de = await ask(`sc5c-${RUN}`, `sc5-${RUN}@t.com`, "just the standard option please");
  return [
    c("US: $34.95 under $190 quoted", /34\.95/.test(us.answer)),
    c("US: free at $190+ mentioned", /190/.test(us.answer)),
    c("first-order free mentioned", /first order/i.test(us.answer)),
    c("no ZIP interrogation", !/zip/i.test(us.answer)),
    c("threshold upsell on $184.92 order", /190|free shipping/i.test(upsell.answer), upsell.answer.slice(-150)),
    c("Germany: free shipping", /free|0[.,]00/i.test(de.answer) && !/34\.95/.test(de.answer), de.answer.slice(0, 100)),
  ];
});

await scenario("6. Ingredients grounded in metafields", async () => {
  const r = await ask(`sc6-${RUN}`, `sc6-${RUN}@t.com`, "does HiPP Dutch stage 2 contain palm oil? how much iron per 100ml?");
  return [
    c("palm oil correctly confirmed", /palm oil/i.test(r.answer) && !/does not contain palm|no palm/i.test(r.answer)),
    c("iron value from nutrition facts (1.0 mg)", /1[.,]0\s*mg|1\s*mg/.test(r.answer), r.answer.match(/iron[^.]*\./i)?.[0]?.slice(0, 80) ?? ""),
  ];
});

await scenario("7. Subscriptions: real offers incl. starter bundle", async () => {
  const r = await ask(`sc7-${RUN}`, `sc7-${RUN}@t.com`, "are there subscription deals on HiPP Dutch stage 2? I want to save money");
  const cardOffers = r.cards.flatMap((x) => x.subscriptionOffers ?? []);
  return [
    c("quotes the starter bundle price 149.97", /149\.97/.test(r.answer), r.answer.match(/149[^ ]*/)?.[0] ?? "not found"),
    c("includes a subscribe deep link", /selling_plan=/.test(r.answer)),
    c("card carries subscription offers", cardOffers.length > 0, `${cardOffers.length} offers`),
  ];
});

await scenario("8. Cross-turn reference: 'the dutch one'", async () => {
  const sid = `sc8-${RUN}`,
    u = `sc8-${RUN}@t.com`;
  await ask(sid, u, "tell me about holle goat stage 1");
  await ask(sid, u, "and hipp dutch stage 1?");
  const r = await ask(sid, u, "what are the ingredients of the dutch one?");
  return [
    c("resolves 'the dutch one' to HiPP Dutch", /hipp dutch/i.test(r.answer)),
    c("answers with ingredients, no apology", /lactose|skimmed|milk/i.test(r.answer) && !/wasn't able|unable to retrieve/i.test(r.answer)),
  ];
});

await scenario("9. Memory hygiene: product allergens ≠ baby allergies", async () => {
  const u = `sc9-${RUN}@t.com`;
  await ask(`sc9-${RUN}`, u, "my son is 5 months old. what are the ingredients and allergens of HiPP German stage 1?");
  await new Promise((r) => setTimeout(r, 15000)); // let extraction run
  const Database = (await import("better-sqlite3")).default;
  const db = new Database("data/ob-agent.db");
  const facts = db.prepare("SELECT fact FROM user_memories WHERE user_id = ?").all(u) as any[];
  return [
    c("no allergy facts stored from product data", !facts.some((f) => /allerg/i.test(f.fact)), facts.map((f) => f.fact).join("; ").slice(0, 120)),
    c("age fact stored", facts.some((f) => /born|month/i.test(f.fact))),
  ];
});

await scenario("10. Chips: multiple-choice mirrors options; no generic cart chip", async () => {
  const q = await ask(`sc10-${RUN}`, `sc10-${RUN}@t.com`, "🍼 Find the right formula");
  const multi = await ask(`sc10b-${RUN}`, `sc10-${RUN}@t.com`, "what cow formulas do you have for a 6 month old?");
  const optionsInText = (q.answer.match(/\(([^)]+·[^)]+)\)/)?.[1] ?? "").split("·").map((s) => s.trim()).filter(Boolean);
  const mirrored = optionsInText.length > 0 && optionsInText.every((o) => q.chips.some((ch) => ch.replace(/\s+/g, " ").trim() === o));
  return [
    c("finder question chips mirror options verbatim", mirrored, `opts:[${optionsInText.join(",")}] chips:[${q.chips.join(",")}]`),
    c("multi-product answer has no generic 'Add to cart' chip", !multi.chips.some((ch) => /^add to cart$/i.test(ch.trim())), multi.chips.join(", ")),
  ];
});

// ---------------------------------------------------------------------------

console.log("\n" + "=".repeat(64));
console.log("SUMMARY");
console.log("=".repeat(64));
let failed = 0;
for (const r of results) {
  const ok = r.checks.filter((ch) => ch.pass).length;
  const all = r.checks.length;
  if (ok < all) failed++;
  console.log(`${ok === all ? "✅" : "❌"} ${r.scenario} — ${ok}/${all}`);
  for (const ch of r.checks.filter((x) => !x.pass)) console.log(`     ✗ ${ch.name}${ch.detail ? ` (${ch.detail})` : ""}`);
}
console.log(`\n${failed === 0 ? "🎉 ALL SCENARIOS PASSED" : `🔴 ${failed} scenario(s) with failures`}`);
process.exit(failed === 0 ? 0 : 1);
