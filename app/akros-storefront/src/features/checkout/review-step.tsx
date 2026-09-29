"use client";
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
  const { cart } = useCart();
  const { draft, updateDraft, completeOrder, submitted } = useCheckout();
  const router = useRouter();
  const totals = getCheckoutTotals(cart, draft);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (completeOrder()) router.push("/potvrzeni-objednavky");
      }}
    >
      <section className="rounded-sm bg-(--color-base) p-4 md:p-6" aria-labelledby="review-title">
        <h1 id="review-title" className="mb-4 text-md font-medium">
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
            <dt>Způsob platby – {getPayment(draft)?.title}</dt>
            <dd>{totals.payment === 0 ? "Zdarma" : formatPrice(totals.payment)}</dd>
          </div>
          <div className="flex justify-between gap-4 py-4">
            <dt>Cena bez DPH</dt>
            <dd>
              {totals.net === null ? "Není dostupná pro starší položky" : formatPrice(totals.net)}
            </dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-4 py-4">
            <dt>Celková cena s DPH</dt>
            <dd className="text-lg font-extrabold" aria-live="polite">
              {formatPrice(totals.total)}
            </dd>
          </div>
        </dl>
        <div className="grid gap-6 py-6 sm:grid-cols-2">
          <section aria-labelledby="billing-review-title">
            <h2 id="billing-review-title" className="mb-4 text-md font-medium">
              Fakturační údaje
            </h2>
            <AddressText address={draft.billing} />
            <div className="text-sm leading-relaxed">
              <p>{draft.email}</p>
              <p>{draft.company}</p>
              {draft.companyId && <p>IČ: {draft.companyId}</p>}
              {draft.vatId && <p>DIČ: {draft.vatId}</p>}
            </div>
          </section>
          <section aria-labelledby="delivery-review-title">
            <h2 id="delivery-review-title" className="mb-4 text-md font-medium">
              Dodací údaje
            </h2>
            <AddressText address={getDeliveryAddress(draft)} />
            <p className="text-sm">{draft.email}</p>
          </section>
        </div>
        <FormCheckbox
          label="Mám zájem o zasílání e-mailových akcí, novinek a tipů"
          size="sm"
          checked={draft.newsletter}
          onCheckedChange={(newsletter) => updateDraft((current) => ({ ...current, newsletter }))}
        />
      </section>
      <div className="mt-6 flex flex-wrap items-start justify-between gap-4">
        <LinkButton
          as={NextLink}
          href="/kosik/dodaci-udaje"
          variant="secondary"
          size="sm"
          uppercase
        >
          Zpět k dodacím údajům
        </LinkButton>
        <div className="grid max-w-sm gap-3">
          <Button
            type="submit"
            variant="primary"
            size="sm"
            uppercase
            disabled={submitted || !cart.lines.length}
          >
            Objednat s povinností platby
          </Button>
          <p className="text-center text-xs leading-relaxed">
            Kliknutím na tlačítko souhlasíte s{" "}
            <Link as={NextLink} href="/obchodni-podminky">
              obchodními podmínkami
            </Link>{" "}
            a{" "}
            <Link as={NextLink} href="/gdpr">
              zpracováním osobních údajů
            </Link>
            .
          </p>
          <p className="text-center text-xs text-(--color-fg-secondary)">
            Lokální ukázka: objednávka, platba ani e-mail se nikam neodesílají.
          </p>
        </div>
      </div>
    </form>
  );
}
