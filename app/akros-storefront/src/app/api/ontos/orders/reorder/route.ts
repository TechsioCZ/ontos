import "server-only";
import { readAccount } from "@/ontos/account";
import { readCustomerOrders } from "@/ontos/customer-orders";
import { readCartProducts } from "@/ontos/catalog-server";
import { problem } from "@/ontos/http";
import { normalizeOrderQuantity, type CartItemSnapshot } from "@/features/cart/cart-state";
import type { CatalogPriceTier } from "@/ontos/catalog-types";

/** Read the customer's historical lines and prepare current offers, without placing an order. */
export async function GET(request: Request) {
  const headers = { "cache-control": "no-store" };
  try {
    const account = await readAccount(new URL(request.url).origin, request.headers.get("cookie"));
    if (!account)
      return Response.json({ message: "Přihlaste se ke svému účtu." }, { status: 401, headers });
    const id = new URL(request.url).searchParams.get("order");
    if (!id) return Response.json({ message: "Vyberte objednávku." }, { status: 400, headers });
    const { orders } = await readCustomerOrders(account, id);
    const order = orders.find((item) => item.id === id);
    if (!order)
      return Response.json({ message: "Objednávka není dostupná." }, { status: 404, headers });
    const items: { item: CartItemSnapshot; quantity: number; priceTiers: CatalogPriceTier[] }[] =
      [];
    let skipped = 0;
    let adjusted = 0;
    for (let offset = 0; offset < order.lines.length; offset += 100) {
      const batch = order.lines.slice(offset, offset + 100);
      const { products } = await readCartProducts(batch);
      for (const line of batch) {
        const product = products.find((item) => item.id === line.productId);
        const variant = product?.detail.variants.find((item) => item.id === line.variantId);
        const offer = line.variantId
          ? variant
          : product?.variantSummary.count
            ? undefined
            : product;
        if (
          !product ||
          !offer ||
          offer.availabilityUnknown ||
          offer.priceUnavailableReason ||
          offer.priceMinor <= 0
        ) {
          skipped++;
          continue;
        }
        const priceTiers = variant?.priceTiers ?? product.detail.priceTiers;
        const item: CartItemSnapshot = {
          productId: product.id,
          variantId: variant?.id,
          slug: product.slug,
          name: product.name,
          variantLabel: variant?.label,
          sku: offer.sku,
          imageSrc: variant?.imageSrc ?? product.imageSrc,
          imageAlt: product.imageAlt,
          unit: offer.unit,
          minimumQuantity: offer.minimumQuantity,
          quantityStep: offer.quantityStep,
          stockCount: offer.stockCount,
          vatRate: product.vatRate,
          priceMinor: offer.priceMinor,
          priceExcludingVatMinor: priceTiers.find((tier) => tier.priceMinor === offer.priceMinor)
            ?.priceExcludingVatMinor,
        };
        const quantity = normalizeOrderQuantity(item, line.quantity);
        if (!quantity) {
          skipped++;
          continue;
        }
        if (quantity !== line.quantity) adjusted++;
        items.push({ item, quantity, priceTiers });
      }
    }
    return Response.json({ items, skipped, adjusted }, { headers });
  } catch (error) {
    return problem(error, "Položky objednávky se nepodařilo ověřit. Košík nebyl změněn.");
  }
}
