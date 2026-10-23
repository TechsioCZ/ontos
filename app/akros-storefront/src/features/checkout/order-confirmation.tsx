"use client";
import StoreLink from "@/components/store-link";
import { demoCheckoutNotice, demoPayment } from "@/ontos/demo-checkout";
import { useSyncExternalStore } from "react";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { Icon } from "@techsio/ui-kit/atoms/icon";
import { Table } from "@techsio/ui-kit/organisms/table";
import { orderStorageKey, parseLocalOrder } from "@/mock-storefront/local-order";
import { getDeliveryAddress, getDeliveryLocation } from "@/mock-storefront/checkout";
import { formatQuantity, getLineTotal } from "@/mock-storefront/cart";
import { formatPrice } from "@/lib/format";
import { AddressText } from "./address-fields";
import { LiveOrderStatus } from "./live-order-status";
import { OrderEmailStatus } from "./order-email-status";

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
        <LinkButton as={StoreLink} href="/kosik" size="sm" variant="primary">
          Přejít do košíku
        </LinkButton>
      </section>
    );
  return (
    <section
      data-akros-checkout
      className="mx-auto grid max-w-4xl grid-cols-1 gap-8"
      aria-labelledby="confirmation-title"
    >
      <header className="grid justify-items-center gap-3 text-center">
        <Icon
          icon="icon-[mdi--check-circle-outline]"
          size="xl"
          className="text-(--color-fg-status-success)"
        />
        <h1 id="confirmation-title" className="text-lg font-bold">
          DEMO objednávka č. {order.id} byla uložena do administrace
        </h1>
        <p>
          Číslo objednávky: <strong>{order.id}</strong>
        </p>
        {order.orderId && (
          <LiveOrderStatus orderId={order.orderId} clientRequestId={order.clientRequestId} />
        )}
        <p
          role="note"
          className="rounded-sm border border-(--color-border-primary) p-4 text-sm font-bold"
        >
          {demoCheckoutNotice}
        </p>
        <p className="text-sm text-(--color-fg-secondary)">
          DEMO – objednávka nebude doručena. Objednávka byla skutečně uložena v OntOS a potvrzení
          odesíláme e-mailem. Platba nebyla provedena.
        </p>
      </header>
      <OrderEmailStatus email={order.draft.email} orderNumber={order.id} />
      <div className="hidden sm:block">
        <Table size="sm" variant="line" aria-label="Objednané položky">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader scope="col">Položka</Table.ColumnHeader>
              <Table.ColumnHeader scope="col" align="end">
                Množství
              </Table.ColumnHeader>
              <Table.ColumnHeader scope="col" align="end">
                Cena
              </Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {order.cart.lines.map((line) => (
              <Table.Row key={`${line.productId}:${line.variantId ?? "base"}`}>
                <Table.Cell>
                  <div className="whitespace-normal">
                    {line.name}
                    <p className="text-xs text-(--color-fg-secondary)">{line.variantLabel}</p>
                  </div>
                </Table.Cell>
                <Table.Cell align="end">
                  {formatQuantity(line.quantity)} {line.unit}
                </Table.Cell>
                <Table.Cell align="end">
                  <strong className="whitespace-nowrap">{formatPrice(getLineTotal(line))}</strong>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </div>
      <ul className="grid gap-4 sm:hidden" aria-label="Objednané položky">
        {order.cart.lines.map((line) => (
          <li
            key={`${line.productId}:${line.variantId ?? ""}`}
            className="border-b border-(--color-border-primary) pb-4"
          >
            <p className="font-bold">{line.name}</p>
            <p className="text-sm text-(--color-fg-secondary)">{line.variantLabel}</p>
            <div className="mt-3 flex justify-between gap-4">
              <span>
                {formatQuantity(line.quantity)} {line.unit}
              </span>
              <strong className="whitespace-nowrap">{formatPrice(getLineTotal(line))}</strong>
            </div>
          </li>
        ))}
      </ul>
      <dl className="grid gap-3 text-sm">
        <div className="flex justify-between gap-4">
          <dt>Doprava – {order.deliveryTitle}</dt>
          <dd>{formatPrice(order.totals.shipping ?? 0)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt>Platba – {demoPayment.title}</dt>
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
          <p className="wrap-anywhere">{order.draft.email}</p>
        </section>
        <section>
          <h2 className="mb-3 text-md font-medium">Dodací údaje</h2>
          <AddressText address={getDeliveryAddress(order.draft)} />
          <p className="mt-2 text-sm">{getDeliveryLocation(order.draft)}</p>
        </section>
      </div>
      <LinkButton
        as={StoreLink}
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
