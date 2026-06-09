// Proxy tools for the store's Shopify Storefront MCP endpoint.
// The endpoint is unauthenticated JSON-RPC: https://{store}/api/mcp

import { MCP_ENDPOINT, config } from "../config.js";

// --- Product metafields (Storefront GraphQL) --------------------------------
// The MCP tools don't expose metafields, but the store keeps its richest
// product knowledge there (ingredients, nutrition facts, preparation, feeding
// tables). Extend this list as more namespace/keys are confirmed —
// see Shopify Admin → Settings → Custom data → Products.

const PRODUCT_METAFIELDS: { namespace: string; key: string; label: string }[] = [
  { namespace: "tabs", key: "ingredients", label: "Ingredients" },
  { namespace: "tabs", key: "nutritionfacts", label: "Nutrition facts" },
  { namespace: "tabs", key: "nutritionfactsnote", label: "Nutrition facts note" },
  { namespace: "tabs", key: "preparation_steps", label: "Preparation steps" },
  { namespace: "tabs", key: "preparation_notes", label: "Preparation notes" },
  { namespace: "tabs", key: "feedingtable", label: "Feeding table" },
  { namespace: "tabs", key: "frequently_asked_questions", label: "FAQ" },
  { namespace: "custom", key: "reviews_schema", label: "Customer reviews" },
  { namespace: "product", key: "description_1", label: "Product description (part 1)" },
  { namespace: "product", key: "description_2", label: "Product description (part 2)" },
  { namespace: "info", key: "stage", label: "Stage / age range" },
  { namespace: "custom", key: "product_type_filter", label: "Product type" },
];

export async function fetchProductMetafields(productId: string): Promise<Record<string, string>> {
  const query = `query($id: ID!, $ids: [HasMetafieldsIdentifier!]!) {
    product(id: $id) { metafields(identifiers: $ids) { namespace key value } }
  }`;
  const res = await fetch(`https://${config.shopifyDomain}/api/2024-04/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Storefront-Access-Token": process.env.SHOPIFY_STOREFRONT_TOKEN || "",
    },
    body: JSON.stringify({
      query,
      variables: {
        id: productId,
        ids: PRODUCT_METAFIELDS.map(({ namespace, key }) => ({ namespace, key })),
      },
    }),
  });
  const json: any = await res.json();
  const out: Record<string, string> = {};
  const fields = json?.data?.product?.metafields ?? [];
  fields.forEach((f: any, i: number) => {
    if (f?.value) out[PRODUCT_METAFIELDS[i].label] = normalizeMetafieldValue(f.value);
  });
  return out;
}

/** Metafields come as HTML, Shopify rich-text JSON, or app JSON — normalize all to readable text. */
function normalizeMetafieldValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      // Shopify rich text: {type: "root", children: [...]}
      if (parsed?.type === "root") return richTextToPlain(parsed).replace(/\n{3,}/g, "\n\n").trim();
      // Reviews schema: {total, average, reviews: [{author, rating, body...}]}
      if (Array.isArray(parsed?.reviews)) {
        const head = `${parsed.average}/5 stars from ${parsed.total} reviews.`;
        const samples = parsed.reviews
          .slice(0, 3)
          .map((r: any) => `"${(r.body || r.content || "").slice(0, 200)}" — ${r.author || "customer"} (${r.rating}/5)`)
          .join("\n");
        return `${head}\n${samples}`;
      }
      return JSON.stringify(parsed).slice(0, 1500);
    } catch {
      /* fall through to HTML handling */
    }
  }
  return stripHtmlKeepStructure(value);
}

function richTextToPlain(node: any): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  const inner = (node.children ?? []).map(richTextToPlain).join("");
  if (node.type === "heading" || node.type === "paragraph" || node.type === "list-item") return inner + "\n";
  return inner;
}

/** Strip tags but keep table/list structure readable for the model. */
function stripHtmlKeepStructure(html: string): string {
  return html
    .replace(/<\/(tr|p|li|table)>/gi, "\n")
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

let rpcId = 0;

export async function callStoreMcp(toolName: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(MCP_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      id: ++rpcId,
      params: { name: toolName, arguments: args },
    }),
  });
  if (!res.ok) throw new Error(`Store MCP ${toolName} failed: HTTP ${res.status}`);
  const json: any = await res.json();
  if (json.error) throw new Error(`Store MCP ${toolName} error: ${json.error.message}`);
  // MCP tool results carry content blocks; structured payloads land in
  // structuredContent when present, else parse the text block.
  const result = json.result;
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.find((c: any) => c.type === "text")?.text;
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result;
}

// --- Mapping helpers -------------------------------------------------------

/**
 * Storefront one-time purchase rules, mirrored from the theme's
 * custom-subscription-widget.liquid: variants containing "free" are
 * subscription-only bundles; sizes starting with "2"/"4" are starter-plan
 * sizes; "8" bundles are hidden for can products except HiPP UK.
 */
export function filterOneTimeVariants(product: any): any[] {
  const variants: any[] = product.variants || [];
  const firstTitle = String(variants[0]?.title || "").toLowerCase();
  const isCanProduct = firstTitle.includes("can") && !firstTitle.includes("box");
  const isHippUk = ["title", "vendor", "product_type"]
    .map((f) => String(product[f] || "").toLowerCase())
    .some((s) => s.includes("hipp uk") || s.includes("hipp-uk") || s.includes("hipp_uk"));

  return variants.filter((v) => {
    const title = String(v.title || "").toLowerCase();
    if (title.includes("free")) return false; // subscription-only bundle
    const first = title.split(" ")[0];
    if (first === "2" || first === "4") return false; // starter-plan sizes
    if (first === "8" && isCanProduct && !isHippUk) return false;
    return true;
  });
}

// --- Subscription offers (Storefront GraphQL selling plans) -----------------
// Requires the token scope `unauthenticated_read_selling_plans`.

/** Starter/trial plans are new-customer offers — hidden for returning customers
 * (2+ orders), mirroring the theme widget and the mobile product page. */
export const STARTER_PLAN_RE = /starter|trial|\btry\b/i;

export function filterOffersForCustomer(offers: SubscriptionOffer[], isReturningCustomer: boolean): SubscriptionOffer[] {
  if (!isReturningCustomer) return offers;
  return offers.filter((o) => !STARTER_PLAN_RE.test(o.planName) && !/\+\s*1\s*free can|3\s*\+\s*1/i.test(o.variantTitle));
}

export interface SubscriptionOffer {
  variantTitle: string;
  planName: string;
  /** Formatted subscription price, e.g. "44.99 USD" */
  price: string;
  /** Formatted one-time price for comparison (compareAt), if present */
  compareAtPrice?: string;
  /** Product page URL with variant + plan preselected */
  url: string;
  /** Full variant gid — pass to update_cart as product_variant_id to add this offer. */
  variantId: string;
  /** Full selling-plan gid — pass to update_cart as selling_plan_id to add as a subscription. */
  sellingPlanId: string;
}

export async function fetchSubscriptionOffers(productId: string, productUrl: string): Promise<SubscriptionOffer[]> {
  const query = `query($id: ID!) {
    product(id: $id) {
      variants(first: 30) { edges { node {
        id title
        sellingPlanAllocations(first: 5) { edges { node {
          sellingPlan { id name }
          priceAdjustments { price { amount currencyCode } compareAtPrice { amount currencyCode } }
        } } }
      } } }
    }
  }`;
  const res = await fetch(`https://${config.shopifyDomain}/api/2024-04/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Storefront-Access-Token": process.env.SHOPIFY_STOREFRONT_TOKEN || "",
    },
    body: JSON.stringify({ query, variables: { id: productId } }),
  });
  const json: any = await res.json();
  if (json.errors) return []; // scope missing or other failure — degrade quietly

  // One offer per variant: pick the cheapest allocation (delivery frequencies
  // share a price, so this collapses "every 28/45/60 days" duplicates and
  // surfaces real deals like the half-price starter bundle).
  const offers: SubscriptionOffer[] = [];
  for (const vEdge of json?.data?.product?.variants?.edges ?? []) {
    const v = vEdge.node;
    let best: { amount: number; node: any } | null = null;
    for (const aEdge of v.sellingPlanAllocations?.edges ?? []) {
      const amount = Number(aEdge.node.priceAdjustments?.[0]?.price?.amount ?? NaN);
      if (!Number.isFinite(amount)) continue;
      if (!best || amount < best.amount) best = { amount, node: aEdge.node };
    }
    if (!best) continue;
    const adj = best.node.priceAdjustments[0];
    const compareAt = Number(adj.compareAtPrice?.amount ?? NaN);
    const planId = String(best.node.sellingPlan?.id || "").split("/").pop();
    offers.push({
      variantTitle: v.title,
      planName: best.node.sellingPlan?.name || "Subscription",
      price: `${best.amount.toFixed(2)} ${adj.price.currencyCode}`,
      compareAtPrice:
        Number.isFinite(compareAt) && compareAt > best.amount
          ? `${compareAt.toFixed(2)} ${adj.price.currencyCode}`
          : undefined,
      url: `${productUrl}?variant=${String(v.id).split("/").pop()}&selling_plan=${planId}`,
      variantId: String(v.id),
      sellingPlanId: String(best.node.sellingPlan?.id || ""),
    });
  }
  // Real discounts first (starter bundles, free-can deals), then by price
  offers.sort((a, b) => Number(!!b.compareAtPrice) - Number(!!a.compareAtPrice) || parseFloat(a.price) - parseFloat(b.price));
  return offers;
}

// --- Cart with selling plans (Storefront Cart API) --------------------------
// The Storefront MCP cart tool can't add a sellingPlanId, so subscription lines
// go through the Storefront Cart API directly. Same Storefront cart id the MCP
// uses, so it stays the one shared cart.

export interface CartLineInput {
  merchandiseId: string; // variant gid
  quantity: number;
  sellingPlanId?: string; // omit for a one-time line
  attributes?: { key: string; value: string }[]; // e.g. _source for attribution
}

const CART_RETURN_FIELDS = `id checkoutUrl totalQuantity cost { totalAmount { amount currencyCode } } lines(first: 50) { edges { node { id quantity attributes { key value } sellingPlanAllocation { sellingPlan { id name } } merchandise { ... on ProductVariant { id title product { title } } } } } }`;

async function storefront(query: string, variables: Record<string, unknown>): Promise<any> {
  const res = await fetch(`https://${config.shopifyDomain}/api/2024-04/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Storefront-Access-Token": process.env.SHOPIFY_STOREFRONT_TOKEN || "",
    },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

/** Add lines (one-time and/or subscription) to a cart, creating one if needed.
 *  Returns the cart { id, checkoutUrl, ... } or throws the userError. */
export async function cartAddLines(cartId: string | undefined, lines: CartLineInput[]): Promise<any> {
  if (!cartId) {
    const j = await storefront(
      `mutation($lines:[CartLineInput!]!){ cartCreate(input:{lines:$lines}){ cart { ${CART_RETURN_FIELDS} } userErrors { message } } }`,
      { lines },
    );
    const p = j?.data?.cartCreate;
    if (!p?.cart) throw new Error(p?.userErrors?.[0]?.message || j?.errors?.[0]?.message || "cartCreate failed");
    return p.cart;
  }
  const j = await storefront(
    `mutation($cartId:ID!,$lines:[CartLineInput!]!){ cartLinesAdd(cartId:$cartId, lines:$lines){ cart { ${CART_RETURN_FIELDS} } userErrors { message } } }`,
    { cartId, lines },
  );
  const p = j?.data?.cartLinesAdd;
  if (!p?.cart) throw new Error(p?.userErrors?.[0]?.message || j?.errors?.[0]?.message || "cartLinesAdd failed");
  return p.cart;
}

/**
 * Parse the age range from a product title ("6-12 Months", "10+ Months",
 * "0-6 Months") and check whether a baby of `months` falls inside it.
 * Titles without a parseable range always match (don't hide what we can't read).
 */
export function ageMatchesTitle(title: string, months: number): boolean {
  const range = title.match(/(\d+)\s*-\s*(\d+)\s*months/i);
  if (range) return months >= Number(range[1]) && months <= Number(range[2]);
  const plus = title.match(/(\d+)\s*\+\s*months/i);
  if (plus) return months >= Number(plus[1]);
  return true;
}

/**
 * Map UCP catalog products to the shape the chat widget's ProductCard expects
 * (rawProducts: featuredImage, onlineStoreUrl, title, availableForSale, variants[]).
 */
export function toProductCards(products: any[]): any[] {
  return (products || []).slice(0, 4).map((p: any) => {
    const variants = filterOneTimeVariants(p).map((v: any) => {
      const price = formatMoney(v.price ?? p.price_range?.min);
      return {
        id: v.id,
        title: v.title || (v.options || []).map((o: any) => o.label ?? o.value).join(" / "),
        price,
        formattedPrice: price, // what the widget's ProductCard reads
        quantityAvailable: v.availability?.available === false ? 0 : undefined,
      };
    });
    const imageUrl =
      p.images?.[0]?.url ||
      p.variants?.find((v: any) => v.media?.length)?.media?.find((m: any) => m.type === "image")?.url ||
      "";
    return {
      id: p.id,
      title: p.title,
      description: stripHtml(p.description?.html ?? p.description ?? ""),
      vendor: p.brand || p.vendor || "",
      productType: p.category?.name || p.product_type || "",
      featuredImage: { url: imageUrl, altText: p.title },
      onlineStoreUrl: p.url || p.variants?.[0]?.url || "",
      availableForSale: (p.variants || []).some((v: any) => v.availability?.available !== false),
      variants,
    };
  });
}

function stripHtml(s: unknown): string {
  return String(s ?? "").replace(/<[^>]*>/g, "").trim();
}

export function formatMoney(m: any): string {
  if (!m) return "N/A";
  // UCP uses minor currency units (1500 = $15.00); Shopify MCP sometimes
  // returns {amount, currency} with decimal amounts. Handle both.
  if (typeof m === "object" && m.amount !== undefined) {
    const n = Number(m.amount);
    // UCP amounts are integer minor units (4999 = $49.99); decimal amounts are already major units.
    const amount = Number.isInteger(n) && !String(m.amount).includes(".") ? n / 100 : n;
    return `${amount.toFixed(2)} ${m.currency || ""}`.trim();
  }
  return String(m);
}
