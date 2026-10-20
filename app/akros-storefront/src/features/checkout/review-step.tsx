"use client";
import { useDataSource } from "@/ontos/catalog-provider";
import { demoCheckoutNotice, demoPayment } from "@/ontos/demo-checkout";
import { useState } from "react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@techsio/ui-kit/atoms/button";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { Link } from "@techsio/ui-kit/atoms/link";
import { FormCheckbox } from "@techsio/ui-kit/molecules/form-checkbox";
import { useCart } from "@/features/cart/cart-provider";
import { useCheckout } from "./checkout-provider";
import { CartItemsTable } from "./cart-items-table";
import { AddressText } from "./address-fields";
import {
  getCheckoutTotals,
  getDelivery,
  getDeliveryAddress,
  getDeliveryLocation,
  getPayment,
} from "@/mock-storefront/checkout";
import { formatPrice } from "@/lib/format";

export function ReviewStep() {
  const ontos = useDataSource() === "ontos";
  const { cart } = useCart();
  const { draft, updateDraft, completeOrder, submitted, storageError } = useCheckout();
  const router = useRouter();
  const [sending, setSending] = useState(false);
  const totals = getCheckoutTotals(cart, draft, ontos);
  return (
    <form
      data-akros-checkout-review
      onSubmit={async (event) => {
        event.preventDefault();
        if (sending) return;
        setSending(true);
        try {
          if (await completeOrder()) router.push("/potvrzeni-objednavky");
        } finally {
          setSending(false);
        }
      }}
    >
      <section className="rounded-sm bg-(--color-base) p-4 md:p-6" aria-labelledby="review-title">
        <h1
          id="review-title"
          className="mb-4 text-(length:--akros-checkout-heading-size) leading-(--akros-checkout-heading-leading) font-medium"
        >
          Shrnutí objednávky
        </h1>
        <CartItemsTable showHeader />
        <dl className="divide-y divide-(--color-border-primary) border-b border-(--color-border-primary) text-sm">
          <div className="flex justify-between gap-4 py-4">
            <dt className="grid gap-2">
              <span>Způsob dopravy – {getDelivery(draft)?.title}</span>
              <span>{getDeliveryLocation(draft)}</span>
              <Link as={NextLink} href="/kosik/doprava-platba" className="w-fit">
                Změnit dopravu
              </Link>
            </dt>
            <dd className="whitespace-nowrap">
              {totals.shipping === 0 ? "Zdarma" : formatPrice(totals.shipping ?? 0)}
            </dd>
          </div>
          <div className="flex justify-between gap-4 py-4">
            <dt>Způsob platby – {ontos ? demoPayment.title : getPayment(draft)?.title}</dt>
            <dd>{totals.payment === 0 ? "Zdarma" : formatPrice(totals.payment)}</dd>
          </div>
          <div className="flex justify-between gap-4 py-4">
            <dt>Cena bez DPH</dt>
            <dd>
              {totals.net === null ? "Není dostupná pro starší položky" : formatPrice(totals.net)}
            </dd>
          </div>
          {totals.extendedReturn > 0 && (
            <div className="flex justify-between gap-4 py-4">
              <dt>Prodloužená doba vrácení</dt>
              <dd>{formatPrice(totals.extendedReturn)}</dd>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-4 py-4">
            <dt>Celková cena s DPH</dt>
            <dd
              className="text-(length:--akros-checkout-body-size) font-extrabold"
              aria-live="polite"
            >
              {formatPrice(totals.total)}
            </dd>
          </div>
        </dl>
        <div className="grid gap-6 py-6 sm:grid-cols-2">
          <section aria-labelledby="billing-review-title">
            <h2
              id="billing-review-title"
              className="mb-4 text-(length:--akros-checkout-heading-size) leading-(--akros-checkout-heading-leading) font-medium"
            >
              Fakturační údaje
            </h2>
            <AddressText address={draft.billing} />
            <div className="text-sm leading-(--akros-checkout-body-leading)">
              <p>{draft.email}</p>
              <p>{draft.company}</p>
              {draft.companyId && <p>IČ: {draft.companyId}</p>}
              {draft.vatId && <p>DIČ: {draft.vatId}</p>}
            </div>
          </section>
          <section aria-labelledby="delivery-review-title">
            <h2
              id="delivery-review-title"
              className="mb-4 text-(length:--akros-checkout-heading-size) leading-(--akros-checkout-heading-leading) font-medium"
            >
              Dodací údaje
            </h2>
            <AddressText address={getDeliveryAddress(draft)} />
            <p className="text-sm">{draft.email}</p>
          </section>
        </div>
        {!ontos && (
          <FormCheckbox
            label="Mám zájem o zasílání e-mailových akcí, novinek a tipů"
            size="sm"
            checked={draft.newsletter}
            onCheckedChange={(newsletter) => updateDraft((current) => ({ ...current, newsletter }))}
          />
        )}
      </section>
      <div className="mt-6 flex flex-wrap items-start justify-between gap-4">
        <LinkButton
          as={NextLink}
          href="/kosik/dodaci-udaje"
          data-akros-checkout-action
          className="leading-(--akros-checkout-heading-leading)"
          variant="secondary"
          size="sm"
          uppercase
        >
          Zpět k dodacím údajům
        </LinkButton>
        <div className="grid max-w-sm gap-3">
          {storageError && (
            <p
              role="alert"
              className="rounded-sm border border-(--color-danger) p-4 text-sm text-(--color-danger)"
            >
              {storageError}
            </p>
          )}
          {ontos && (
            <p
              role="note"
              className="rounded-sm border border-(--color-border-primary) bg-(--color-base) p-4 text-sm font-bold"
            >
              {demoCheckoutNotice}
            </p>
          )}
          <Button
            type="submit"
            data-akros-checkout-action
            className="leading-(--akros-checkout-heading-leading)"
            variant="primary"
            size="sm"
            uppercase
            disabled={sending || submitted || !cart.lines.length}
          >
            {sending
              ? "Odesílám do OntOS…"
              : ontos
                ? "Potvrdit DEMO objednávku"
                : "Objednat s povinností platby"}
          </Button>
          {!ontos && (
            <p className="text-center text-xs leading-(--akros-checkout-body-leading)">
              Kliknutím na tlačítko Objednat s povinností platby souhlasíte s{" "}
              <Link as={NextLink} href="/obchodni-podminky">
                obchodními podmínkami
              </Link>{" "}
              a{" "}
              <Link as={NextLink} href="/gdpr">
                zpracováním osobních údajů
              </Link>
              .
            </p>
          )}
          <p className="text-center text-xs text-(--color-fg-secondary)">
            {ontos
              ? "DEMO – objednávka se uloží v OntOS, nebude doručena. Platba ani e-mail se neodesílají."
              : "Lokální ukázka: objednávka, platba ani e-mail se nikam neodesílají."}
          </p>
        </div>
      </div>
    </form>
  );
}
