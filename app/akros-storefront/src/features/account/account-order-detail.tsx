"use client";

import NextLink from "next/link";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { formatPrice } from "@/lib/format";
import { formatQuantity } from "@/mock-storefront/cart";
import { Table } from "@techsio/ui-kit/organisms/table";
import { AccountHeading, AccountPanel } from "./account-content";
import { type DemoOrder } from "@/mock-storefront/fixtures/account";
import { ReorderAction } from "./reorder-action";

export function AccountOrderDetail({ order }: { order: DemoOrder }) {
  const hasTracking = order.status === "Odesláno";
  return (
    <>
      <AccountHeading
        title={`Objednávka ${order.number}`}
        description={`Vytvořeno ${order.date} · ${order.status}`}
      >
        <ReorderAction orderNumber={order.number} />
        <LinkButton
          as={NextLink}
          href="/historie-objednavek"
          data-account-action
          size="sm"
          theme="outlined"
          variant="secondary"
        >
          Zpět na objednávky
        </LinkButton>
        {hasTracking && (
          <LinkButton
            as={NextLink}
            href="/sledovani-zasilky"
            data-account-action
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            Sledovat zásilku
          </LinkButton>
        )}
      </AccountHeading>

      <div className="mb-(--dimension-32) grid gap-(--dimension-24) md:grid-cols-2">
        <AccountPanel title="Fakturační údaje">
          <p>
            {order.billingAddress.name}
            <br />
            {order.billingAddress.company}
            <br />
            {order.billingAddress.street}, {order.billingAddress.city},{" "}
            {order.billingAddress.postalCode}
            <br />
            Česká republika
          </p>
        </AccountPanel>
        <AccountPanel title="Přehled objednávky">
          <dl className="grid gap-(--dimension-16)">
            <div className="flex flex-wrap justify-between gap-(--dimension-16)">
              <dt>Stav</dt>
              <dd className="font-bold">{order.status}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-(--dimension-16)">
              <dt>Počet položek</dt>
              <dd className="tabular-nums">{order.items}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-(--dimension-16)">
              <dt>Celkem s DPH</dt>
              <dd className="font-bold tabular-nums">{order.total}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-(--dimension-16)">
              <dt>Zboží</dt>
              <dd className="tabular-nums">{formatPrice(order.subtotalMinor)}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-(--dimension-16)">
              <dt>Doprava {order.shippingTitle}</dt>
              <dd className="tabular-nums">{formatPrice(order.shippingMinor)}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-(--dimension-16)">
              <dt>Platba</dt>
              <dd>{order.paymentTitle}</dd>
            </div>
          </dl>
        </AccountPanel>
      </div>
      <section aria-labelledby="account-order-lines">
        <h2
          id="account-order-lines"
          className="mb-(--dimension-24) text-(length:--akros-account-section-size) font-bold leading-(--akros-account-heading-leading)"
        >
          Objednané položky
        </h2>

        <>
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
                  <Table.Row key={line.sku}>
                    <Table.Cell>
                      <p>{line.name}</p>
                      <p className="text-(length:--dimension-16) text-(--akros-account-muted)">
                        Kód: {line.sku}
                      </p>
                    </Table.Cell>
                    <Table.Cell numeric className="whitespace-nowrap tabular-nums">
                      {formatQuantity(line.quantity)} {line.unit}
                    </Table.Cell>
                    <Table.Cell numeric className="whitespace-nowrap tabular-nums">
                      {formatPrice(line.priceMinor)}
                    </Table.Cell>
                    <Table.Cell numeric className="whitespace-nowrap font-bold tabular-nums">
                      {formatPrice(Math.round(line.quantity * line.priceMinor))}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
          <ul className="grid gap-(--dimension-24) xl:hidden">
            {order.lines.map((line) => (
              <li
                key={line.sku}
                className="min-w-0 wrap-anywhere rounded-(--dimension-8) bg-(--akros-account-surface) p-(--dimension-24) max-sm:p-(--dimension-16)"
              >
                <h3 className="font-bold">{line.name}</h3>
                <p className="mt-(--dimension-8) text-(length:--dimension-16) text-(--akros-account-muted)">
                  Kód: {line.sku}
                </p>
                <dl className="mt-(--dimension-24) grid gap-(--dimension-8)">
                  <div className="flex flex-wrap justify-between gap-(--dimension-8)">
                    <dt>Množství</dt>
                    <dd>
                      {formatQuantity(line.quantity)} {line.unit}
                    </dd>
                  </div>
                  <div className="flex flex-wrap justify-between gap-(--dimension-8)">
                    <dt>Cena za kus</dt>
                    <dd>{formatPrice(line.priceMinor)}</dd>
                  </div>
                  <div className="flex flex-wrap justify-between gap-(--dimension-8)">
                    <dt>Celkem</dt>
                    <dd className="font-bold">
                      {formatPrice(Math.round(line.quantity * line.priceMinor))}
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        </>
      </section>
    </>
  );
}
