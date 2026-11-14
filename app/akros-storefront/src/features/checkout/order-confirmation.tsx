"use client";
import StoreLink from "@/components/store-link";
import { AccountOrderDetail } from "@/features/account/account-order-detail";
import { OrderEmailStatus } from "./order-email-status";
import { useDictionary } from "@/ontos/market-context";
import type { CustomerOrder } from "@/ontos/order-model";

export function OrderConfirmation({ order }: { order: CustomerOrder }) {
  const copy = useDictionary().checkout.placed;
  return (
    <section data-sf-checkout className="mx-auto grid max-w-5xl gap-8 py-8">
      <header>
        <h1 className="text-lg font-bold">{copy.saved(order.number)}</h1>
        <p className="mt-4">{copy.accountText}</p>
      </header>
      {order.contact?.email && (
        <OrderEmailStatus email={order.contact.email} orderNumber={order.number} />
      )}
      <AccountOrderDetail order={order} repeatable={false} />
      <StoreLink className="underline" href="/historie-objednavek">
        {copy.myOrders}
      </StoreLink>
    </section>
  );
}
