import StoreLink from "@/components/store-link";
import { AccountOrderDetail } from "@/features/account/account-order-detail";
import type { CustomerOrder } from "@/ontos/order-model";

export function OrderConfirmation({ order }: { order: CustomerOrder }) {
  return (
    <section data-akros-checkout className="mx-auto grid max-w-5xl gap-8 py-8">
      <header>
        <h1 className="text-lg font-bold">Objednávka č. {order.number} byla uložena do OntOS</h1>
        <p className="mt-4">
          Objednávku jsme předali obchodu k vyřízení. Její stav najdete ve svém účtu. Odesláním
          objednávky nebyla provedena platba.
        </p>
      </header>
      <AccountOrderDetail order={order} />
      <StoreLink className="underline" href="/historie-objednavek">
        Moje objednávky
      </StoreLink>
    </section>
  );
}
