import "server-only";
import { createHash } from "node:crypto";
import { guard, jsonBody, problem, RequestError } from "@/ontos/http";
import { assertCart } from "@/ontos/quote";
import { readProducts } from "@/ontos/catalog-server";
import { callAction, OntosError } from "@/ontos/gateway";
import { readAccount } from "@/ontos/account";
import { readCustomerOrders } from "@/ontos/customer-orders";
import { readCheckoutOptions } from "@/ontos/checkout-options";

export async function GET(request: Request) {
  try {
    const account = await readAccount(new URL(request.url).origin, request.headers.get("cookie"));
    if (!account)
      return Response.json(
        { message: "Přihlaste se ke svému účtu." },
        { status: 401, headers: { "cache-control": "no-store" } },
      );
    const url = new URL(request.url);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new RequestError(400, "Neplatná stránka.");
    const result = await readCustomerOrders(
      account,
      url.searchParams.get("order") ?? undefined,
      offset,
    );
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return problem(error, "Objednávky se nepodařilo načíst z OntOS.");
  }
}
import {
  isCheckoutDraft,
  validateAddresses,
  validateMethods,
  getDeliveryAddress,
} from "@/features/checkout/checkout-state";
export async function POST(request: Request) {
  try {
    guard(request);
    const account = await readAccount(new URL(request.url).origin, request.headers.get("cookie"));
    if (!account)
      return Response.json(
        { message: "Před odesláním objednávky se přihlaste." },
        { status: 401, headers: { "cache-control": "no-store" } },
      );
    const options = await readCheckoutOptions();
    const { cart, draft, clientRequestId } = await jsonBody(request);
    assertCart(cart);
    if (
      typeof clientRequestId !== "string" ||
      !/^akros-[a-f0-9-]{36}$/.test(clientRequestId) ||
      !isCheckoutDraft(draft) ||
      Object.keys(validateAddresses(draft)).length ||
      Object.keys(validateMethods(draft, options.shippingMethods)).length
    )
      throw new RequestError(400, "Neplatné dodací údaje.");
    const address = getDeliveryAddress(draft);
    const delivery = options.shippingMethods.find((method) => method.id === draft.deliveryId)!;
    const command = {
      _tag: "PlaceStorefrontOrder",
      clientRequestId,
      customerAccountId: account.id,
      partyId: account.partyId,
      contact: {
        name: `${draft.billing.firstName} ${draft.billing.lastName}`,
        email: account.email,
        phone: draft.billing.phone,
      },
      deliveryAddress: {
        street: address.street,
        city: address.city,
        postalCode: address.postalCode,
        country: address.country,
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
        const result = (await callAction(
          "merchandise",
          "apply-command",
          payload,
          `akros-${clientRequestId}-${digest}`,
        )) as {
          storefrontOrder?: {
            outcome: string;
            orderNumber?: string;
            totalMinor?: number;
            totalVatMinor?: number;
            issues?: { message: string }[];
          };
        };
        const order = result.storefrontOrder;
        if (order?.outcome === "REJECTED")
          return Response.json(
            {
              message:
                order.issues?.map((i) => i.message).join(" ") ||
                "Košík se změnil. Zkontrolujte ceny a dostupnost.",
              issues: order.issues,
            },
            { status: 409 },
          );
        if (!order?.orderNumber || !["PLACED", "REPLAYED"].includes(order.outcome))
          throw new Error("Uložení objednávky nebylo potvrzeno.");
        return Response.json(order, { headers: { "cache-control": "no-store" } });
      } catch (e) {
        if (e instanceof OntosError && [409, 502, 503].includes(e.status) && attempt < 2) {
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
    throw new Error("Systém je zaneprázdněný.");
  } catch (e) {
    return problem(e);
  }
}
