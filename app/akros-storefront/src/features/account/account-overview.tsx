"use client";

import StoreLink from "@/components/store-link";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { AccountHeading, AccountPanel } from "./account-content";
import { mockCustomer, mockOrders } from "@/mock-storefront/fixtures/account";
import { parseAccountProfile } from "@/mock-storefront/account-profile";
import { useAccountProfileSnapshot } from "./use-account-profile";

const shortcuts = [
  {
    title: "Objednávky",
    text: "Historie nákupů a detaily objednávek.",
    href: "/historie-objednavek",
    action: "Zobrazit objednávky",
  },
  {
    title: "Oblíbené produkty",
    text: "Rychlý přístup k často nakupovanému zboží.",
    href: "/oblibene",
    action: "Otevřít produkty",
  },
  {
    title: "Kontaktní údaje",
    text: "Email, telefon a nastavení odběru novinek.",
    href: "/muj-ucet#kontaktni-udaje",
    action: "Upravit kontakt",
  },
  {
    title: "Fakturační údaje",
    text: "Fakturační a doručovací adresa, údaje firmy.",
    href: "/muj-ucet#fakturacni-udaje",
    action: "Upravit údaje",
  },
];

export function AccountOverview() {
  const stored = useAccountProfileSnapshot();
  const profile = parseAccountProfile(stored ?? null);
  const latest = mockOrders[0];
  return (
    <>
      <AccountHeading
        title={`Dobrý den, ${profile.firstName} ${profile.lastName}`}
        description={`Zákazník č. ${mockCustomer.customerNumber}. Objednávky a nastavení máte na jednom místě.`}
      />
      <div className="grid gap-(--dimension-24) lg:grid-cols-2">
        <AccountPanel title="Poslední objednávka">
          <div className="flex flex-wrap items-start justify-between gap-(--dimension-16)">
            <div>
              <p className="font-bold">{latest.number}</p>
              <p className="mt-(--dimension-8) text-(--akros-account-muted)">{latest.date}</p>
            </div>
            <p className="font-bold text-(--color-fg-status-success)">{latest.status}</p>
          </div>
          <dl className="mt-(--dimension-24) grid grid-cols-2 gap-(--dimension-16)">
            <div>
              <dt className="text-(length:--dimension-16) text-(--akros-account-muted)">
                Počet položek
              </dt>
              <dd className="mt-(--dimension-8) font-bold tabular-nums">{latest.items}</dd>
            </div>
            <div>
              <dt className="text-(length:--dimension-16) text-(--akros-account-muted)">
                Celková cena
              </dt>
              <dd className="mt-(--dimension-8) font-bold tabular-nums">{latest.total}</dd>
            </div>
          </dl>
          <div className="mt-(--dimension-32) flex flex-wrap gap-(--dimension-16)">
            <LinkButton
              as={StoreLink}
              href="/sledovani-zasilky"
              data-account-action
              size="sm"
              variant="primary"
            >
              Sledovat zásilku
            </LinkButton>
            <LinkButton
              as={StoreLink}
              href="/detail-objednavky"
              data-account-action
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              Detail objednávky
            </LinkButton>
          </div>
        </AccountPanel>
        <AccountPanel title="Váš účet">
          <dl className="grid gap-(--dimension-16)">
            <div>
              <dt className="text-(length:--dimension-16) text-(--akros-account-muted)">
                Kontaktní email
              </dt>
              <dd className="break-words">{profile.email}</dd>
            </div>
            <div>
              <dt className="text-(length:--dimension-16) text-(--akros-account-muted)">
                Fakturační adresa
              </dt>
              <dd>
                {profile.company}
                <br />
                {profile.street}, {profile.city}, {profile.postalCode}
              </dd>
            </div>
          </dl>
          <LinkButton
            as={StoreLink}
            href="/muj-ucet"
            data-account-action
            className="mt-(--dimension-32)"
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            Upravit můj účet
          </LinkButton>
        </AccountPanel>
      </div>
      <div className="mt-(--dimension-32) grid gap-(--dimension-24) md:grid-cols-2 xl:grid-cols-4">
        {shortcuts.map((item) => (
          <AccountPanel key={item.href} title={item.title}>
            <p className="text-(--akros-account-muted)">{item.text}</p>
            <LinkButton
              as={StoreLink}
              href={item.href}
              size="sm"
              theme="unstyled"
              className="mt-(--dimension-16) justify-start p-0 underline underline-offset-4 hover:no-underline"
            >
              {item.action}
            </LinkButton>
          </AccountPanel>
        ))}
      </div>
    </>
  );
}
