// Customer Account API access — runs with the CUSTOMER'S OAuth token passed
// per-request from the mobile app (never stored). Shopify validates the token.

import { config } from "../config.js";

let cachedEndpoint: string | null = null;

async function endpoint(): Promise<string> {
  if (cachedEndpoint) return cachedEndpoint;
  const res = await fetch(`https://${config.shopifyDomain}/.well-known/customer-account-api`);
  const json: any = await res.json();
  if (!json.graphql_api) throw new Error("Customer API discovery failed");
  cachedEndpoint = json.graphql_api;
  return cachedEndpoint!;
}

const ORDERS_QUERY = `query CustomerOrders($first: Int!) {
  customer {
    firstName
    lastName
    emailAddress { emailAddress }
    orders(first: $first, sortKey: PROCESSED_AT, reverse: true) {
      edges { node {
        id name processedAt financialStatus
        totalPrice { amount currencyCode }
        lineItems(first: 10) { edges { node { title quantity } } }
      } }
    }
  }
}`;

export async function getMyOrders(customerToken: string, first = 5): Promise<any> {
  const res = await fetch(await endpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: customerToken },
    body: JSON.stringify({ query: ORDERS_QUERY, variables: { first } }),
  });
  const json: any = await res.json();
  if (json.errors?.length) {
    return { error: `Could not fetch orders: ${json.errors[0]?.message ?? "auth failed"}. The customer may need to sign in again.` };
  }
  const c = json.data?.customer;
  return {
    name: [c?.firstName, c?.lastName].filter(Boolean).join(" ") || undefined,
    email: c?.emailAddress?.emailAddress,
    orders: (c?.orders?.edges ?? []).map((e: any) => ({
      name: e.node.name,
      placed: e.node.processedAt,
      payment_status: e.node.financialStatus,
      total: `${e.node.totalPrice?.amount} ${e.node.totalPrice?.currencyCode}`,
      items: (e.node.lineItems?.edges ?? []).map((li: any) => `${li.node.quantity}x ${li.node.title}`),
    })),
  };
}
