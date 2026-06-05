// The agent loop: provider-neutral tool-use loop, emitting SSE-friendly
// events through a callback so the route stays transport-only.

import { config } from "./config.js";
import { DOMAIN_PROMPT } from "./prompt.js";
import { TOOL_STATUS, executeTool } from "./tools/index.js";
import { memory } from "./memory.js";
import { getUserMemories, extractAndStoreMemories } from "./user-memory.js";
import { maybeSummarize } from "./summarizer.js";
import type { AgentTurn, LlmProvider, ToolResult } from "./providers/types.js";

const MAX_TOOL_ROUNDS = 8;

async function getProvider(): Promise<LlmProvider> {
  if (config.provider === "openai") {
    const { openaiProvider } = await import("./providers/openai.js");
    return openaiProvider;
  }
  const { anthropicProvider } = await import("./providers/anthropic.js");
  return anthropicProvider;
}

/** A tappable quick-reply. Cart-add suggestions carry the product they refer
 * to (image + price) so the client can render them as a mini product card
 * instead of a bare text chip; everything else is label-only. */
export interface SuggestionItem {
  label: string;
  product?: { title: string; image: string; price?: string };
}

export interface AgentEvents {
  onText(delta: string): void;
  onStatus(status: string): void;
  onToolResponse(payload: unknown): void;
  onSuggestions(suggestions: SuggestionItem[]): void;
  onError(message: string): void;
  onDone(): void;
}

/** 2-4 short follow-up chips the customer can tap. Best-effort, never throws. */
async function generateSuggestions(question: string, answer: string): Promise<string[]> {
  try {
    const { smallCompletion } = await import("./small-llm.js");
    const out = await smallCompletion(
      `You suggest quick replies for a baby-formula store chat. Given the last exchange, propose 3 short follow-ups the CUSTOMER is most likely to tap next, written in the customer's voice (max 7 words each).
Rules:
- HIGHEST PRIORITY: if the assistant asked a multiple-choice question (options usually in parentheses separated by " · "), the suggestions MUST be exactly those options, verbatim, in order (up to 5) — nothing else. This makes the question tappable.
- Cart suggestions MUST name the specific product from the answer (e.g. "Add HiPP Dutch Stage 2 to cart"). If the answer doesn't recommend one specific product, do NOT suggest adding to cart at all.
- Otherwise prefer concrete next actions: comparing named options, preparation, ingredients, shipping cost, subscription savings.
Respond with ONLY a JSON array of strings.`,
      `Customer: ${question.slice(0, 500)}\n\nAssistant: ${answer.slice(0, 1500)}`,
    );
    const parsed = JSON.parse(out.replace(/^```(json)?|```$/g, "").trim());
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string" && s.trim()).slice(0, 5) : [];
  } catch {
    return [];
  }
}

/** Cart-add quick replies ("Add HiPP Dutch Stage 2 to cart", "Add a 4th can") —
 * these get a product thumbnail + price attached so the client renders a card. */
const CART_SUGGESTION_RE = /\b(add|buy|order|grab|get)\b.*\bcart\b|^\s*add\b/i;

/**
 * Attach the product a cart-add suggestion refers to (image + price), matched
 * against the cards shown this turn, so the client can render it as a mini
 * card. Non-cart suggestions, and ones we can't confidently match to a product
 * with an image, stay label-only (rendered as plain chips).
 */
function enrichSuggestions(suggestions: string[], cards: any[]): SuggestionItem[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return suggestions.map((label) => {
    if (!CART_SUGGESTION_RE.test(label)) return { label };
    const sNorm = norm(label);
    let match = cards.find((c) => {
      const title = norm(String(c.title || "").split("(")[0]);
      const short = title.split(" ").slice(0, 6).join(" ");
      return short.length > 8 && sNorm.includes(short);
    });
    // Deal-finder upsells ("add a 4th can") name no product — fall back to the
    // single product shown this turn when that's unambiguous.
    if (!match && cards.length === 1) match = cards[0];
    const image = match?.featuredImage?.url;
    if (!match || !image) return { label };
    return {
      label,
      product: { title: match.title, image, price: match.variants?.[0]?.formattedPrice || undefined },
    };
  });
}

/**
 * Keep only cards whose product the answer actually mentions — matched by
 * URL handle or normalized title. Falls back to the first card if the answer
 * clearly recommends something but matching failed.
 */
function filterCardsByAnswer(cards: any[], answer: string): any[] {
  const seen = new Set<string>();
  const unique = cards.filter((c) => {
    const key = c.id || c.onlineStoreUrl || c.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const answerNorm = norm(answer);
  const matched = unique.filter((c) => {
    const handle = String(c.onlineStoreUrl || "").split("/products/")[1]?.split("?")[0];
    if (handle && answer.includes(handle)) return true;
    const title = norm(String(c.title || "").split("(")[0]);
    if (title.length > 8 && answerNorm.includes(title)) return true;
    // Models often shorten names ("HiPP Dutch Stage 2 Combiotic Formula") —
    // match a 6-word prefix, which keeps the stage token ("holle goat milk
    // formula stage 4") so product families don't all match each other.
    const shortTitle = title.split(" ").slice(0, 6).join(" ");
    return shortTitle.length > 8 && answerNorm.includes(shortTitle);
  });
  return matched.slice(0, 4);
}

/**
 * Per-turn context block. Injected into the CURRENT user turn (not persisted,
 * and never into the system prompt — that stays frozen for prompt caching).
 */
function buildContextBlock(opts: {
  summary?: string;
  cartId?: string;
  memories: { fact: string; confidence: string }[];
  recentProducts?: { id: string; title: string; url?: string }[];
  customerName?: string;
}): string {
  const parts: string[] = [];
  if (opts.customerName) {
    parts.push(`The customer is signed in as ${opts.customerName}. Greet them by first name when natural — don't overuse it.`);
  }
  if (opts.recentProducts?.length) {
    parts.push(
      `Products discussed earlier in this conversation (use these exact ids — never guess ids):\n${opts.recentProducts
        .map((p) => {
          const variants = (p as any).variants?.length
            ? `\n  variants: ${(p as any).variants.map((v: any) => `${v.title}=${v.id}`).join(" ; ")}`
            : "";
          return `- ${p.title} → ${p.id}${variants}`;
        })
        .join("\n")}`,
    );
  }
  if (opts.memories.length) {
    parts.push(
      `Known about this customer from previous conversations:\n${opts.memories
        .map((m) => `- ${m.fact}${m.confidence === "inferred" ? " (inferred)" : ""}`)
        .join("\n")}`,
    );
  }
  if (opts.summary) parts.push(`Earlier in this conversation (summary):\n${opts.summary}`);
  if (opts.cartId) {
    parts.push(`The customer has an active cart: ${opts.cartId} — pass this cart_id to update_cart/get_cart instead of creating a new cart.`);
  }
  if (!parts.length) return "";
  return `<session_context>\n${parts.join("\n\n")}\n</session_context>\n\n`;
}

export async function runAgent(
  question: string,
  sessionId: string,
  userId: string | undefined,
  events: AgentEvents,
  customerToken?: string,
  appCartId?: string,
): Promise<void> {
  const provider = await getProvider();
  // Returning customers (2+ orders) must not see new-customer starter offers.
  // The same pre-flight call carries the customer's name for personalization.
  let isReturningCustomer = false;
  let customerName: string | undefined;
  if (customerToken) {
    try {
      const { getMyOrders } = await import("./tools/customer.js");
      const r: any = await getMyOrders(customerToken, 2);
      isReturningCustomer = (r?.orders?.length ?? 0) >= 2;
      customerName = r?.name;
    } catch {
      /* default: eligible */
    }
  }
  const history = await memory.getHistory(sessionId);
  const state = await memory.getState(sessionId);
  // Cart unity: the app passes its own Storefront cart id so agent cart
  // operations land in the SAME cart the customer sees in the Cart tab.
  if (appCartId && state.cartId !== appCartId) {
    state.cartId = appCartId;
    await memory.saveState(sessionId, { cartId: appCartId, userId });
  }
  const memories = userId ? getUserMemories(userId) : [];

  const contextBlock = buildContextBlock({
    summary: state.summary,
    cartId: state.cartId,
    memories,
    recentProducts: state.recentProducts,
    customerName,
  });
  let recentProducts = [...(state.recentProducts ?? [])];

  const turns: AgentTurn[] = [
    ...history.map(
      (m): AgentTurn =>
        m.role === "user"
          ? { role: "user", text: m.content }
          : { role: "assistant", text: m.content, toolCalls: [] },
    ),
    { role: "user", text: contextBlock + question },
  ];

  let fullAnswer = "";
  let activeCartId = state.cartId;
  // Product cards are collected during the turn but only emitted at the end.
  // Primary selection: the model calls display_product_cards with the ids it
  // recommends. Fallback: match candidates against the final answer text.
  const candidateCards: any[] = [];
  let chosenProductIds: string[] = [];

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const { text, toolCalls } = await provider.streamTurn({
        system: DOMAIN_PROMPT,
        turns,
        onText: (delta) => {
          fullAnswer += delta;
          events.onText(delta);
        },
      });

      if (toolCalls.length === 0) break;

      turns.push({ role: "assistant", text, toolCalls });

      const results: ToolResult[] = [];
      for (const tc of toolCalls) {
        if (tc.name === "display_product_cards") {
          // Selection signal — record which products the model is recommending
          const ids = Array.isArray(tc.input?.product_ids) ? tc.input.product_ids : [];
          chosenProductIds = ids.filter((id: unknown) => typeof id === "string").slice(0, 4);
          results.push({ toolCallId: tc.id, content: JSON.stringify({ ok: true }) });
          continue;
        }
        events.onStatus(TOOL_STATUS[tc.name] ?? "working");
        console.log(`[tool] ${sessionId} ${tc.name} ${JSON.stringify(tc.input)?.slice(0, 300)}`);
        try {
          const outcome = await executeTool(tc.name, tc.input, { customerToken, isReturningCustomer });
          if (outcome.uiPayload?.type === "product_list") {
            candidateCards.push(...((outcome.uiPayload as any).rawProducts ?? []));
          } else if (outcome.uiPayload) {
            events.onToolResponse(outcome.uiPayload);
          }
          if (outcome.stateUpdates?.cartId) {
            activeCartId = outcome.stateUpdates.cartId;
            await memory.saveState(sessionId, { cartId: activeCartId, userId });
          }
          if (outcome.stateUpdates?.recentProducts?.length) {
            // newest first, dedupe by id, keep 8
            const merged = [...outcome.stateUpdates.recentProducts, ...recentProducts];
            const seen = new Set<string>();
            recentProducts = merged.filter((p) => p.id && !seen.has(p.id) && seen.add(p.id)).slice(0, 8);
            await memory.saveState(sessionId, { recentProducts, userId });
          }
          results.push({ toolCallId: tc.id, content: outcome.resultForModel });
        } catch (err: any) {
          results.push({
            toolCallId: tc.id,
            content: JSON.stringify({ error: err?.message ?? "tool failed" }),
            isError: true,
          });
        }
      }
      turns.push({ role: "toolResults", results });
    }

    // Cards: model's explicit selection wins; text matching is the fallback —
    // including when the selected ids match nothing (models sometimes pass
    // handles or truncated gids).
    const seenIds = new Set<string>();
    const uniqueCandidates = candidateCards.filter((c) => {
      const k = c.id || c.onlineStoreUrl || c.title;
      if (seenIds.has(k)) return false;
      seenIds.add(k);
      return true;
    });
    let referenced: any[] = [];
    if (chosenProductIds.length) {
      referenced = uniqueCandidates
        .filter((card) =>
          chosenProductIds.some((id) => card.id === id || String(card.id).endsWith(id) || id.endsWith(String(card.id))),
        )
        .slice(0, 4);
    }
    if (!referenced.length) referenced = filterCardsByAnswer(uniqueCandidates, fullAnswer);
    if (referenced.length) {
      const { fetchSubscriptionOffers, filterOffersForCustomer } = await import("./tools/shopify.js");
      await Promise.all(
        referenced.map(async (card) => {
          try {
            card.subscriptionOffers = filterOffersForCustomer(await fetchSubscriptionOffers(card.id, card.onlineStoreUrl), isReturningCustomer).slice(0, 4);
          } catch {
            card.subscriptionOffers = [];
          }
        }),
      );
      events.onToolResponse({ type: "product_list", rawProducts: referenced });
    }

    // Persist the raw turn (without the injected context block)
    await memory.append(sessionId, { role: "user", content: question, timestamp: Date.now() });
    await memory.append(sessionId, { role: "assistant", content: fullAnswer, timestamp: Date.now() });
    if (userId) await memory.saveState(sessionId, { userId });

    // Tell the app which cart the agent used so it can adopt/refresh it
    if (activeCartId) events.onToolResponse({ type: "cart_id", cart_id: activeCartId });

    events.onStatus("completed");

    // Quick-reply chips (after "completed" so the answer never waits on this).
    // Cart-add chips are enriched with the product they name (image + price)
    // so the client renders them as mini cards; tapping still sends the label
    // and runs the normal size/quantity flow.
    const suggestions = await generateSuggestions(question, fullAnswer);
    if (suggestions.length) events.onSuggestions(enrichSuggestions(suggestions, referenced));

    events.onDone();

    // Background maintenance — never blocks or breaks the response
    maybeSummarize(sessionId).catch((e) => console.error("summarizer:", e?.message));
    if (userId) {
      extractAndStoreMemories(userId, `USER: ${question}\nASSISTANT: ${fullAnswer}`).catch((e) =>
        console.error("memory extraction:", e?.message),
      );
    }
  } catch (err: any) {
    console.error(`Agent error (${provider.name}):`, err);
    events.onError(err?.message ?? "Something went wrong");
    events.onDone();
  }
}
