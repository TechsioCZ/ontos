import "server-only";
import { createHash } from "node:crypto";
import { guard, jsonBody, problem } from "@/ontos/http";
import { assertCart } from "@/ontos/quote";
import { getSnapshot } from "@/ontos/catalog-server";
import { callAction, OntosError } from "@/ontos/gateway";
import {
  isCheckoutDraft,
  validateAddresses,
  validateMethods,
  getDeliveryAddress,
} from "@/mock-storefront/checkout";
export async function POST(request: Request) {
  try {
    guard(request);
    const { cart, draft, clientRequestId } = await jsonBody(request);
    assertCart(cart);
    if (
      typeof clientRequestId !== "string" ||
      !/^akros-[a-f0-9-]{36}$/.test(clientRequestId) ||
      !isCheckoutDraft(draft) ||
      Object.keys(validateAddresses(draft)).length ||
      Object.keys(validateMethods(draft)).length
    )
      throw new Error("Neplatné dodací údaje.");
    if (!["osobni", "zasilkovna"].includes(draft.deliveryId) || draft.extendedReturn)
      return Response.json(
        {
          message:
            "Vyberte osobní odběr nebo Zásilkovnu a vypněte prodloužené vrácení. Tyto služby jsou v DEMO režimu podporované.",
        },
        { status: 422 },
      );
    const address = getDeliveryAddress(draft);
    const command = {
      _tag: "PlaceStorefrontOrder",
      clientRequestId,
      contact: {
        name: `${draft.billing.firstName} ${draft.billing.lastName}`,
        email: draft.email,
        phone: draft.billing.phone,
      },
      deliveryAddress: {
        street: address.street,
        city: address.city,
        postalCode: address.postalCode,
        country: address.country,
      },
      shippingMethod: draft.deliveryId === "osobni" ? "OSOBNI_ODBER" : "ZASILKOVNA",
      expectedShippingPriceMinor: draft.deliveryId === "osobni" ? 0 : 7900,
      lines: cart.lines.map((l) => ({
        productId: l.productId,
        ...(l.variantId ? { variantId: l.variantId } : {}),
        quantity: l.quantity,
        expectedUnitPriceMinor: l.priceMinor,
      })),
      note: `AKROS DEMO – objednávka nebude doručena. Platba se neprovádí (DEMO). ${draft.company}`.slice(
        0,
        1000,
      ),
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      // Only the aggregate revision is needed: smallest possible fresh owner read.
      const snapshot = await getSnapshot(true, { pageSize: 1 });
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
