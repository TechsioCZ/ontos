"use client";

import StoreLink from "@/components/store-link";
import { Table } from "@techsio/ui-kit/organisms/table";
import { AccountHeading, AccountPanel } from "./account-content";
import { orderStatusLabels, type CustomerOrder } from "@/ontos/order-model";
import { formatPrice } from "@/lib/format";

export function AccountOrderDetail({ order }: { order: CustomerOrder }) {
  const address = order.deliveryAddress;
  return (
    <>
      <AccountHeading
        title={`Objednávka ${order.number}`}
        description={`Vytvořeno ${new Date(order.createdAt).toLocaleDateString("cs-CZ")} · ${orderStatusLabels[order.status]}`}
      >
        <StoreLink className="underline" href="/historie-objednavek">
          Zpět na objednávky
        </StoreLink>
        <StoreLink
          className="underline"
          href={`/sledovani-zasilky?order=${encodeURIComponent(order.id)}`}
        >
          Stav objednávky
        </StoreLink>
      </AccountHeading>
      <div className="mb-8 grid gap-6 md:grid-cols-2">
        <AccountPanel title="Kontakt a dodací adresa">
          {order.contact && (
            <p>
              {order.contact.name}
              <br />
              {order.contact.email}
              <br />
              {order.contact.phone}
            </p>
          )}
          {address && (
            <p className="mt-4">
              {address.street}
              <br />
              {address.postalCode} {address.city}
              <br />
              {address.country}
            </p>
          )}
        </AccountPanel>
        <AccountPanel title="Přehled objednávky">
          <dl className="grid gap-4">
            <div className="flex justify-between gap-4">
              <dt>Stav</dt>
              <dd>{orderStatusLabels[order.status]}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt>Počet položek</dt>
              <dd>{order.lines.length}</dd>
            </div>
            {order.shipping && (
              <div className="flex justify-between gap-4">
                <dt>{order.shipping.label}</dt>
                <dd>{formatPrice(order.shipping.priceMinor)}</dd>
              </div>
            )}
            <div className="flex justify-between gap-4">
              <dt>DPH</dt>
              <dd>{formatPrice(order.totalVatMinor)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt>Celkem s DPH</dt>
              <dd className="font-bold">{formatPrice(order.totalMinor)}</dd>
            </div>
          </dl>
          <p className="mt-4 text-sm">
            Částky jsou uložené při objednání. Online platba ani stav úhrady nejsou v OntOS pro tuto
            objednávku dostupné.
          </p>
        </AccountPanel>
      </div>
      <section aria-labelledby="account-order-lines">
        <h2 id="account-order-lines" className="mb-6 font-bold">
          Objednané položky
        </h2>
        <div data-account-table className="hidden xl:block">
          <Table size="sm" variant="line">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>Produkt</Table.ColumnHeader>
                <Table.ColumnHeader numeric>Množství</Table.ColumnHeader>
                <Table.ColumnHeader numeric>Cena za kus</Table.ColumnHeader>
                <Table.ColumnHeader numeric>Celkem</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {order.lines.map((line) => (
                <Table.Row key={`${line.productId}:${line.variantId ?? ""}`}>
                  <Table.Cell>
                    <p>
                      {line.productName}
                      {line.variantName ? ` – ${line.variantName}` : ""}
                    </p>
                    <p className="text-sm">Kód: {line.sku}</p>
                  </Table.Cell>
                  <Table.Cell numeric>{line.quantity}</Table.Cell>
                  <Table.Cell numeric>{formatPrice(line.unitPriceMinor)}</Table.Cell>
                  <Table.Cell numeric>
                    {formatPrice(Math.round(line.unitPriceMinor * line.quantity))}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
        <ul className="grid gap-6 xl:hidden">
          {order.lines.map((line) => (
            <li
              key={`${line.productId}:${line.variantId ?? ""}`}
              className="rounded-(--dimension-8) bg-(--akros-account-surface) p-6"
            >
              <h3 className="font-bold">
                {line.productName}
                {line.variantName ? ` – ${line.variantName}` : ""}
              </h3>
              <p>Kód: {line.sku}</p>
              <dl className="mt-4 grid gap-2">
                <div className="flex justify-between">
                  <dt>Množství</dt>
                  <dd>{line.quantity}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Cena za kus</dt>
                  <dd>{formatPrice(line.unitPriceMinor)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Celkem</dt>
                  <dd>{formatPrice(Math.round(line.unitPriceMinor * line.quantity))}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
