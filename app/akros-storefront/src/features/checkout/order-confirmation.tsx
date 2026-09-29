"use client";
import NextLink from "next/link";
import { useSyncExternalStore } from "react";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { Icon } from "@techsio/ui-kit/atoms/icon";
import { DataTable, type ColumnDef } from "@techsio/ui-kit/organisms/data-table";
import { orderStorageKey, parseLocalOrder } from "@/mock-storefront/local-order";
import { getDeliveryAddress, getDeliveryLocation } from "@/mock-storefront/checkout";
import { type CartLine, formatQuantity, getLineTotal } from "@/mock-storefront/cart";
import { formatPrice } from "@/lib/format";
import { AddressText } from "./address-fields";

const columns: ColumnDef<CartLine, unknown>[] = [
  {
    id: "name",
    header: "Položka",
    cell: ({ row }) => (
      <div className="whitespace-normal">
        {row.original.name}
        <p className="text-xs text-(--color-fg-secondary)">{row.original.variantLabel}</p>
      </div>
    ),
  },
  {
    id: "quantity",
    header: "Množství",
    meta: { align: "end" },
    cell: ({ row }) => `${formatQuantity(row.original.quantity)} ${row.original.unit}`,
  },
  {
    id: "price",
    header: "Cena",
    meta: { align: "end" },
    cell: ({ row }) => (
      <strong className="whitespace-nowrap">{formatPrice(getLineTotal(row.original))}</strong>
    ),
  },
];

function subscribeToOrder(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === orderStorageKey || event.key === null) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

function getStoredOrder() {
  try {
    return window.sessionStorage.getItem(orderStorageKey);
  } catch {
    return null;
  }
}

export function OrderConfirmation() {
  const storedOrder = useSyncExternalStore(subscribeToOrder, getStoredOrder, () => undefined);
  if (storedOrder === undefined) return <output>Načítám potvrzení…</output>;
  const order = parseLocalOrder(storedOrder);
  if (!order)
    return (
      <section className="grid justify-items-center gap-6 py-12 text-center">
        <h1 className="text-lg font-medium">Není zde dokončená objednávka</h1>
        <p>Potvrzení ukázkové objednávky je dostupné pouze v relaci, ve které jste ji vytvořili.</p>
        <LinkButton as={NextLink} href="/kosik" size="sm" variant="primary">
          Přejít do košíku
        </LinkButton>
      </section>
    );
  return (
    <section
      data-akros-checkout
      className="mx-auto grid max-w-4xl gap-8"
      aria-labelledby="confirmation-title"
    >
      <header className="grid justify-items-center gap-3 text-center">
        <Icon
          icon="icon-[mdi--check-circle-outline]"
          size="xl"
          className="text-(--color-fg-status-success)"
        />
        <h1 id="confirmation-title" className="text-lg font-bold">
          Ukázková objednávka je uložená
        </h1>
        <p>
          Číslo objednávky: <strong>{order.id}</strong>
        </p>
        <p className="text-sm text-(--color-fg-secondary)">
          Jde o lokální prototyp. Objednávka ani e-mail nebyly odeslány, platba nebyla provedena.
        </p>
      </header>
      <DataTable
        data={order.cart.lines}
        columns={columns}
        size="sm"
        variant="line"
        enableSorting={false}
        enablePagination={false}
      />
      <dl className="grid gap-3 text-sm">
        <div className="flex justify-between gap-4">
          <dt>Doprava – {order.deliveryTitle}</dt>
          <dd>{formatPrice(order.totals.shipping ?? 0)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt>Platba – {order.paymentTitle}</dt>
          <dd>Neprovedena (demo)</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt>Celkem bez DPH</dt>
          <dd>{order.totals.net === null ? "Není dostupné" : formatPrice(order.totals.net)}</dd>
        </div>
        <div className="flex justify-between gap-4 border-t border-(--color-border-primary) pt-4 text-lg font-bold">
          <dt>Celkem s DPH</dt>
          <dd>{formatPrice(order.totals.total)}</dd>
        </div>
      </dl>
      <div className="grid gap-6 sm:grid-cols-2">
        <section>
          <h2 className="mb-3 text-md font-medium">Fakturační údaje</h2>
          <AddressText address={order.draft.billing} />
          <p>{order.draft.company}</p>
          <p>{order.draft.email}</p>
        </section>
        <section>
          <h2 className="mb-3 text-md font-medium">Dodací údaje</h2>
          <AddressText address={getDeliveryAddress(order.draft)} />
          <p className="mt-2 text-sm">{getDeliveryLocation(order.draft)}</p>
        </section>
      </div>
      <LinkButton
        as={NextLink}
        href="/"
        variant="primary"
        size="sm"
        className="justify-self-center"
      >
        Zpět do obchodu
      </LinkButton>
    </section>
  );
}
