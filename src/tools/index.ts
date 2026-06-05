// Tool registry: Claude tool definitions + dispatcher.
// IMPORTANT: keep this array order stable — tools are part of the prompt-cache
// prefix, and reordering invalidates the cache.

import type Anthropic from "@anthropic-ai/sdk";
import {
  callStoreMcp,
  toProductCards,
  fetchProductMetafields,
  filterOneTimeVariants,
  ageMatchesTitle,
  fetchSubscriptionOffers,
  formatMoney,
  filterOffersForCustomer,
} from "./shopify.js";
import { searchArticles } from "./blog.js";

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_articles",
    description:
      "Search Organic's Best editorial articles (baby formula guides, nutrition advice, parenting tips). Call this BEFORE answering any advice, nutrition, ingredient, or how-to question so your answer is grounded in the store's own content. Returns article excerpts with titles and URLs to cite.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Natural-language search query, e.g. 'when to switch from stage 1 to stage 2'" },
      },
      required: ["query"],
    },
  },
  {
    name: "search_catalog",
    description:
      "Search the store's live product catalog with natural language. Call this when the customer wants product recommendations or asks what's available. Never recommend a product without finding it here first.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Free-text product search, e.g. 'HiPP stage 2 hypoallergenic'" },
        country: { type: "string", description: "ISO 3166-1 alpha-2 country code of the customer if known, e.g. 'US'" },
        baby_age_months: {
          type: "integer",
          description:
            "The baby's age in months, when known from the conversation or customer profile. Sorts age-appropriate products first and marks mismatches with an age_note. Products outside the range are still returned — if the customer asked about one by name, tell them it exists but is made for a different age; never say it's unavailable.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_product_details",
    description:
      "Get live details (price, availability, variants, options) for one specific product. Call this before quoting a price or stock status. product_id comes from search_catalog results.",
    input_schema: {
      type: "object" as const,
      properties: {
        product_id: { type: "string", description: "Product ID, e.g. gid://shopify/Product/123" },
        options: { type: "object", description: 'Variant options, e.g. {"Size": "600g"}' },
        country: { type: "string", description: "ISO country code for localized pricing" },
      },
      required: ["product_id"],
    },
  },
  {
    name: "update_cart",
    description:
      "Create a cart or add/update/remove items. When the customer wants to buy, add the variant(s) here and give them the returned checkout URL. Omit cart_id to create a new cart; pass the existing cart_id to modify it. Use quantity 0 in update_items to remove a line.",
    input_schema: {
      type: "object" as const,
      properties: {
        cart_id: { type: "string", description: "Existing cart ID; omit to create a new cart" },
        add_items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              product_variant_id: { type: "string" },
              quantity: { type: "integer", minimum: 1 },
            },
            required: ["product_variant_id", "quantity"],
          },
        },
        update_items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Cart line item ID" },
              quantity: { type: "integer", minimum: 0 },
            },
            required: ["id", "quantity"],
          },
        },
      },
    },
  },
  {
    name: "get_cart",
    description: "Retrieve the current contents and totals of an existing cart by cart_id.",
    input_schema: {
      type: "object" as const,
      properties: {
        cart_id: { type: "string" },
      },
      required: ["cart_id"],
    },
  },
  {
    name: "get_shipping_estimate",
    description:
      "Get the real shipping options and costs for the customer's country (and optionally zip/region), calculated live by the store. Use this whenever the customer asks what shipping costs or which options exist for their location. Pass their cart_id if they have one (also attaches the address for checkout); otherwise pass a product_variant_id to estimate with.",
    input_schema: {
      type: "object" as const,
      properties: {
        country_code: { type: "string", description: "ISO 3166-1 alpha-2 country code, e.g. 'US', 'DE'" },
        zip: { type: "string", description: "Postal/ZIP code if the customer mentioned one (optional — rates are flat per country)" },
        province_code: { type: "string", description: "State/province code if known, e.g. 'NY'" },
        city: { type: "string" },
        cart_id: { type: "string", description: "The customer's active cart, if any" },
        product_variant_id: {
          type: "string",
          description:
            "A variant OR product id to estimate with when there is no cart yet (gid://shopify/ProductVariant/... or gid://shopify/Product/... — product ids are resolved to their first variant automatically)",
        },
      },
      required: ["country_code"],
    },
  },
  {
    name: "display_product_cards",
    description:
      "Show product cards in the chat UI for the products you are RECOMMENDING in your answer. Call this right before writing your final answer, passing ONLY the ids of products you actually recommend (not everything you searched, and never products you advise against). The customer sees these as rich cards with prices and subscribe options.",
    input_schema: {
      type: "object" as const,
      properties: {
        product_ids: {
          type: "array",
          items: { type: "string" },
          description: "Product ids (gid://shopify/Product/...) from this conversation's search results, max 4",
        },
      },
      required: ["product_ids"],
    },
  },
  {
    name: "get_my_orders",
    description:
      "Get the signed-in customer's recent orders (status, totals, items). Use for 'where is my order', 'what did I last buy', reorder questions. Only works when the customer is signed in to the app — if it returns an auth error, ask them to sign in via the Account tab.",
    input_schema: {
      type: "object" as const,
      properties: {
        first: { type: "integer", description: "How many recent orders (default 5)" },
      },
    },
  },
  {
    name: "search_shop_policies_and_faqs",
    description:
      "Answer questions about store policies: shipping times and costs, returns, refunds, payment methods, order issues. Call this for any policy or logistics question.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "The policy question, e.g. 'how long does shipping to the US take?'" },
      },
      required: ["query"],
    },
  },
];

export interface ToolOutcome {
  /** Serialized result fed back to Claude */
  resultForModel: string;
  /** Optional UI payload pushed to the client as a tool_response SSE event */
  uiPayload?: { type: string; [k: string]: unknown };
  /** Durable session-state changes (e.g. active cart id, discussed products) */
  stateUpdates?: { cartId?: string; recentProducts?: { id: string; title: string; url?: string }[] };
}

export interface ToolContext {
  customerToken?: string;
  /** 2+ orders → starter (3+1) offers are hidden */
  isReturningCustomer?: boolean;
}

export async function executeTool(name: string, input: any, ctx: ToolContext = {}): Promise<ToolOutcome> {
  switch (name) {
    case "search_articles": {
      const res = await searchArticles(input.query);
      return { resultForModel: JSON.stringify(res) };
    }
    case "search_catalog": {
      const args: any = { catalog: { query: input.query } };
      if (input.country) args.catalog.context = { address_country: input.country };
      const res = await callStoreMcp("search_catalog", args);
      let products = res?.result?.products ?? res?.products ?? [];
      // Age awareness: never DROP mismatches — a hard filter silently hides
      // named products the customer asked about, and the model then claims
      // they don't exist. Annotate + sort age-appropriate first instead; the
      // model recommends from the matches and can answer honestly about the
      // rest ("we carry it, but it's for 10-36 months").
      const months = typeof input.baby_age_months === "number" ? input.baby_age_months : undefined;
      const ageOk = (p: any) => months === undefined || ageMatchesTitle(String(p.title || ""), months);
      if (months !== undefined) {
        products = [...products].sort((a: any, b: any) => Number(ageOk(b)) - Number(ageOk(a)));
      }
      const cards = toProductCards(products);
      return {
        // Slim payload for the model — full variant trees waste context
        resultForModel: JSON.stringify(
          products.slice(0, 8).map((p: any) => ({
            id: p.id,
            title: p.title,
            price_range: p.price_range,
            available: p.available,
            url: p.url,
            ...(ageOk(p)
              ? {}
              : { age_note: `In stock, but made for a different age than the ${months}-month-old — don't recommend it, but never call it unavailable.` }),
            // One-time purchasable variants only — bundles with "Free" etc.
            // are subscription offers and must not go into one-time carts.
            // Prices included so quantity pickers quote real numbers.
            variant_ids: filterOneTimeVariants(p)
              .slice(0, 6)
              .map((v: any) => ({ id: v.id, title: v.title, price: formatMoney(v.price ?? p.price_range?.min) })),
          })),
        ),
        uiPayload: cards.length ? { type: "product_list", rawProducts: cards } : undefined,
        stateUpdates: {
          recentProducts: products.slice(0, 6).map((p: any) => ({
            id: p.id,
            title: p.title,
            url: p.url,
            variants: filterOneTimeVariants(p)
              .slice(0, 6)
              .map((v: any) => ({ id: v.id, title: `${v.title} (${formatMoney(v.price ?? p.price_range?.min)})` })),
          })),
        },
      };
    }
    case "get_product_details": {
      const [res, metafields] = await Promise.all([
        callStoreMcp("get_product_details", input),
        fetchProductMetafields(input.product_id).catch(() => ({})),
      ]);
      const product = res?.product ?? res;
      const subscriptionOffersRaw = await fetchSubscriptionOffers(
        input.product_id,
        product?.url || `https://${process.env.SHOPIFY_DOMAIN}/products/`,
      ).catch(() => []);
      const subscriptionOffers = filterOffersForCustomer(subscriptionOffersRaw, !!ctx.isReturningCustomer);
      return {
        resultForModel: JSON.stringify({
          ...product,
          product_knowledge: metafields,
          subscription_offers: subscriptionOffers,
        }),
        stateUpdates: product?.product_id
          ? { recentProducts: [{ id: product.product_id, title: product.title, url: product.url }] }
          : undefined,
      };
    }
    case "update_cart":
    case "get_cart": {
      const res = await callStoreMcp(name, input);
      const serialized = JSON.stringify(res);
      // Persist the active cart id so follow-up turns ("add one more") reuse
      // the same cart instead of creating a new one.
      const cartId =
        res?.cart?.id ?? res?.id ?? serialized.match(/gid:\\?\/\\?\/shopify\\?\/Cart\\?\/[^"\s]+/)?.[0];
      return {
        resultForModel: serialized,
        stateUpdates: typeof cartId === "string" && cartId.includes("shopify/Cart") ? { cartId } : undefined,
      };
    }
    case "get_shipping_estimate": {
      // Rates are flat per country, but Shopify needs *a* postal code for some
      // destinations to return them — fill a representative one when missing.
      const DEFAULT_ZIPS: Record<string, { zip: string; province_code?: string; city?: string }> = {
        US: { zip: "10001", province_code: "NY", city: "New York" },
        CA: { zip: "M5V 2T6", province_code: "ON", city: "Toronto" },
      };
      const cc = String(input.country_code || "").toUpperCase();
      const fallback = !input.zip ? DEFAULT_ZIPS[cc] : undefined;
      const args: any = {
        buyer_identity: { country_code: cc },
        delivery_addresses_to_add: [
          {
            selected: true,
            delivery_address: {
              country_code: cc,
              ...(input.zip ? { zip: input.zip } : fallback ? { zip: fallback.zip } : {}),
              ...(input.province_code
                ? { province_code: input.province_code }
                : fallback?.province_code
                  ? { province_code: fallback.province_code }
                  : {}),
              ...(input.city ? { city: input.city } : fallback?.city ? { city: fallback.city } : {}),
            },
          },
        ],
      };
      if (input.cart_id) {
        args.cart_id = input.cart_id;
      } else if (input.product_variant_id) {
        let variantId = String(input.product_variant_id);
        // Models often pass a Product gid here — resolve to its first variant
        if (variantId.includes("/Product/")) {
          const details = await callStoreMcp("get_product_details", { product_id: variantId });
          const resolved = details?.product?.selectedOrFirstAvailableVariant?.id;
          if (!resolved) {
            return { resultForModel: JSON.stringify({ error: "Could not resolve a variant for that product — call search_catalog to get a valid product." }) };
          }
          variantId = resolved;
        }
        args.add_items = [{ product_variant_id: variantId, quantity: 1 }];
      } else {
        return { resultForModel: JSON.stringify({ error: "Need either cart_id or product_variant_id to estimate shipping." }) };
      }

      const res = await callStoreMcp("update_cart", args);
      if (Array.isArray(res?.errors) && res.errors.length) {
        return { resultForModel: JSON.stringify({ error: "Cart error while estimating shipping", details: res.errors }) };
      }
      const cart = res?.cart ?? res;
      const groups = cart?.delivery?.methods?.shipping?.groups ?? [];
      const options = groups.flatMap((g: any) =>
        (g.available_options ?? []).map((o: any) => ({
          title: o.title,
          price: o.price ? `${o.price.amount} ${o.price.currency}` : "free",
        })),
      );
      const emptyReason = !options.length
        ? input.zip
          ? "No shipping options returned — the store may not ship to this destination."
          : "No options without a postal code — ask the customer for their ZIP/postal code and call this tool again with it. Do NOT tell them shipping is unavailable."
        : undefined;
      return {
        resultForModel: JSON.stringify({
          country: input.country_code,
          shipping_options: options.length ? options : emptyReason,
          subtotal: cart?.cost?.subtotal_amount,
          total_with_shipping: options.length ? cart?.cost?.total_amount : undefined,
          note: input.cart_id ? "Address attached to the customer's cart for checkout." : "Estimated with a sample cart.",
        }),
        // Only persist if this was the customer's own cart
        stateUpdates: input.cart_id && cart?.id ? { cartId: cart.id } : undefined,
      };
    }
    case "display_product_cards": {
      // Handled by the agent loop (selection signal, no external call)
      return { resultForModel: JSON.stringify({ ok: true, note: "Cards will be shown with your answer." }) };
    }
    case "get_my_orders": {
      if (!ctx.customerToken) {
        return { resultForModel: JSON.stringify({ error: "Customer is not signed in. Ask them to sign in via the Account tab to see their orders." }) };
      }
      const { getMyOrders } = await import("./customer.js");
      const res = await getMyOrders(ctx.customerToken, input.first ?? 5);
      return { resultForModel: JSON.stringify(res) };
    }
    case "search_shop_policies_and_faqs": {
      const res = await callStoreMcp(name, { query: input.query, context: input.context });
      return { resultForModel: JSON.stringify(res) };
    }
    default:
      return { resultForModel: JSON.stringify({ error: `Unknown tool: ${name}` }) };
  }
}

/** Human-readable status keys the chat widget shows while a tool runs */
export const TOOL_STATUS: Record<string, string> = {
  search_articles: "searching_blogs",
  search_catalog: "searching_products",
  get_product_details: "checking_availability",
  update_cart: "updating_cart",
  get_cart: "checking_cart",
  get_shipping_estimate: "calculating_shipping",
  search_shop_policies_and_faqs: "checking_policies",
  get_my_orders: "checking_orders",
};
