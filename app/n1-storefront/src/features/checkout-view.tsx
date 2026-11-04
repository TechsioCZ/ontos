"use client";

import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@techsio/ui-kit/atoms/badge";
import { Button } from "@techsio/ui-kit/atoms/button";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import type { Dictionary } from "@/i18n";
import type { CheckoutOptions } from "@/ontos/checkout-server";
import { CheckoutFields } from "./checkout-fields";
import { CheckoutItems, CheckoutShipping, CheckoutTotals } from "./checkout-panels";
import { EmptyCartView } from "./empty-cart-view";
import { useCheckout } from "./use-checkout";

const dateFormatters = {
  cs: new Intl.DateTimeFormat("cs", { dateStyle: "long", timeStyle: "short" }),
  en: new Intl.DateTimeFormat("en", { dateStyle: "long", timeStyle: "short" }),
};
const receiptDate = (value: string | null | undefined, locale: string) => {
  const milliseconds = value === null || value === undefined ? Number.NaN : Date.parse(value);
  return Number.isFinite(milliseconds)
    ? dateFormatters[locale === "en" ? "en" : "cs"].format(milliseconds)
    : null;
};
type ReadyOptions = Extract<CheckoutOptions, { state: "ready" }>;
type Checkout = ReturnType<typeof useCheckout>;
const noticeText = (checkout: Checkout, d: Dictionary) => {
  if (checkout.notice === "cart-preserved") {
    return d.checkout.cartPreserved;
  }
  if (checkout.notice === "scope-mismatch") {
    return d.checkout.scopeMismatch;
  }
  if (checkout.notice !== null) {
    return d.checkout[checkout.notice];
  }
  if (checkout.progress === "place") {
    return d.checkout.sending;
  }
  if (checkout.progress !== "idle") {
    return d.checkout.checking;
  }
  if (checkout.guarded) {
    return d.checkout.uncertain;
  }
  return checkout.quote?.outcome === "VALID" ? d.checkout.verified : "";
};

const ReceiptHeader = ({
  checkout,
  dictionary: d,
  locale,
  result,
}: {
  checkout: Checkout;
  dictionary: Dictionary;
  locale: string;
  result: NonNullable<Checkout["receipt"]>;
}) => {
  const { receipt } = result;
  const date = receiptDate(receipt?.createdAt, locale);
  return (
    <section className="flex flex-col gap-3 rounded-xs border border-border-secondary p-4">
      <div className="flex flex-col items-start gap-2 sm:flex-row sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-xl font-bold">
            {d.checkout.orderNumber}: {result.orderNumber}
          </h2>
          {date !== null && <p className="text-sm text-fg-secondary">{date}</p>}
        </div>
        {result.status !== null && (
          <Badge size="md" variant={result.status === "CANCELLED" ? "danger" : "info"}>
            {d.checkout.statuses[result.status]}
          </Badge>
        )}
      </div>
      {receipt?.contact !== null && receipt?.contact !== undefined && (
        <p className="text-sm text-fg-secondary">
          {d.checkout.email}: {receipt.contact.email}
        </p>
      )}
      {(receipt === null || receipt === undefined) && (
        <div>
          <Button
            disabled={checkout.progress !== "idle"}
            isLoading={checkout.progress === "recovery"}
            loadingText={d.checkout.checking}
            onClick={() => checkout.recover()}
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            {d.checkout.loadReceipt}
          </Button>
        </div>
      )}
    </section>
  );
};
const checkoutNeedsBackLink = (checkout: Checkout) =>
  checkout.cart === null ||
  checkout.cart.entries.length === 0 ||
  checkout.guarded ||
  checkout.notice === "storage";

const ConfirmedCheckout = ({
  checkout,
  dictionary: d,
  locale,
  options,
}: {
  checkout: Checkout;
  dictionary: Dictionary;
  locale: string;
  options: ReadyOptions;
}) => {
  const router = useRouter();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const result = checkout.receipt;
  if (result === null) {
    return null;
  }
  const { receipt } = result;
  const shipping = options.shippingMethods.find((method) => method.id === receipt?.shippingMethod);
  const home = `/${locale}`;
  return (
    <article className="mx-auto flex w-full max-w-n1-product-content flex-col items-center gap-5 p-5">
      <div
        aria-live="polite"
        className="w-full rounded-xs border border-border-success bg-bg-success p-4"
      >
        <h1 className="text-lg font-semibold" ref={heading} tabIndex={-1}>
          {d.checkout.confirmed}
        </h1>
        <p className="text-sm text-fg-secondary">{d.checkout.paymentNote}</p>
      </div>
      <div className="flex w-full max-w-3xl flex-col gap-5">
        <ReceiptHeader checkout={checkout} dictionary={d} locale={locale} result={result} />
        <section className="flex flex-col gap-4 rounded-xs border border-border-secondary p-4">
          <h2 className="text-lg font-semibold">{d.checkout.summary}</h2>
          <CheckoutItems
            currency={result.scope.currency}
            dictionary={d}
            entries={checkout.receiptEntries}
            imageHosts={checkout.cart?.imageHosts ?? []}
            locale={locale}
            result={result}
          />
        </section>
        {receipt?.deliveryAddress !== null && receipt?.deliveryAddress !== undefined && (
          <section className="flex flex-col gap-4 rounded-xs border border-border-secondary p-4">
            <h2 className="text-lg font-semibold">{d.checkout.address}</h2>
            <div className="text-sm text-fg-secondary">
              {receipt.contact !== null && <p>{receipt.contact.name}</p>}
              <p>{receipt.deliveryAddress.street}</p>
              <p>
                {receipt.deliveryAddress.city}, {receipt.deliveryAddress.postalCode}
              </p>
              <p>{receipt.deliveryAddress.country}</p>
            </div>
          </section>
        )}
        {shipping !== undefined && (
          <section className="flex flex-col gap-4 rounded-xs border border-border-secondary p-4">
            <h2 className="text-lg font-semibold">{d.checkout.shipping}</h2>
            <p className="text-sm text-fg-secondary">{shipping.title}</p>
          </section>
        )}
        <section className="flex flex-col gap-4 rounded-xs border border-border-secondary p-4">
          <h2 className="text-lg font-semibold">{d.checkout.total}</h2>
          <CheckoutTotals
            actions={
              <LinkButton
                as={NextLink}
                block
                href={home}
                onClick={(event) => {
                  event.preventDefault();
                  checkout.dismiss(() => router.push(home));
                }}
                size="md"
                theme="solid"
                variant="secondary"
              >
                {d.shopping.backHome}
              </LinkButton>
            }
            currency={result.scope.currency}
            dictionary={d}
            locale={locale}
            result={result}
          />
        </section>
        {checkout.notice !== null && <p role="alert">{noticeText(checkout, d)}</p>}
      </div>
    </article>
  );
};

const CheckoutActions = ({
  checkout,
  dictionary: d,
  disabled,
  locale,
}: {
  checkout: Checkout;
  dictionary: Dictionary;
  disabled: boolean;
  locale: string;
}) => {
  const pending = checkout.progress !== "idle";
  return (
    <div className="grid grid-cols-2 gap-2">
      <LinkButton
        as={NextLink}
        block
        disabled={pending}
        href={`/${locale}/kosik`}
        size="md"
        theme="solid"
        variant="secondary"
      >
        {d.checkout.back}
      </LinkButton>
      <Button
        block
        disabled={disabled || pending}
        isLoading={pending}
        loadingText={checkout.progress === "place" ? d.checkout.sending : d.checkout.checking}
        size="md"
        theme="solid"
        type="submit"
        variant="primary"
      >
        {checkout.quote?.outcome === "VALID" ? d.checkout.confirm : d.checkout.verify}
      </Button>
    </div>
  );
};

const ReadyCheckout = ({
  dictionary: d,
  locale,
  options,
}: {
  dictionary: Dictionary;
  locale: string;
  options: ReadyOptions;
}) => {
  const checkout = useCheckout(options, locale);
  const [shippingId, setShippingId] = useState<string | null>(
    options.shippingMethods[0]?.id ?? null,
  );
  const method = options.shippingMethods.find((item) => item.id === shippingId);
  const pending = checkout.progress !== "idle";
  if (checkout.receipt !== null) {
    return (
      <ConfirmedCheckout checkout={checkout} dictionary={d} locale={locale} options={options} />
    );
  }
  let body;
  if (!checkout.guardLoaded || checkout.cart?.loaded !== true) {
    body = <output>{d.shopping.loading}</output>;
  } else if (checkout.guarded) {
    body = (
      <div className="flex flex-col items-start gap-4">
        <output>{noticeText(checkout, d)}</output>
        <Button
          disabled={pending}
          isLoading={pending}
          loadingText={d.checkout.checking}
          onClick={() => checkout.recover()}
          size="md"
          theme="solid"
          variant="secondary"
        >
          {d.checkout.checkResult}
        </Button>
      </div>
    );
  } else if (checkout.cart.error || checkout.notice === "storage") {
    body = <p role="alert">{d.checkout.storage}</p>;
  } else if (checkout.cart.scope === null) {
    body = <p role="alert">{d.checkout.scopeMismatch}</p>;
  } else if (checkout.cart.entries.length === 0) {
    return <EmptyCartView dictionary={d} locale={locale} />;
  } else {
    body = (
      <form
        action="/api/checkout"
        method="post"
        onSubmit={(event) => {
          event.preventDefault();
          checkout.submit(new FormData(event.currentTarget), method);
        }}
      >
        <noscript>
          <p>{d.auth.javascriptRequired}</p>
        </noscript>
        <div className="grid min-w-0 items-start gap-8 md:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-5">
            <CheckoutFields
              countryCodes={options.countryCodes}
              dictionary={d}
              disabled={pending}
              locale={locale}
              onEdit={checkout.handleEdit}
            />
            <CheckoutShipping
              dictionary={d}
              disabled={pending}
              locale={locale}
              onChange={(value) => {
                setShippingId(value);
                checkout.handleEdit();
              }}
              options={options}
              value={shippingId}
            />
            <section className="flex flex-col gap-4 rounded-xs border border-border-secondary bg-fill-surface p-4">
              <h2 className="text-lg font-semibold">{d.payment}</h2>
              <p className="text-sm text-fg-secondary">{d.checkout.paymentNote}</p>
            </section>
            {options.countryCodes.length === 0 && <p role="alert">{d.checkout.noCountries}</p>}
          </div>
          <section className="flex min-w-0 flex-col gap-4 rounded-xs border border-border-secondary bg-fill-surface p-4">
            <h2 className="text-lg font-semibold">{d.checkout.summary}</h2>
            <CheckoutItems
              currency={options.scope.currency}
              dictionary={d}
              entries={checkout.cart.entries}
              imageHosts={checkout.cart.imageHosts}
              locale={locale}
              result={checkout.quote}
            />
            <hr className="border-0 border-t border-border-secondary" />
            <CheckoutTotals
              actions={
                <CheckoutActions
                  checkout={checkout}
                  dictionary={d}
                  disabled={options.countryCodes.length === 0 || method === undefined}
                  locale={locale}
                />
              }
              currency={options.scope.currency}
              dictionary={d}
              locale={locale}
              result={checkout.quote}
            />
            <output aria-live="polite">{noticeText(checkout, d)}</output>
            {checkout.quote?.outcome === "REJECTED" && <p role="alert">{d.checkout.rejected}</p>}
          </section>
        </div>
      </form>
    );
  }
  return (
    <article className="mx-auto w-full max-w-n1-product-content p-5">
      <h1 className="mb-5 text-2xl leading-normal font-bold">{d.checkout.heading}</h1>
      {body}
      {checkoutNeedsBackLink(checkout) && (
        <div className="mt-5">
          <LinkButton
            as={NextLink}
            href={`/${locale}/kosik`}
            size="md"
            theme="outlined"
            variant="secondary"
          >
            {d.cart}
          </LinkButton>
        </div>
      )}
    </article>
  );
};

export const CheckoutView = ({
  dictionary: d,
  locale,
  options,
}: {
  dictionary: Dictionary;
  locale: string;
  options: CheckoutOptions;
}) => {
  const router = useRouter();
  if (options.state === "ready") {
    return <ReadyCheckout dictionary={d} locale={locale} options={options} />;
  }
  return (
    <article className="mx-auto flex max-w-n1-product-content flex-col items-start gap-5 p-5">
      <h1 className="text-2xl leading-normal font-bold">{d.checkout.heading}</h1>
      <output>{d.checkout.unavailable}</output>
      <Button onClick={() => router.refresh()} size="md" theme="outlined" variant="secondary">
        {d.contact.retry}
      </Button>
      <LinkButton
        as={NextLink}
        href={`/${locale}/kosik`}
        size="md"
        theme="solid"
        variant="secondary"
      >
        {d.checkout.back}
      </LinkButton>
    </article>
  );
};
