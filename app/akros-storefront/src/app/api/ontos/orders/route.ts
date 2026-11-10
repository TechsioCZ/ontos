import "server-only";
import { createHash } from "node:crypto";
import {
  guard,
  jsonBody,
  problem,
  RequestError,
  requestDictionary,
  requestOrigin,
} from "@/ontos/http";
import { assertCart } from "@/ontos/quote";
import { readProducts } from "@/ontos/catalog-server";
import { callAction, OntosError } from "@/ontos/gateway";
import { readAccount } from "@/ontos/account";
import { readCustomerOrders } from "@/ontos/customer-orders";
import { readCheckoutOptions } from "@/ontos/checkout-options";
import { getActiveMarket } from "@/ontos/active-market";
import { ownerIssueText, type OwnerIssue } from "@/ontos/owner-issues";

const isOntosError = (value: unknown): value is OntosError =>
  value !== null && value !== undefined && OntosError.prototype.isPrototypeOf(value);

export async function GET(request: Request) {
  const t = requestDictionary(request);
  try {
    const account = await readAccount(requestOrigin(request), request.headers.get("cookie"));
    if (!account)
      return Response.json(
        { message: t.server.orders.signIn },
        { status: 401, headers: { "cache-control": "no-store" } },
      );
    const url = new URL(request.url);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new RequestError(400, t.server.orders.invalidPage);
    const result = await readCustomerOrders(
      account,
      url.searchParams.get("order") ?? undefined,
      offset,
    );
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return problem(error, t.server.outage.orders);
  }
}
import {
  isCheckoutDraft,
  validateAddresses,
  validateMethods,
  getDeliveryAddress,
} from "@/features/checkout/checkout-state";
export async function POST(request: Request) {
  const t = requestDictionary(request);
  try {
    guard(request, t);
    // The browser's path locale only selects the market; the owners resolve it again for this order.
    const market = await getActiveMarket();
    // A signed-in order is bound to the admitted portal subject and Party; without a session it is a guest order.
    const account = await readAccount(requestOrigin(request), request.headers.get("cookie"));
    const options = await readCheckoutOptions();
    const { cart, draft, clientRequestId } = await jsonBody(request, t);
    assertCart(cart, t);
    if (
      typeof clientRequestId !== "string" ||
      !/^sf-[a-f0-9-]{36}$/.test(clientRequestId) ||
      !isCheckoutDraft(draft) ||
      Object.keys(validateAddresses(draft)).length ||
      Object.keys(validateMethods(draft, options.shippingMethods)).length
    )
      throw new RequestError(400, t.server.orders.invalidDelivery);
    const address = getDeliveryAddress(draft);
    const delivery = options.shippingMethods.find((method) => method.id === draft.deliveryId)!;
    const command = {
      _tag: "PlaceStorefrontOrder",
      clientRequestId,
      ...(market.marketId === undefined ? {} : { marketId: market.marketId }),
      ...(account ? { customerAccountId: account.id, partyId: account.partyId } : {}),
      contact: {
        name: `${draft.billing.firstName} ${draft.billing.lastName}`,
        email: account ? account.email : draft.email.trim(),
        phone: draft.billing.phone,
      },
      billingAddress: {
        city: draft.billing.city,
        country: draft.billing.country,
        postalCode: draft.billing.postalCode,
        street: draft.billing.street,
      },
      deliveryAddress: {
        city: address.city,
        country: address.country,
        postalCode: address.postalCode,
        street: address.street,
      },
      deliveryRecipient: {
        firstName: address.firstName,
        lastName: address.lastName,
        phone: address.phone,
      },
      shippingMethod: delivery.id,
      expectedShippingPriceMinor: delivery.priceMinor,
      lines: cart.lines.map((l) => ({
        productId: l.productId,
        ...(l.variantId ? { variantId: l.variantId } : {}),
        quantity: l.quantity,
        expectedUnitPriceMinor: l.priceMinor,
      })),
      note: [
        draft.company,
        draft.companyId && `IČ: ${draft.companyId}`,
        draft.vatId && `DIČ: ${draft.vatId}`,
      ]
        .filter(Boolean)
        .join("; ")
        .slice(0, 1000),
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      // Only the aggregate revision is needed: smallest possible fresh owner read.
      const snapshot = await readProducts({ pageSize: 1 }, "card", true);
      const payload = { command, expectedRevision: snapshot.revision };
      const digest = createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("hex")
        .slice(0, 24);
      try {
        // The storefront key is admitted on merchandise's narrow storefront-order Action, not on apply-command.
        const result = (await callAction(
          "merchandise",
          "place-storefront-order",
          payload,
          `sf-${clientRequestId}-${digest}`,
        )) as {
          storefrontOrder?: {
            outcome: string;
            orderNumber?: string;
            totalMinor?: number;
            totalVatMinor?: number;
            issues?: OwnerIssue[];
          };
        };
        const order = result.storefrontOrder;
        if (order?.outcome === "REJECTED") {
          // The owner's messages are Czech: each issue is worded from its code in the request's language.
          const money = { currency: market.currency, locale: market.formatLocale };
          const issues = (order.issues ?? [])
            .filter((issue) => typeof issue === "object" && issue !== null)
            .map((issue) => {
              const line = cart.lines.find(
                (l) =>
                  l.productId === issue.productId &&
                  (l.variantId ?? "") === (issue.variantId ?? ""),
              );
              return {
                ...issue,
                message: ownerIssueText(
                  issue,
                  line && {
                    label: `${line.name || t.server.cart.fallbackItem}${line.variantLabel ? ` (${line.variantLabel})` : ""}`,
                    unit: line.unit,
                    minimumQuantity: line.minimumQuantity,
                    packageQuantity: line.quantityStep,
                  },
                  t,
                  money,
                ),
              };
            });
          return Response.json(
            {
              message: issues.map((i) => i.message).join(" ") || t.server.orders.cartChanged,
              issues,
            },
            { status: 409 },
          );
        }
        if (!order?.orderNumber || !["PLACED", "REPLAYED"].includes(order.outcome))
          throw new Error("Uložení objednávky nebylo potvrzeno.");
        return Response.json(order, { headers: { "cache-control": "no-store" } });
      } catch (e) {
        if (isOntosError(e) && [409, 502, 503].includes(e.status) && attempt < 2) {
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
    throw new Error("Systém je zaneprázdněný.");
  } catch (e) {
    return problem(e, t.server.outage.cart);
  }
}
